/**
 * DOCTOR — read-only connection and mapping diagnostic.
 *
 *   cd sync && npm run doctor
 *
 * Answers "why did this sync 0 rows?" without writing anything, anywhere.
 * For every source in sources.ts and every table it declares, it reports the
 * exact precondition that fails, in the order copyTable() checks them.
 *
 * Reads credentials from sync/.env (or the real environment if already set).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connectSource, connectYenes, msg, pgq } from "../lib/db.js";
import { SOURCES } from "../sources.js";
import { META_COLUMNS } from "../lib/types.js";
import type { ReadConnection } from "../lib/db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------- load sync/.env without adding a dependency ---------- */
function loadEnv() {
  const file = path.join(HERE, "..", ".env");
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
  return true;
}

/** Never print a password, even by accident. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    const user = u.username || "(no user)";
    return `${u.protocol}//${user}:***@${u.hostname}:${u.port || "(default)"}${u.pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
}

const ok = (s: string) => `  ✓ ${s}`;
const bad = (s: string) => `  ✗ ${s}`;
const warn = (s: string) => `  ! ${s}`;

const hadEnvFile = loadEnv();
console.log("═".repeat(72));
console.log(" SYNC DOCTOR — read-only. Nothing is written.");
console.log("═".repeat(72));
console.log(hadEnvFile ? "\nLoaded sync/.env" : "\nNo sync/.env found — using the ambient environment only.");

let problems = 0;
const note = (n: number) => { problems += n; };

/* ---------------- destination ---------------- */
console.log("\n┌─ DESTINATION: YENES_DATABASE_URL");
if (!process.env.YENES_DATABASE_URL) {
  console.log(bad("YENES_DATABASE_URL is not set. Nothing can run without it."));
  note(1);
  process.exit(1);
}
console.log(`  ${redact(process.env.YENES_DATABASE_URL)}`);

let pg;
try {
  pg = await connectYenes(process.env.YENES_DATABASE_URL);
  console.log(ok("connected"));
} catch (error) {
  console.log(bad(msg(error)));
  process.exit(1);
}

const { rows: stateRows } = await pg.query<{ exists: boolean }>(
  `select count(*) > 0 as exists from information_schema.tables
    where table_schema='public' and table_name='sync_state'`
);
console.log(stateRows[0].exists ? ok("sync_state exists (the job has run before)")
                                : warn("sync_state does not exist yet — the job has never completed a run here"));

if (stateRows[0].exists) {
  const { rows } = await pg.query<{ source_key: string; target_table: string; cursor_value: string | null; rows_synced: string; last_run_at: string | null }>(
    `select source_key, target_table, cursor_value, rows_synced, last_run_at
       from sync_state order by source_key, target_table`
  );
  if (rows.length === 0) console.log(warn("sync_state is empty"));
  for (const r of rows) {
    console.log(`    ${r.source_key.padEnd(8)} ${r.target_table.padEnd(24)} cursor=${String(r.cursor_value).padEnd(38)} rows=${r.rows_synced} last_run=${r.last_run_at ?? "never"}`);
  }
}

