/**
 * Copying one source table into one YENES table.
 *
 * Every write is an upsert on the table's conflict key, so re-running is safe:
 * a page that fails is simply re-read next run rather than being skipped, and
 * a page that succeeds twice lands the same rows.
 */
import type { Pool } from "pg";
import type { ReadConnection } from "./db.js";
import { pgq } from "./db.js";
import { META_COLUMNS, type SourceSpec, type TableSpec } from "./types.js";
import { readCursor, writeCursor, markRun, type Cursor } from "./state.js";

const DEFAULT_PAGE = 1000;

/** Postgres caps a statement at 65535 bind parameters. Stay clear of it. */
const MAX_BIND_PARAMS = 60000;

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface CopyResult {
  target: string;
  copied: number;
  /** Set when the table was not synced at all; the string is the reason. */
  skipped?: string;
  /** True when we reached the end of the source within this run. */
  exhausted: boolean;
}

/** MySQL allows '0000-00-00' datetimes; Postgres rejects them. */
function clean(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("0000-00-00")) return null;
  return value;
}

/** Cursor values are stored as text so one column can hold ints, uuids and timestamps. */
function cursorToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function copyTable(args: {
  pg: Pool;
  read: ReadConnection;
  source: SourceSpec;
  spec: TableSpec;
  deadline: number;
  log: Logger;
}): Promise<CopyResult> {
  const { pg, read, source, spec, deadline, log } = args;
  const { target } = spec;

  const identity = spec.identity ?? "id";
  const cursor = spec.cursor ?? { column: identity, type: "numeric" as const };
  const tiebreak = cursor.tiebreak ?? identity;
  const pageSize = spec.pageSize ?? DEFAULT_PAGE;
  const conflictKey = spec.conflictKey ?? ["id"];
  const label = `${source.key}:${spec.source} -> ${target}`;

  const skip = (reason: string): CopyResult => {
    log.warn(`Skipping ${label}: ${reason}`);
    return { target, copied: 0, skipped: reason, exhausted: false };
  };

  /* ---------- what exists on each side ---------- */
  const { rows: destColRows } = await pg.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [target]
  );
  const targetCols = new Set(destColRows.map((c) => c.column_name));
  if (targetCols.size === 0) {
    return skip(`table "${target}" does not exist in YENES yet. Create it and it syncs on the next run.`);
  }

  let sourceCols: Set<string>;
  try {
    sourceCols = new Set(await read.columnsOf(spec.source, spec.sourceSchema));
  } catch (error) {
    return skip(`could not read the schema of "${spec.source}" on ${source.label}: ${String(error)}`);
  }
  if (sourceCols.size === 0) {
    // Don't just say "not found" — if it exists somewhere off the search path,
    // say where, because the fix is one line of config.
    const elsewhere = await read.locateTable(spec.source).catch(() => [] as string[]);
    if (spec.sourceSchema) {
      return skip(
        `table "${spec.sourceSchema}"."${spec.source}" was not found on ${source.label}` +
          (elsewhere.length ? `, but a table of that name exists in: ${elsewhere.join(", ")}.` : ".")
      );
    }
    if (elsewhere.length > 0) {
      return skip(
        `table "${spec.source}" exists on ${source.label} but not on the connection's search path — ` +
          `it's in schema ${elsewhere.map((s) => `"${s}"`).join(", ")}. ` +
          `Add sourceSchema: "${elsewhere[0]}" to this table in sources.ts.`
      );
    }
    return skip(`table "${spec.source}" was not found on ${source.label}.`);
  }

  /* ---------- column mapping ---------- */
  const mapping: { src: string; tgt: string }[] = [];

  if (spec.columns) {
    for (const [src, tgt] of Object.entries(spec.columns)) {
      if (!sourceCols.has(src)) {
        log.warn(`${label}: source column "${src}" does not exist on ${source.label}; ignoring it.`);
        continue;
      }
      if (!targetCols.has(tgt)) {
        log.warn(`${label}: target column "${tgt}" does not exist on "${target}"; ignoring it.`);
        continue;
      }
      mapping.push({ src, tgt });
    }
  } else {
    // No explicit map: copy the columns whose names already agree.
    for (const col of sourceCols) if (targetCols.has(col)) mapping.push({ src: col, tgt: col });
  }

  if (mapping.length === 0) {
    return skip(
      spec.columns
        ? `none of the mapped columns exist on both sides.`
        : `"${spec.source}" and "${target}" have no column names in common. Add a "columns" map (see MAPPING.md).`
    );
  }

  /* ---------- cursor / identity sanity ---------- */
  if (!sourceCols.has(cursor.column)) {
    return skip(`cursor column "${cursor.column}" does not exist on "${spec.source}".`);
  }
  if (cursor.type === "timestamp" && !sourceCols.has(tiebreak)) {
    return skip(`timestamp cursor needs tiebreak column "${tiebreak}", which does not exist on "${spec.source}".`);
  }

  const needsIdentity = targetCols.has(META_COLUMNS.sourceId) || cursor.type === "timestamp";
  if (needsIdentity && !sourceCols.has(identity)) {
    return skip(`identity column "${identity}" does not exist on "${spec.source}".`);
  }

  /* ---------- metadata columns (only the ones the target actually has) ---------- */
  const meta: { col: string; value: (row: Record<string, unknown>) => unknown }[] = [];
  if (targetCols.has(META_COLUMNS.source)) {
    meta.push({ col: META_COLUMNS.source, value: () => source.key });
  }
  if (targetCols.has(META_COLUMNS.sourceId)) {
    meta.push({ col: META_COLUMNS.sourceId, value: (row) => cursorToText(row[identity]) });
  }
  if (targetCols.has(META_COLUMNS.sourceTable)) {
    meta.push({ col: META_COLUMNS.sourceTable, value: () => spec.source });
  }
  if (targetCols.has(META_COLUMNS.syncedAt)) {
    meta.push({ col: META_COLUMNS.syncedAt, value: () => new Date() });
  }

  /* ---------- refuse to write rows that would be almost entirely NULL ----------
     If the only thing lining up is the key, the sync would happily insert rows
     with every real column empty and report success. That looks synced and
     isn't — far worse than skipping and saying why. */
  const payloadCols = mapping.filter((m) => m.tgt !== identity && !conflictKey.includes(m.tgt));
  if (payloadCols.length === 0) {
    const sample = [...sourceCols].slice(0, 8).join(", ");
    return skip(
      `only key column(s) line up between "${spec.source}" and "${target}" — every other column would be written as NULL. ` +
        `The target's column names almost certainly don't match the source's (source has: ${sample}${sourceCols.size > 8 ? ", …" : ""}). ` +
        `Add a "columns" map, or rename the target's columns to match.`
    );
  }

  /* ---------- conflict key must be writable, or the insert errors ---------- */
  const writableCols = new Set([...mapping.map((m) => m.tgt), ...meta.map((m) => m.col)]);
  const missingKey = conflictKey.filter((k) => !writableCols.has(k));
  if (missingKey.length > 0) {
    if (!spec.conflictKey && missingKey.includes("id")) {
      return skip(`"${target}" has no "id" column to match rows on. Set "conflictKey" for this table (see MAPPING.md).`);
    }
    return skip(
      `conflictKey ${JSON.stringify(conflictKey)} includes ${JSON.stringify(missingKey)}, ` +
        `which the sync never writes. Add it to "columns", or add the matching _source/_source_id column to "${target}".`
    );
  }

  /* ---------- read plan ---------- */
  const selectCols = [...new Set([...mapping.map((m) => m.src), cursor.column, tiebreak, identity])]
    .filter((c) => sourceCols.has(c))
    .map((c) => read.q(c))
    .join(", ");

  const insertCols = [...mapping.map((m) => m.tgt), ...meta.map((m) => m.col)];
  const updateCols = insertCols.filter((c) => !conflictKey.includes(c));
  const maxRowsPerStatement = Math.max(1, Math.floor(MAX_BIND_PARAMS / insertCols.length));

  const conflictSql = conflictKey.map(pgq).join(", ");
  const updateSql = updateCols.map((c) => `${pgq(c)} = excluded.${pgq(c)}`).join(", ");
  const insertHead = `insert into ${pgq(target)} (${insertCols.map(pgq).join(", ")}) values `;
  const insertTail = updateSql
    ? ` on conflict (${conflictSql}) do update set ${updateSql}`
    : ` on conflict (${conflictSql}) do nothing`;

  /* ---------- page through ---------- */
  let position = await readCursor(pg, source.key, target);
  let copied = 0;
  let exhausted = false;

  while (Date.now() < deadline) {
    const { sql, params } = buildPageQuery({ read, spec, cursor, tiebreak, selectCols, position, pageSize });

    const rows = await read.query<Record<string, unknown>>(sql, params);
    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    for (let i = 0; i < rows.length; i += maxRowsPerStatement) {
      const chunk = rows.slice(i, i + maxRowsPerStatement);
      const values: unknown[] = [];
      let p = 1;
      const tuples = chunk.map((row) => {
        const placeholders: string[] = [];
        for (const m of mapping) {
          values.push(clean(row[m.src]));
          placeholders.push(`$${p++}`);
        }
        for (const m of meta) {
          values.push(m.value(row));
          placeholders.push(`$${p++}`);
        }
        return `(${placeholders.join(", ")})`;
      });

      await pg.query(insertHead + tuples.join(", ") + insertTail, values);
    }

    const last = rows[rows.length - 1];
    const next: Cursor = {
      value: cursorToText(last[cursor.column]),
      key: cursorToText(last[identity]),
    };

    // Guard against a cursor that can't advance — it would spin forever.
    if (next.value === position.value && next.key === position.key) {
      log.warn(
        `${label}: cursor "${cursor.column}" did not advance past ${String(next.value)}. ` +
          `Stopping this table to avoid a loop — it likely needs a different cursor (see MAPPING.md).`
      );
      break;
    }

    position = next;

    // Saved only after the rows are committed, so a failed page is re-read
    // next run rather than silently skipped.
    await writeCursor(pg, source.key, target, position, rows.length);

    copied += rows.length;
    if (rows.length < pageSize) {
      exhausted = true;
      break;
    }
  }

  await markRun(pg, source.key, target);

  log.info(
    `${label}: ${copied} rows${exhausted ? " (up to date)" : " (more to do next run)"}` +
      `${position.value !== null ? ` [cursor ${cursor.column}=${position.value}]` : ""}`
  );

  return { target, copied, exhausted };
}

