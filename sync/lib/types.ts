/**
 * Configuration types for the multi-source sync.
 *
 * You normally don't edit this file — you edit `sources.ts`, which is typed
 * against everything here. Read this as the reference for what each option
 * means. See MAPPING.md for the how-to.
 */

export type Dialect = "mysql" | "postgres";

/**
 * How the sync walks through a source table.
 *
 *  numeric   — an auto-increment integer id. Pages with `cursor > last`.
 *              Picks up new rows only. This is what the legacy tables use.
 *
 *  text      — a string/uuid key with a stable sort order. Same as numeric but
 *              compared as text. Only safe if the column never changes for a
 *              given row.
 *
 *  timestamp — a "last modified" column. Pages with a keyset on
 *              (cursor, tiebreak) so rows sharing the same timestamp are never
 *              skipped or looped over. This is the only mode that picks up
 *              EDITS to existing rows, not just inserts — use it when the
 *              source maintains the column reliably.
 */
export type CursorType = "numeric" | "text" | "timestamp";

export interface CursorSpec {
  /** Column on the SOURCE table to page through. */
  column: string;
  type: CursorType;
  /**
   * Tiebreaker column, used only by `timestamp` cursors to make paging exact
   * when many rows share one timestamp. Defaults to the table's `identity`.
   */
  tiebreak?: string;
}

export interface TableSpec {
  /** Table name on the source database. */
  source: string;
  /** Table name in YENES that receives the rows. */
  target: string;

  /**
   * Schema the source table lives in. Leave it out and the table is resolved
   * the way an unqualified query would (search_path on Postgres, the connected
   * database on MySQL), which is right for the common case.
   *
   * Set it when the table sits in a schema that isn't on the search path — the
   * sync tells you the schema name in its skip message when that happens.
   */
  sourceSchema?: string;

  /**
   * Column on the SOURCE that uniquely identifies a row. Default `"id"`.
   * Used for the `_source_id` metadata column and as the timestamp tiebreaker.
   */
  identity?: string;

  /**
   * How to page. Defaults to `{ column: identity, type: "numeric" }`, which is
   * the original legacy behaviour.
   */
  cursor?: CursorSpec;

  /**
   * Target columns that form the ON CONFLICT key — what makes a row "the same
   * row" on re-sync. Default `["id"]`.
   *
   * These columns MUST have a unique or primary key constraint in YENES, and
   * must all be present in the data being written, or the insert will error.
   *
   * For a table fed by two sources at once, use `["_source", "_source_id"]`.
   */
  conflictKey?: string[];

  /**
   * Explicit column mapping, `{ sourceColumn: targetColumn }`.
   *
   * Omit it and the sync copies every source column whose name also exists on
   * the target, ignoring the rest — handy when the schemas already agree.
   * Provide it and ONLY the listed columns are copied, which is what you want
   * when the two schemas name things differently.
   */
  columns?: Record<string, string>;

  /**
   * Extra SQL predicate applied to the source read, without the `WHERE`.
   * Example: `"status <> 'draft'"`. Written in the SOURCE's dialect.
   *
   * This string is interpolated into the query as-is, so it must be a literal
   * you wrote — never build it from user input.
   */
  where?: string;

  /** Rows per page. Default 1000. Lower it if the source is slow or rows are wide. */
  pageSize?: number;

  /** Set false to leave the mapping in place but stop syncing it. Default true. */
  enabled?: boolean;
}

export interface SourceSpec {
  /**
   * Short stable identifier, e.g. "legacy" or "yz".
   *
   * This is written into the `_source` column and into the sync's bookkeeping,
   * so DO NOT rename it once data has been synced — the sync would lose its
   * position and re-copy everything, and `_source` values would disagree
   * between old and new rows.
   */
  key: string;

  /** Human-readable name, used in logs only. */
  label: string;

  /** Environment variable holding this source's connection string. */
  envVar: string;

  dialect: Dialect;

  /**
   * When true, a missing env var or a failed connection fails the whole run.
   * When false, the source is skipped with a log line and the other sources
   * still sync — use this for a source that isn't wired up yet.
   */
  required: boolean;

  tables: TableSpec[];
}

/** Metadata columns the sync fills in automatically — but only if the target
 *  table actually has them. Adding one to a table is opt-in; leaving it out
 *  keeps the table exactly as it is today. */
export const META_COLUMNS = {
  /** Which source the row came from, e.g. "legacy". Text. */
  source: "_source",
  /** The row's identity on that source, as text. */
  sourceId: "_source_id",
  /** The source table it was read from. Text. */
  sourceTable: "_source_table",
  /** When this sync last wrote the row. timestamptz. */
  syncedAt: "_synced_at",
} as const;
