/**
 * Connections and identifier handling.
 *
 * Table and column names can't be passed as query parameters, so they get
 * interpolated into SQL. Everything that reaches a query goes through
 * `assertIdentifier` first, and values always go through placeholders.
 */
import mysql from "mysql2/promise";
import { Pool, types as pgTypes } from "pg";
import type { Dialect } from "./types.js";

// Postgres timestamp/timestamptz (OIDs 1114/1184) default to parsing into a JS
// Date, which only holds millisecond precision. A source column with
// microsecond precision gets silently truncated, so the value we write back
// as a keyset cursor no longer matches what's actually stored — comparisons
// against it can miss rows or get stuck. Read them as raw strings instead,
// the same fix already applied to the MySQL source via `dateStrings: true`.
const RAW_TIMESTAMP_TYPES = {
  getTypeParser: (oid: number, format?: unknown) =>
    oid === 1114 || oid === 1184 ? (val: string) => val : pgTypes.getTypeParser(oid, format as never),
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Reject anything that isn't a plain identifier before it reaches SQL.
 * Deliberately stricter than what MySQL/Postgres allow — a table called
 * `weird-name` is rejected rather than quoted, because a name that needs
 * escaping is nearly always a config typo.
 */
export function assertIdentifier(name: string, what: string): string {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid ${what}: ${JSON.stringify(name)}. ` +
        `Table and column names must match ${IDENTIFIER} (letters, digits, _ and $, not starting with a digit).`
    );
  }
  return name;
}

/** A read-side connection to one source database, dialect differences absorbed. */
export interface ReadConnection {
  dialect: Dialect;
  /** Quote an identifier for this dialect. Validates it first. */
  q(name: string): string;
  /** `"schema"."table"` when a schema is given, otherwise just the table. */
  qualified(table: string, schema?: string): string;
  /** Positional placeholder — `?` for MySQL, `$n` for Postgres. */
  ph(index: number): string;
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]>;
  /**
   * Column names on a table. With no schema, resolves it the same way an
   * unqualified query would (search_path on Postgres, the connected database
   * on MySQL) so the answer matches what the SELECT will actually read.
   */
  columnsOf(table: string, schema?: string): Promise<string[]>;
  /**
   * Every non-system schema containing a table of this name. Used to turn
   * "not found" into "it's over there, set sourceSchema".
   */
  locateTable(table: string): Promise<string[]>;
  close(): Promise<void>;
}

export async function connectSource(url: string, dialect: Dialect, label: string): Promise<ReadConnection> {
  if (dialect === "mysql") return connectMysql(url, label);
  return connectPostgresSource(url, label);
}

async function connectMysql(url: string, label: string): Promise<ReadConnection> {
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({
      uri: url,
      // Keep datetimes as strings. Otherwise the driver reparses them in the
      // worker's local timezone and silently shifts every timestamp.
      dateStrings: true,
    });
  } catch (error) {
    throw new Error(
      `Could not connect to ${label} (MySQL). Check the connection string, and that the host allows connections from Trigger.dev. Original error: ${msg(error)}`
    );
  }

  const q = (name: string) => "`" + assertIdentifier(name, "identifier") + "`";

  return {
    dialect: "mysql",
    q,
    qualified: (table, schema) => (schema ? `${q(schema)}.${q(table)}` : q(table)),
    ph: () => "?",
    async query<T>(sql: string, params: unknown[]) {
      const [rows] = await conn.query(sql, params);
      return rows as T[];
    },
    async columnsOf(table: string, schema?: string) {
      const [rows] = await conn.query(
        `select column_name as name from information_schema.columns
          where table_schema = coalesce(?, database()) and table_name = ?
          order by ordinal_position`,
        [schema ?? null, table]
      );
      return (rows as { name: string }[]).map((r) => r.name);
    },
    async locateTable(table: string) {
      const [rows] = await conn.query(
        `select table_schema as schema from information_schema.tables
          where table_name = ?
            and table_schema not in ('information_schema','mysql','performance_schema','sys')
          order by table_schema`,
        [table]
      );
      return (rows as { schema: string }[]).map((r) => r.schema);
    },
    close: () => conn.end(),
  };
}

async function connectPostgresSource(url: string, label: string): Promise<ReadConnection> {
  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 2,
    types: RAW_TIMESTAMP_TYPES,
  });

  try {
    await pool.query("select 1");
  } catch (error) {
    await pool.end().catch(() => {});
    throw new Error(
      `Could not connect to ${label} (Postgres). Check the connection string — if it's Supabase, use the Session pooler string, not "Direct connection". Original error: ${msg(error)}`
    );
  }

  const q = (name: string) => '"' + assertIdentifier(name, "identifier") + '"';

  /**
   * Which schema an unqualified `from "table"` would actually resolve to.
   *
   * Deliberately not `current_schema()`: that's only the FIRST schema on the
   * search path, so a table sitting in the second one reads as "not found".
   * Walks the whole search path in order, and covers views and materialized
   * views too, not just plain tables.
   */
  async function resolveSchema(table: string): Promise<string | null> {
    const { rows } = await pool.query<{ schema: string }>(
      `select n.nspname as schema
         from unnest(current_schemas(true)) with ordinality as sp(name, ord)
         join pg_namespace n on n.nspname = sp.name
         join pg_class c on c.relnamespace = n.oid
        where c.relname = $1
          and c.relkind in ('r','v','m','f','p')
        order by sp.ord
        limit 1`,
      [table]
    );
    return rows[0]?.schema ?? null;
  }

  return {
    dialect: "postgres",
    q,
    qualified: (table, schema) => (schema ? `${q(schema)}.${q(table)}` : q(table)),
    ph: (i) => `$${i}`,
    async query<T>(sql: string, params: unknown[]) {
      const { rows } = await pool.query(sql, params);
      return rows as T[];
    },
    async columnsOf(table: string, schema?: string) {
      const target = schema ?? (await resolveSchema(table));
      if (!target) return [];
      const { rows } = await pool.query<{ name: string }>(
        `select column_name as name from information_schema.columns
          where table_schema = $1 and table_name = $2
          order by ordinal_position`,
        [target, table]
      );
      return rows.map((r) => r.name);
    },
    async locateTable(table: string) {
      const { rows } = await pool.query<{ schema: string }>(
        `select n.nspname as schema
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relname = $1
            and c.relkind in ('r','v','m','f','p')
            and n.nspname not in ('pg_catalog','information_schema')
          order by n.nspname`,
        [table]
      );
      return rows.map((r) => r.schema);
    },
    close: () => pool.end(),
  };
}

/** The destination. Always Postgres. */
export async function connectYenes(url: string): Promise<Pool> {
  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 4,
  });

  try {
    await pool.query("select 1");
  } catch (error) {
    await pool.end().catch(() => {});
    throw new Error(
      `Could not connect to your Supabase Postgres. Make sure YENES_DATABASE_URL is the Session pooler string (Connect -> Session pooler), not "Direct connection" — direct is IPv6-only and won't resolve from here. Original error: ${msg(error)}`
    );
  }

  return pool;
}

/** Double-quote a Postgres identifier, validated. */
export function pgq(name: string): string {
  return '"' + assertIdentifier(name, "identifier") + '"';
}

export function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
