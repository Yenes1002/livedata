/**
 * Tests for the multi-source copy logic.
 *
 * Both the source and the destination are real Postgres, running in-process
 * via PGlite — so the SQL the sync generates is actually executed, including
 * keyset pagination, ON CONFLICT upserts and information_schema introspection.
 *
 *   npm test        (from the sync/ folder)
 *
 * The MySQL dialect can't be executed here, so its query generation is checked
 * by asserting the SQL text instead (see "mysql dialect" at the bottom).
 */
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { copyTable, type Logger } from "../lib/copy.js";
import { ensureState, readCursor } from "../lib/state.js";
import { assertIdentifier } from "../lib/db.js";
import type { ReadConnection } from "../lib/db.js";
import type { SourceSpec, TableSpec } from "../lib/types.js";

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, cond: unknown, detail = "") =>
  results.push({ name, pass: !!cond, detail: cond ? "" : detail });

const silent: Logger = { info: () => {}, warn: () => {} };
const captured = () => {
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
  return { log, lines };
};

/** A ReadConnection backed by PGlite — real SQL, real results.
 *  Mirrors connectPostgresSource() in lib/db.ts, including search-path
 *  resolution rather than current_schema(). */
function pgliteRead(db: PGlite): ReadConnection {
  const q = (name: string) => '"' + assertIdentifier(name, "identifier") + '"';

  const resolveSchema = async (table: string) =>
    (
      await db.query<{ schema: string }>(
        `select n.nspname as schema
           from unnest(current_schemas(true)) with ordinality as sp(name, ord)
           join pg_namespace n on n.nspname = sp.name
           join pg_class c on c.relnamespace = n.oid
          where c.relname = $1 and c.relkind in ('r','v','m','f','p')
          order by sp.ord limit 1`,
        [table]
      )
    ).rows[0]?.schema ?? null;

  return {
    dialect: "postgres",
    q,
    qualified: (table, schema) => (schema ? `${q(schema)}.${q(table)}` : q(table)),
    ph: (i) => `$${i}`,
    query: async <T,>(sql: string, params: unknown[]) => (await db.query(sql, params)).rows as T[],
    columnsOf: async (table, schema) => {
      const target = schema ?? (await resolveSchema(table));
      if (!target) return [];
      return (
        await db.query<{ name: string }>(
          `select column_name as name from information_schema.columns
            where table_schema = $1 and table_name = $2 order by ordinal_position`,
          [target, table]
        )
      ).rows.map((r) => r.name);
    },
    locateTable: async (table) =>
      (
        await db.query<{ schema: string }>(
          `select n.nspname as schema from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where c.relname = $1 and c.relkind in ('r','v','m','f','p')
              and n.nspname not in ('pg_catalog','information_schema')
            order by n.nspname`,
          [table]
        )
      ).rows.map((r) => r.schema),
    close: async () => {},
  };
}

const asPool = (db: PGlite) => db as unknown as Pool;

function source(key: string, tables: TableSpec[] = []): SourceSpec {
  return { key, label: key.toUpperCase(), envVar: `${key.toUpperCase()}_DATABASE_URL`, dialect: "postgres", required: false, tables };
}

const FAR_FUTURE = () => Date.now() + 60_000;

async function rowsOf(db: PGlite, sql: string, params: unknown[] = []) {
  return (await db.query(sql, params)).rows as Record<string, unknown>[];
}