/** Keyset pagination, written in the source's dialect. */
function buildPageQuery(args: {
  read: ReadConnection;
  spec: TableSpec;
  cursor: { column: string; type: "numeric" | "text" | "timestamp" };
  tiebreak: string;
  selectCols: string;
  position: Cursor;
  pageSize: number;
}): { sql: string; params: unknown[] } {
  const { read, spec, cursor, tiebreak, selectCols, position, pageSize } = args;

  const col = read.q(cursor.column);
  const tie = read.q(tiebreak);
  const params: unknown[] = [];
  const conditions: string[] = [];

  const bind = (value: unknown) => {
    params.push(value);
    return read.ph(params.length);
  };

  if (position.value !== null) {
    const typed = cursor.type === "numeric" ? Number(position.value) : position.value;

    if (cursor.type === "timestamp") {
      if (position.key !== null) {
        // Exact keyset: never skips or repeats rows that share a timestamp.
        conditions.push(`(${col} > ${bind(typed)} or (${col} = ${bind(typed)} and ${tie} > ${bind(position.key)}))`);
      } else {
        // No tiebreak recorded yet: re-read the boundary instant. Upserts make
        // the overlap harmless, and the next page records a key.
        conditions.push(`${col} >= ${bind(typed)}`);
      }
    } else {
      conditions.push(`${col} > ${bind(typed)}`);
    }
  }

  if (spec.where) conditions.push(`(${spec.where})`);

  const where = conditions.length ? ` where ${conditions.join(" and ")}` : "";
  const orderBy = cursor.type === "timestamp" ? `${col} asc, ${tie} asc` : `${col} asc`;
  // Page size is a validated integer, inlined so the two drivers don't disagree
  // about how LIMIT placeholders are typed.
  const limit = Math.max(1, Math.floor(pageSize));

  const sql =
    `select ${selectCols} from ${read.qualified(spec.source, spec.sourceSchema)}${where} order by ${orderBy} limit ${limit}`;

  return { sql, params };
}
