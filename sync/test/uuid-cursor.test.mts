/**
 * Regression test for the "YZ syncs once, then returns 0 rows forever" bug.
 *
 * A random (v4) UUID primary key is NOT a valid sync cursor. Keyset paging
 * assumes new rows sort AFTER everything already seen. Random UUIDs don't:
 * once the first backfill finishes, the cursor sits near the top of the range
 * (`ffff…`) and virtually every new row sorts BELOW it, so `id > cursor`
 * matches nothing.
 *
 * A timestamp cursor with the uuid as tiebreak is the correct choice.
 */
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { copyTable } from "../lib/copy.js";
import { ensureState } from "../lib/state.js";
import { assertIdentifier, type ReadConnection } from "../lib/db.js";
import type { SourceSpec, TableSpec } from "../lib/types.js";

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, cond: unknown, detail = "") =>
  results.push({ name, pass: !!cond, detail: cond ? "" : detail });

const silent = { info: () => {}, warn: () => {} };
const asPool = (db: PGlite) => db as unknown as Pool;

function pgliteRead(db: PGlite): ReadConnection {
  const q = (n: string) => '"' + assertIdentifier(n, "identifier") + '"';
  return {
    dialect: "postgres",
    q,
    qualified: (t, s) => (s ? `${q(s)}.${q(t)}` : q(t)),
    ph: (i) => `$${i}`,
    query: async <T,>(sql: string, p: unknown[]) => (await db.query(sql, p)).rows as T[],
    columnsOf: async (table) =>
      (await db.query<{ name: string }>(
        `select column_name as name from information_schema.columns
          where table_schema='public' and table_name=$1 order by ordinal_position`, [table]
      )).rows.map((r) => r.name),
    locateTable: async () => ["public"],
    close: async () => {},
  };
}

const YZ: SourceSpec = {
  key: "yz", label: "OXM2", envVar: "YZ_DATABASE_URL",
  dialect: "postgres", required: false, tables: [],
};

async function build() {
  const src = new PGlite();
  const dest = new PGlite();
  await src.query(`create table "order" (
     id uuid primary key default gen_random_uuid(),
     order_no text,
     total numeric,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now())`);
  await src.query(`insert into "order" (order_no,total)
     select 'SO-'||g, g from generate_series(1,3000) g`);
  await dest.query(`create table ai_order (
     id uuid primary key, order_no text, total numeric,
     created_at timestamptz, updated_at timestamptz)`);
  await ensureState(asPool(dest));
  return { src, dest };
}

const run = (src: PGlite, dest: PGlite, spec: TableSpec) =>
  copyTable({ pg: asPool(dest), read: pgliteRead(src), source: YZ, spec, deadline: Date.now() + 60_000, log: silent });

const countOf = async (db: PGlite, t: string) =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from ${t}`)).rows[0].n);

/* ---------------- 1. the bug: her exact config ---------------- */
{
  const { src, dest } = await build();
  const spec: TableSpec = {
    source: "order", target: "ai_order",
    identity: "id",
    cursor: { column: "id", type: "text" },   // ← random uuid as cursor
  };

  const first = await run(src, dest, spec);
  check("[uuid-bug] initial backfill copies everything", first.copied === 3000, `copied=${first.copied}`);

  const cursor = (await dest.query<{ cursor_value: string }>(
    `select cursor_value from sync_state where source_key='yz' and target_table='ai_order'`
  )).rows[0].cursor_value;
  check("[uuid-bug] cursor ends near the TOP of the uuid range", cursor >= "f", `cursor=${cursor}`);

  // 500 brand-new orders arrive
  await src.query(`insert into "order" (order_no,total) select 'NEW-'||g, g from generate_series(1,500) g`);
  const second = await run(src, dest, spec);

  check("[uuid-bug] REPRODUCED: new rows are almost entirely missed",
        second.copied < 100, `copied=${second.copied} of 500 new rows`);
  const landed = await countOf(dest, "ai_order");
  check("[uuid-bug] target is now missing most of the new rows",
        landed < 3500, `target has ${landed}, source has 3500`);

  console.log(`\n  → with a uuid cursor: ${second.copied} of 500 new rows picked up ` +
              `(${landed}/3500 in target)\n`);
}

/* ---------------- 2. the fix: timestamp cursor ---------------- */
{
  const { src, dest } = await build();
  const spec: TableSpec = {
    source: "order", target: "ai_order",
    identity: "id",
    cursor: { column: "updated_at", type: "timestamp", tiebreak: "id" },
  };

  const first = await run(src, dest, spec);
  check("[uuid-fix] initial backfill copies everything", first.copied === 3000, `copied=${first.copied}`);

  await src.query(`insert into "order" (order_no,total) select 'NEW-'||g, g from generate_series(1,500) g`);
  const second = await run(src, dest, spec);
  check("[uuid-fix] every new row is picked up", second.copied >= 500, `copied=${second.copied} of 500`);
  check("[uuid-fix] target matches the source exactly", (await countOf(dest, "ai_order")) === 3500,
        `target=${await countOf(dest, "ai_order")} expected 3500`);

  // and it captures edits, which the uuid cursor never could
  await src.query(`update "order" set order_no='EDITED', updated_at=now() where order_no='SO-1'`);
  const third = await run(src, dest, spec);
  const edited = (await dest.query<{ n: number }>(
    `select count(*)::int as n from ai_order where order_no='EDITED'`)).rows[0].n;
  check("[uuid-fix] edits are captured too", edited === 1, `copied=${third.copied} edited=${edited}`);
  check("[uuid-fix] no duplicates after the edit", (await countOf(dest, "ai_order")) === 3500);

  console.log(`  → with a timestamp cursor: ${second.copied} of 500 new rows picked up ` +
              `(${await countOf(dest, "ai_order")}/3500 in target)\n`);
}

/* ---------------- 3. resetting the cursor recovers the missed rows ---------------- */
{
  const { src, dest } = await build();
  const bad: TableSpec = { source: "order", target: "ai_order", identity: "id", cursor: { column: "id", type: "text" } };
  await run(src, dest, bad);
  await src.query(`insert into "order" (order_no,total) select 'NEW-'||g, g from generate_series(1,500) g`);
  await run(src, dest, bad);
  const stuck = await countOf(dest, "ai_order");

  // the documented recovery: null the cursor, switch to a timestamp cursor
  await dest.query(`update sync_state set cursor_value=null, cursor_key=null where source_key='yz'`);
  const good: TableSpec = {
    source: "order", target: "ai_order", identity: "id",
    cursor: { column: "updated_at", type: "timestamp", tiebreak: "id" },
  };
  await run(src, dest, good);

  check("[recovery] resetting the cursor backfills the missed rows",
        (await countOf(dest, "ai_order")) === 3500, `was ${stuck}, now ${await countOf(dest, "ai_order")}`);
  check("[recovery] re-import produced no duplicates", (await countOf(dest, "ai_order")) === 3500);
}

console.log("========== UUID CURSOR ==========");
let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "\n        " + r.detail}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