/* ------------------------------------------------------------------ */
/* 1. basic copy: rows land, metadata fills, cursor advances           */
/* ------------------------------------------------------------------ */
{
  const src = new PGlite();
  const dest = new PGlite();

  await src.query(`create table "Customer" (id int primary key, full_name text, email text, junk text)`);
  await src.query(`insert into "Customer" values (1,'Ann','a@x','zzz'),(2,'Bob','b@x','zzz'),(3,'Cal','c@x','zzz')`);

  await dest.query(`create table legacy_customers (
    id bigint primary key, full_name text, email text,
    _source text, _source_id text, _source_table text, _synced_at timestamptz)`);

  await ensureState(asPool(dest));

  const result = await copyTable({
    pg: asPool(dest),
    read: pgliteRead(src),
    source: source("legacy"),
    spec: { source: "Customer", target: "legacy_customers" },
    deadline: FAR_FUTURE(),
    log: silent,
  });

  const rows = await rowsOf(dest, `select * from legacy_customers order by id`);
  check("[basic] 3 rows copied", result.copied === 3, `copied=${result.copied}`);
  check("[basic] marked exhausted", result.exhausted === true);
  check("[basic] matching columns copied", rows[0].full_name === "Ann" && rows[0].email === "a@x", JSON.stringify(rows[0]));
  check("[basic] unmapped source column ignored", !("junk" in rows[0]), JSON.stringify(Object.keys(rows[0])));
  check("[basic] _source filled", rows.every((r) => r._source === "legacy"), JSON.stringify(rows.map((r) => r._source)));
  check("[basic] _source_id filled", rows.map((r) => r._source_id).join(",") === "1,2,3",
        JSON.stringify(rows.map((r) => r._source_id)));
  check("[basic] _source_table filled", rows.every((r) => r._source_table === "Customer"));
  check("[basic] _synced_at filled", rows.every((r) => r._synced_at !== null));

  const cur = await readCursor(asPool(dest), "legacy", "legacy_customers");
  check("[basic] cursor advanced to last id", cur.value === "3", JSON.stringify(cur));
}

/* ------------------------------------------------------------------ */
/* 2. re-run is idempotent and incremental                             */
/* ------------------------------------------------------------------ */
{
  const src = new PGlite();
  const dest = new PGlite();
  await src.query(`create table t (id int primary key, v text)`);
  await src.query(`insert into t values (1,'a'),(2,'b')`);
  await dest.query(`create table tgt (id bigint primary key, v text)`);
  await ensureState(asPool(dest));

  const spec: TableSpec = { source: "t", target: "tgt" };
  const run = () => copyTable({ pg: asPool(dest), read: pgliteRead(src), source: source("legacy"), spec, deadline: FAR_FUTURE(), log: silent });

  await run();
  const second = await run();
  check("[rerun] second run copies nothing new", second.copied === 0, `copied=${second.copied}`);
  check("[rerun] no duplicate rows", (await rowsOf(dest, `select count(*)::int as n from tgt`))[0].n === 2,
        JSON.stringify(await rowsOf(dest, `select * from tgt`)));

  // new rows arrive on the source
  await src.query(`insert into t values (3,'c')`);
  const third = await run();
  check("[rerun] only the new row is copied", third.copied === 1, `copied=${third.copied}`);
  check("[rerun] total is now 3", (await rowsOf(dest, `select count(*)::int as n from tgt`))[0].n === 3);

  // an edit to an already-synced row is NOT picked up by a numeric cursor
  await src.query(`update t set v='CHANGED' where id=1`);
  await run();
  const row1 = (await rowsOf(dest, `select v from tgt where id=1`))[0];
  check("[rerun] numeric cursor does not capture edits (documented limitation)", row1.v === "a", String(row1.v));
}

/* ------------------------------------------------------------------ */
/* 3. THE BIG ONE: two sources into one table, colliding source ids    */
/* ------------------------------------------------------------------ */
{
  const legacy = new PGlite();
  const yz = new PGlite();
  const dest = new PGlite();

  // Both sources have a row with id = 1, and they are different people.
  await legacy.query(`create table customers (id int primary key, name text)`);
  await legacy.query(`insert into customers values (1,'Legacy Ann'),(2,'Legacy Bob')`);

  await yz.query(`create table client (client_id int primary key, client_name text)`);
  await yz.query(`insert into client values (1,'YZ Xavier'),(2,'YZ Yara')`);

  await dest.query(`create table unified_customers (
    row_id       bigserial primary key,
    name         text,
    _source      text not null,
    _source_id   text not null,
    _synced_at   timestamptz,
    unique (_source, _source_id))`);

  await ensureState(asPool(dest));

  const shared = { conflictKey: ["_source", "_source_id"] };

  const a = await copyTable({
    pg: asPool(dest), read: pgliteRead(legacy), source: source("legacy"),
    spec: { source: "customers", target: "unified_customers", ...shared },
    deadline: FAR_FUTURE(), log: silent,
  });

  const b = await copyTable({
    pg: asPool(dest), read: pgliteRead(yz), source: source("yz"),
    spec: {
      source: "client", target: "unified_customers", identity: "client_id",
      cursor: { column: "client_id", type: "numeric" },
      columns: { client_name: "name" },
      ...shared,
    },
    deadline: FAR_FUTURE(), log: silent,
  });

  const all = await rowsOf(dest, `select _source, _source_id, name from unified_customers order by _source, _source_id`);

  check("[merge] legacy copied 2", a.copied === 2, `copied=${a.copied}`);
  check("[merge] yz copied 2", b.copied === 2, `copied=${b.copied}`);
  check("[merge] all 4 rows coexist despite colliding ids", all.length === 4, JSON.stringify(all));
  check("[merge] legacy id=1 intact", all.some((r) => r._source === "legacy" && r._source_id === "1" && r.name === "Legacy Ann"),
        JSON.stringify(all));
  check("[merge] yz id=1 intact and did NOT overwrite legacy",
        all.some((r) => r._source === "yz" && r._source_id === "1" && r.name === "YZ Xavier"), JSON.stringify(all));

  // cursors are independent per source
  const cl = await readCursor(asPool(dest), "legacy", "unified_customers");
  const cy = await readCursor(asPool(dest), "yz", "unified_customers");
  check("[merge] per-source cursors kept separately", cl.value === "2" && cy.value === "2",
        `legacy=${cl.value} yz=${cy.value}`);

  // re-running both changes nothing
  await copyTable({ pg: asPool(dest), read: pgliteRead(legacy), source: source("legacy"),
    spec: { source: "customers", target: "unified_customers", ...shared }, deadline: FAR_FUTURE(), log: silent });
  const after = (await rowsOf(dest, `select count(*)::int as n from unified_customers`))[0].n;
  check("[merge] re-run introduces no duplicates", after === 4, `count=${after}`);
}