/* ---------------- each source ---------------- */
for (const source of SOURCES) {
  console.log(`\n┌─ SOURCE: ${source.label}  [key="${source.key}", ${source.dialect}, required=${source.required}]`);

  const url = process.env[source.envVar];
  if (!url) {
    console.log(bad(`${source.envVar} is not set.`));
    console.log(`    → This is why "${source.key}" syncs 0 rows. required=${source.required} means the run ${source.required ? "FAILS" : "SKIPS IT SILENTLY"}.`);
    console.log(`    → Set it in Trigger.dev → Settings → Environment Variables → Production (and in sync/.env for local runs).`);
    note(1);
    continue;
  }
  console.log(`  ${redact(url)}`);

  let read: ReadConnection;
  try {
    read = await connectSource(url, source.dialect, source.label);
    console.log(ok("connected"));
  } catch (error) {
    console.log(bad(msg(error)));
    note(1);
    continue;
  }

  try {
    if (source.tables.length === 0) {
      console.log(warn("no tables declared in sources.ts — connected but nothing to do"));
      continue;
    }

    for (const spec of source.tables) {
      const identity = spec.identity ?? "id";
      const cursor = spec.cursor ?? { column: identity, type: "numeric" as const };
      const conflictKey = spec.conflictKey ?? ["id"];
      console.log(`\n  ── ${spec.source}  →  ${spec.target}`);

      /* target side */
      const { rows: tcols } = await pg.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name=$1 order by ordinal_position`,
        [spec.target]
      );
      const targetCols = new Set(tcols.map((c) => c.column_name));
      if (targetCols.size === 0) {
        console.log(bad(`target "${spec.target}" does not exist in YENES (public schema). Create it.`));
        note(1);
        continue;
      }
      console.log(ok(`target has ${targetCols.size} columns`));

      /* source side */
      let sourceCols: Set<string>;
      try {
        sourceCols = new Set(await read.columnsOf(spec.source, spec.sourceSchema));
      } catch (error) {
        console.log(bad(`could not read source schema: ${msg(error)}`));
        note(1);
        continue;
      }

      if (sourceCols.size === 0) {
        const where = await read.locateTable(spec.source).catch(() => [] as string[]);
        if (where.length) {
          console.log(bad(`source "${spec.source}" is not on the search path; it lives in schema: ${where.join(", ")}`));
          console.log(`    → add  sourceSchema: "${where[0]}"  to this table in sources.ts`);
        } else {
          console.log(bad(`source table "${spec.source}" not found at all (check the name, and the read user's grants)`));
        }
        note(1);
        continue;
      }
      console.log(ok(`source has ${sourceCols.size} columns`));

      /* live row count — the honest answer to "is there anything to sync?" */
      try {
        const [{ n }] = await read.query<{ n: string | number }>(
          `select count(*) as n from ${read.qualified(spec.source, spec.sourceSchema)}`, []
        );
        const count = Number(n);
        console.log(count > 0 ? ok(`source row count: ${count.toLocaleString()}`)
                              : bad(`source table is EMPTY — 0 rows to sync`));
        if (count === 0) note(1);
      } catch (error) {
        console.log(warn(`could not count rows: ${msg(error)}`));
      }

      /* mapping */
      const mapping: { src: string; tgt: string }[] = [];
      if (spec.columns) {
        for (const [src, tgt] of Object.entries(spec.columns)) {
          if (!sourceCols.has(src)) { console.log(warn(`columns: source column "${src}" doesn't exist — ignored`)); note(1); continue; }
          if (!targetCols.has(tgt)) { console.log(warn(`columns: target column "${tgt}" doesn't exist — ignored`)); note(1); continue; }
          mapping.push({ src, tgt });
        }
      } else {
        for (const c of sourceCols) if (targetCols.has(c)) mapping.push({ src: c, tgt: c });
      }

      const payload = mapping.filter((m) => m.tgt !== identity && !conflictKey.includes(m.tgt));
      if (mapping.length === 0) {
        console.log(bad(`no column names in common — add a "columns" map`));
        console.log(`    source: ${[...sourceCols].slice(0, 12).join(", ")}`);
        console.log(`    target: ${[...targetCols].slice(0, 12).join(", ")}`);
        note(1);
        continue;
      }
      if (payload.length === 0) {
        console.log(bad(`only key column(s) line up — every other column would be NULL, so the sync refuses`));
        console.log(`    source: ${[...sourceCols].slice(0, 12).join(", ")}`);
        console.log(`    target: ${[...targetCols].slice(0, 12).join(", ")}`);
        note(1);
        continue;
      }
      console.log(ok(`${mapping.length} column(s) mapped (${payload.length} carrying data)`));
      const unmapped = [...sourceCols].filter((c) => !mapping.some((m) => m.src === c));
      if (unmapped.length) console.log(`    not copied (no matching target column): ${unmapped.slice(0, 10).join(", ")}${unmapped.length > 10 ? ", …" : ""}`);

      /* cursor + identity */
      if (!sourceCols.has(cursor.column)) { console.log(bad(`cursor column "${cursor.column}" doesn't exist on the source`)); note(1); }
      else console.log(ok(`cursor: ${cursor.column} (${cursor.type})`));
      if (cursor.type === "timestamp") {
        const tb = cursor.tiebreak ?? identity;
        if (!sourceCols.has(tb)) { console.log(bad(`timestamp tiebreak "${tb}" doesn't exist on the source`)); note(1); }
      }

      /* conflict key */
      const writable = new Set([...mapping.map((m) => m.tgt),
        ...Object.values(META_COLUMNS).filter((c) => targetCols.has(c))]);
      const missing = conflictKey.filter((k) => !writable.has(k));
      if (missing.length) {
        console.log(bad(`conflictKey ${JSON.stringify(conflictKey)} includes ${JSON.stringify(missing)} which the sync never writes`));
        note(1);
      } else {
        console.log(ok(`conflictKey ${JSON.stringify(conflictKey)} is writable`));
        // is it actually unique in YENES? a missing constraint fails at insert time
        const { rows: uq } = await pg.query<{ ok: boolean }>(
          `select exists (
             select 1 from pg_index i
              join pg_class t on t.oid = i.indrelid
              join pg_namespace n on n.oid = t.relnamespace
             where t.relname = $1 and n.nspname='public' and (i.indisunique or i.indisprimary)
               and (select array_agg(a.attname::text order by a.attname)
                      from unnest(i.indkey) k join pg_attribute a
                        on a.attrelid = t.oid and a.attnum = k)
                   = (select array_agg(x order by x) from unnest($2::text[]) x)
           ) as ok`,
          [spec.target, conflictKey]
        );
        if (!uq[0]?.ok) {
          console.log(bad(`no UNIQUE/PK constraint on (${conflictKey.join(", ")}) in "${spec.target}" — every insert will error`));
          console.log(`    → create unique index on ${spec.target} (${conflictKey.join(", ")});`);
          note(1);
        } else {
          console.log(ok(`unique constraint present for the conflict key`));
        }
      }

      /* what's already landed */
      try {
        const { rows: landed } = await pg.query<{ n: string }>(
          `select count(*) as n from ${pgq(spec.target)}`
        );
        console.log(`    rows currently in ${spec.target}: ${Number(landed[0].n).toLocaleString()}`);
      } catch (error) {
        console.log(warn(`could not count rows in ${spec.target}: ${msg(error)}`));
      }
    }
  } finally {
    await read.close().catch(() => {});
  }
}

await pg.end().catch(() => {});

console.log("\n" + "═".repeat(72));
console.log(problems === 0
  ? " No problems found. Every declared table should sync."
  : ` ${problems} problem(s) found — each marked ✗ above, with the fix.`);
console.log("═".repeat(72));
process.exit(problems ? 1 : 0);
