/**
 * Sync bookkeeping: where each (source, table) pair got to.
 *
 * Replaces the old single-source `sync_watermarks` table, which was keyed by
 * target table alone — that key can't tell two sources apart, so with a second
 * source they would overwrite each other's position.
 *
 * The old table is READ ONCE to carry positions over, then left alone. It is
 * never written to again and can be dropped by hand after you've confirmed a
 * good run (see MAPPING.md).
 */
import type { Pool } from "pg";

export interface Cursor {
  value: string | null;
  key: string | null;
}

export async function ensureState(pg: Pool): Promise<void> {
  await pg.query(
    `create table if not exists sync_state (
       source_key   text        not null,
       target_table text        not null,
       cursor_value text,
       cursor_key   text,
       rows_synced  bigint      not null default 0,
       last_run_at  timestamptz,
       updated_at   timestamptz not null default now(),
       primary key (source_key, target_table)
     )`
  );

  await carryOverLegacyWatermarks(pg);
}

/**
 * One-time, idempotent: copy positions out of the old `sync_watermarks` table
 * so the first multi-source run doesn't re-scan the whole legacy backfill.
 *
 * Re-copying would be harmless (every write is an upsert) but slow — the
 * legacy customer table alone is ~900k rows.
 */
async function carryOverLegacyWatermarks(pg: Pool): Promise<void> {
  const { rows } = await pg.query<{ exists: boolean }>(
    `select count(*) > 0 as exists
       from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'sync_watermarks'
        and column_name  = 'table_name'`
  );

  if (!rows[0]?.exists) return;

  await pg.query(
    `insert into sync_state (source_key, target_table, cursor_value)
     select 'legacy', table_name, last_id::text
       from sync_watermarks
      where last_id is not null
     on conflict (source_key, target_table) do nothing`
  );
}

export async function readCursor(pg: Pool, sourceKey: string, target: string): Promise<Cursor> {
  const { rows } = await pg.query<{ cursor_value: string | null; cursor_key: string | null }>(
    `insert into sync_state (source_key, target_table)
     values ($1, $2)
     on conflict (source_key, target_table) do update
       set source_key = excluded.source_key
     returning cursor_value, cursor_key`,
    [sourceKey, target]
  );

  const row = rows[0];
  return { value: row?.cursor_value ?? null, key: row?.cursor_key ?? null };
}

export async function writeCursor(
  pg: Pool,
  sourceKey: string,
  target: string,
  cursor: Cursor,
  rowsAdded: number
): Promise<void> {
  await pg.query(
    `update sync_state
        set cursor_value = $3,
            cursor_key   = $4,
            rows_synced  = rows_synced + $5,
            updated_at   = now()
      where source_key = $1 and target_table = $2`,
    [sourceKey, target, cursor.value, cursor.key, rowsAdded]
  );
}

export async function markRun(pg: Pool, sourceKey: string, target: string): Promise<void> {
  await pg.query(
    `update sync_state set last_run_at = now()
      where source_key = $1 and target_table = $2`,
    [sourceKey, target]
  );
}