/* ------------------------------------------------------------------ */
/* 4. explicit column mapping, renamed columns only                    */
/* ------------------------------------------------------------------ */
{
  const src = new PGlite();
  const dest = new PGlite();
  await src.query(`create table sales_order (order_uuid text primary key, order_number text, placed_at timestamptz, total_amount numeric, secret text)`);
  await src.query(`insert into sales_order values
    ('u1','SO-1','2026-07-01T00:00:00Z',100.50,'hide'),
    ('u2','SO-2','2026-07-02T00:00:00Z',200.25,'hide')`);
  await dest.query(`create table yz_orders (id bigserial primary key, order_no text, order_date timestamptz, grand_total numeric,
    _source text, _source_id text, unique (_source,_source_id))`);
  await ensureState(asPool(dest));

  const r = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: {
      source: "sales_order", target: "yz_orders",
      identity: "order_uuid",
      cursor: { column: "order_uuid", type: "text" },
      conflictKey: ["_source", "_source_id"],
      columns: { order_number: "order_no", placed_at: "order_date", total_amount: "grand_total" },
    },
    deadline: FAR_FUTURE(), log: silent,
  });

  const rows = await rowsOf(dest, `select * from yz_orders order by order_no`);
  check("[mapping] 2 rows copied", r.copied === 2, `copied=${r.copied}`);
  check("[mapping] columns renamed correctly", rows[0].order_no === "SO-1" && String(rows[0].grand_total) === "100.50",
        JSON.stringify(rows[0]));
  check("[mapping] unlisted source column not copied", !("secret" in rows[0]), JSON.stringify(Object.keys(rows[0])));
  check("[mapping] text cursor advanced", (await readCursor(asPool(dest), "yz", "yz_orders")).value === "u2");
}

/* ------------------------------------------------------------------ */
/* 5. timestamp cursor with more ties than one page                    */
/* ------------------------------------------------------------------ */
{
  const src = new PGlite();
  const dest = new PGlite();
  await src.query(`create table ev (id int primary key, updated_at timestamptz, v text)`);
  // 25 rows all sharing ONE timestamp — a naive `updated_at > last` would either
  // skip them or loop forever with a page size of 10.
  const vals = Array.from({ length: 25 }, (_, i) => `(${i + 1},'2026-07-01T00:00:00Z','v${i + 1}')`).join(",");
  await src.query(`insert into ev values ${vals}`);
  await src.query(`insert into ev values (26,'2026-07-02T00:00:00Z','later')`);

  await dest.query(`create table ev_t (id bigint primary key, v text, updated_at timestamptz)`);
  await ensureState(asPool(dest));

  const spec: TableSpec = {
    source: "ev", target: "ev_t",
    cursor: { column: "updated_at", type: "timestamp" },
    pageSize: 10,
  };
  const r = await copyTable({ pg: asPool(dest), read: pgliteRead(src), source: source("legacy"), spec, deadline: FAR_FUTURE(), log: silent });

  const n = (await rowsOf(dest, `select count(*)::int as n from ev_t`))[0].n;
  check("[timestamp] every tied row copied, none skipped", n === 26, `got ${n} of 26 (copied=${r.copied})`);
  check("[timestamp] loop terminated", r.exhausted === true);

  // edits ARE captured with a timestamp cursor
  await src.query(`update ev set v='EDITED', updated_at='2026-07-03T00:00:00Z' where id=1`);
  const r2 = await copyTable({ pg: asPool(dest), read: pgliteRead(src), source: source("legacy"), spec, deadline: FAR_FUTURE(), log: silent });
  const edited = (await rowsOf(dest, `select v from ev_t where id=1`))[0];
  check("[timestamp] captures edits to existing rows", edited.v === "EDITED", `v=${edited.v} copied=${r2.copied}`);
  check("[timestamp] still no duplicates after edit",
        (await rowsOf(dest, `select count(*)::int as n from ev_t`))[0].n === 26);
}

/* ------------------------------------------------------------------ */
/* 6. resume after running out of time                                 */
/* ------------------------------------------------------------------ */
{
  const src = new PGlite();
  const dest = new PGlite();
  await src.query(`create table big (id int primary key, v text)`);
  await src.query(`insert into big select g, 'v'||g from generate_series(1,50) g`);
  await dest.query(`create table big_t (id bigint primary key, v text)`);
  await ensureState(asPool(dest));

  const spec: TableSpec = { source: "big", target: "big_t", pageSize: 10 };
  // deadline allows roughly one page, then expires
  const first = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("legacy"), spec,
    deadline: Date.now() + 1, log: silent,
  });
  check("[resume] stopped early", first.copied < 50 && first.exhausted === false, `copied=${first.copied}`);

  const second = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("legacy"), spec,
    deadline: FAR_FUTURE(), log: silent,
  });
  const total = (await rowsOf(dest, `select count(*)::int as n from big_t`))[0].n;
  check("[resume] continues from the cursor and finishes", total === 50, `total=${total} (first=${first.copied} second=${second.copied})`);
  check("[resume] no rows copied twice", first.copied + second.copied === 50,
        `${first.copied} + ${second.copied}`);
}

/* ------------------------------------------------------------------ */
/* 7. carry over the old single-source sync_watermarks                 */
/* ------------------------------------------------------------------ */
{
  const dest = new PGlite();
  await dest.query(`create table sync_watermarks (table_name text primary key, last_id bigint not null default 0)`);
  await dest.query(`insert into sync_watermarks values ('legacy_customers', 918273), ('legacy_orders', 4455)`);

  await ensureState(asPool(dest));

  const c1 = await readCursor(asPool(dest), "legacy", "legacy_customers");
  const c2 = await readCursor(asPool(dest), "legacy", "legacy_orders");
  check("[migrate] legacy position carried over", c1.value === "918273", JSON.stringify(c1));
  check("[migrate] second table carried over", c2.value === "4455", JSON.stringify(c2));

  // a different source starts fresh at the same target name
  const c3 = await readCursor(asPool(dest), "yz", "legacy_customers");
  check("[migrate] other sources are not given the legacy position", c3.value === null, JSON.stringify(c3));

  // idempotent: running again doesn't reset anything
  await dest.query(`update sync_state set cursor_value='999999' where source_key='legacy' and target_table='legacy_customers'`);
  await ensureState(asPool(dest));
  const c4 = await readCursor(asPool(dest), "legacy", "legacy_customers");
  check("[migrate] re-running ensureState does not clobber progress", c4.value === "999999", JSON.stringify(c4));

  check("[migrate] old table left untouched",
        (await rowsOf(dest, `select count(*)::int as n from sync_watermarks`))[0].n === 2);
}

/* ------------------------------------------------------------------ */
/* 8. graceful skips instead of crashes                                */
/* ------------------------------------------------------------------ */
{
  const src = new PGlite();
  const dest = new PGlite();
  await src.query(`create table t (id int primary key, v text)`);
  await src.query(`insert into t values (1,'a')`);
  await ensureState(asPool(dest));

  // target table doesn't exist
  const missing = captured();
  const r1 = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "t", target: "not_created_yet" }, deadline: FAR_FUTURE(), log: missing.log,
  });
  check("[skip] missing target table is skipped, not thrown", !!r1.skipped && r1.copied === 0, JSON.stringify(r1));
  check("[skip] message tells you to create it", /does not exist/.test(r1.skipped ?? ""), r1.skipped ?? "");

  // source table doesn't exist
  await dest.query(`create table ok_t (id bigint primary key, v text)`);
  const r2 = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "no_such_table", target: "ok_t" }, deadline: FAR_FUTURE(), log: silent,
  });
  check("[skip] missing source table is skipped", /was not found/.test(r2.skipped ?? ""), r2.skipped ?? "");

  // ONLY the key lines up: writing this would insert rows that are all NULL
  // except the id, and report success. Must refuse instead.
  await dest.query(`create table nomatch (id bigint primary key, totally_different text)`);
  const r3 = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "t", target: "nomatch", conflictKey: ["id"] }, deadline: FAR_FUTURE(), log: silent,
  });
  check("[skip] key-only overlap refuses to write all-NULL rows",
        r3.copied === 0 && /only key column\(s\) line up/.test(r3.skipped ?? ""), JSON.stringify(r3));
  check("[skip] nothing was written for the key-only case",
        (await rowsOf(dest, `select count(*)::int as n from nomatch`))[0].n === 0);
  check("[skip] message names the source's real columns", /source has: id, v/.test(r3.skipped ?? ""), r3.skipped ?? "");

  // one real payload column is enough to proceed
  await dest.query(`create table partial (id bigint primary key, v text, extra text)`);
  const r3b = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "t", target: "partial" }, deadline: FAR_FUTURE(), log: silent,
  });
  check("[skip] a real shared column still syncs", r3b.copied === 1, JSON.stringify(r3b));

  // conflict key the sync never writes
  const r4 = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "t", target: "ok_t", conflictKey: ["_source", "_source_id"] },
    deadline: FAR_FUTURE(), log: silent,
  });
  check("[skip] unwritable conflictKey is caught before the insert",
        /never writes/.test(r4.skipped ?? ""), r4.skipped ?? "");

  // target without an id column and no explicit conflictKey
  await dest.query(`create table noid (code text primary key, v text)`);
  const r5 = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "t", target: "noid" }, deadline: FAR_FUTURE(), log: silent,
  });
  check("[skip] target with no id column is explained", /no "id" column/.test(r5.skipped ?? ""), r5.skipped ?? "");

  // bad cursor column
  await dest.query(`create table ok2 (id bigint primary key, v text)`);
  const r6 = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "t", target: "ok2", cursor: { column: "nope", type: "numeric" } },
    deadline: FAR_FUTURE(), log: silent,
  });
  check("[skip] unknown cursor column is explained", /cursor column "nope"/.test(r6.skipped ?? ""), r6.skipped ?? "");
}

/* ------------------------------------------------------------------ */
/* 8b. non-public schemas on a Postgres source                         */
/* ------------------------------------------------------------------ */
{
  const src = new PGlite();
  const dest = new PGlite();
  await src.query(`create schema oxm2`);
  await src.query(`create table oxm2."order" (id int primary key, order_no text)`);
  await src.query(`insert into oxm2."order" values (1,'SO-1'),(2,'SO-2')`);
  await dest.query(`create table ai_order (id bigint primary key, order_no text)`);
  await ensureState(asPool(dest));

  // not on the search path, and no sourceSchema given
  const r1 = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "order", target: "ai_order" }, deadline: FAR_FUTURE(), log: silent,
  });
  check("[schema] off-search-path table is skipped, not silently empty", r1.copied === 0);
  check("[schema] skip message names the schema it's actually in",
        /schema "oxm2"/.test(r1.skipped ?? "") && /sourceSchema: "oxm2"/.test(r1.skipped ?? ""), r1.skipped ?? "");

  // with sourceSchema it works
  const r2 = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("yz"),
    spec: { source: "order", target: "ai_order", sourceSchema: "oxm2" }, deadline: FAR_FUTURE(), log: silent,
  });
  check("[schema] sourceSchema makes it sync", r2.copied === 2, JSON.stringify(r2));
  check("[schema] rows landed", (await rowsOf(dest, `select count(*)::int as n from ai_order`))[0].n === 2);

  // a table on the search path but NOT in the first schema still resolves
  const src2 = new PGlite();
  await src2.query(`create schema extra`);
  await src2.query(`set search_path to nonexistent, extra, public`);
  await src2.query(`create table extra.widget (id int primary key, v text)`);
  await src2.query(`insert into extra.widget values (1,'a')`);
  const dest2 = new PGlite();
  await dest2.query(`create table widget_t (id bigint primary key, v text)`);
  await ensureState(asPool(dest2));
  const read2 = pgliteRead(src2);
  await src2.query(`set search_path to nonexistent, extra, public`);
  const r3 = await copyTable({
    pg: asPool(dest2), read: read2, source: source("yz"),
    spec: { source: "widget", target: "widget_t" }, deadline: FAR_FUTURE(), log: silent,
  });
  check("[schema] resolves beyond the FIRST search_path entry (current_schema would miss it)",
        r3.copied === 1, JSON.stringify(r3));
}

/* ------------------------------------------------------------------ */
/* 9. `where` filter                                                   */
/* ------------------------------------------------------------------ */
{
  const src = new PGlite();
  const dest = new PGlite();
  await src.query(`create table o (id int primary key, status text)`);
  await src.query(`insert into o values (1,'draft'),(2,'paid'),(3,'draft'),(4,'paid')`);
  await dest.query(`create table o_t (id bigint primary key, status text)`);
  await ensureState(asPool(dest));

  const r = await copyTable({
    pg: asPool(dest), read: pgliteRead(src), source: source("legacy"),
    spec: { source: "o", target: "o_t", where: "status <> 'draft'" },
    deadline: FAR_FUTURE(), log: silent,
  });
  const statuses = (await rowsOf(dest, `select status from o_t order by id`)).map((r) => r.status);
  check("[where] filter applied at the source", r.copied === 2 && statuses.join(",") === "paid,paid",
        `copied=${r.copied} ${JSON.stringify(statuses)}`);
}

/* ------------------------------------------------------------------ */
/* 10. identifier validation                                           */
/* ------------------------------------------------------------------ */
{
  let threw = false;
  try { assertIdentifier("orders; drop table x", "table"); } catch { threw = true; }
  check("[safety] identifier with SQL punctuation is rejected", threw);

  let threw2 = false;
  try { assertIdentifier("weird-name", "table"); } catch { threw2 = true; }
  check("[safety] hyphenated identifier is rejected", threw2);

  check("[safety] normal identifiers pass", assertIdentifier("MerchantProjectPageOrder", "table") === "MerchantProjectPageOrder");
}

/* ------------------------------------------------------------------ */
/* 11. mysql dialect query generation (can't execute, so assert SQL)   */
/* ------------------------------------------------------------------ */
{
  const dest = new PGlite();
  await dest.query(`create table m_t (id bigint primary key, v text)`);
  await ensureState(asPool(dest));

  const seen: string[] = [];
  const mq = (name: string) => "`" + assertIdentifier(name, "identifier") + "`";
  const fakeMysql: ReadConnection = {
    dialect: "mysql",
    q: mq,
    qualified: (table, schema) => (schema ? `${mq(schema)}.${mq(table)}` : mq(table)),
    ph: () => "?",
    query: async (sql: string) => { seen.push(sql); return []; },
    columnsOf: async () => ["id", "v"],
    locateTable: async () => [],
    close: async () => {},
  };

  await copyTable({
    pg: asPool(dest), read: fakeMysql, source: source("legacy"),
    spec: { source: "Customer", target: "m_t" }, deadline: FAR_FUTURE(), log: silent,
  });

  const sql = seen[0] ?? "";
  check("[mysql] backtick quoting used", sql.includes("`Customer`") && sql.includes("`id`"), sql);
  check("[mysql] no Postgres quoting leaked in", !sql.includes('"'), sql);
  check("[mysql] limit inlined as an integer", /limit 1000$/.test(sql), sql);
  check("[mysql] ordered by the cursor", /order by `id` asc/.test(sql), sql);

  // with a cursor value it must use ? placeholders
  await dest.query(`update sync_state set cursor_value='42' where source_key='legacy' and target_table='m_t'`);
  seen.length = 0;
  await copyTable({
    pg: asPool(dest), read: fakeMysql, source: source("legacy"),
    spec: { source: "Customer", target: "m_t" }, deadline: FAR_FUTURE(), log: silent,
  });
  check("[mysql] uses ? placeholder, never $1", seen[0]?.includes("`id` > ?") && !seen[0]?.includes("$1"), seen[0] ?? "");
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */
console.log("\n================ SYNC TESTS ================");
let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "\n        " + r.detail}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
