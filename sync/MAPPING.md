# Mapping a second source into YENES

> **If you are an AI coding assistant working in this repo, read this whole file
> before editing `sources.ts`.** It contains the invariants that keep the two
> databases from corrupting each other. The "Rules that must not be broken"
> section is the important one.

---

## What already works, and what's left to decide

The plumbing for two sources is **done and tested**. Connections, paging,
per-source bookkeeping, conflict handling, partial-failure isolation and the
time budget are all in place, and `npm test` covers them (53 checks, including
two sources writing colliding ids into one table without overwriting).

What is **not** decided, because it's a question about your data rather than
about the code:

- which YZ tables to pull
- which YZ columns correspond to which legacy columns
- whether the two sources should land in separate tables or share one
- what "the same customer/order in both systems" means, if anything

That's what this document is for. You edit exactly one file: **`sources.ts`**.

---

## The mental model

```
  LEGACY (MySQL)  ─┐
                   ├─►  landing tables in YENES  ─►  merge view  ─►  dashboard
  YZ     (?)      ─┘     (raw, one row = one            (yours)
                          row from one source)
```

**Land first, merge second.** The sync's job is only to get rows into YENES
faithfully. It never tries to reconcile a legacy customer with a YZ customer —
that's business logic, and it belongs in a SQL view you control, where you can
change your mind without re-syncing anything.

This matters because the two databases have no shared identifier. Legacy
customer `id = 1` and YZ customer `id = 1` are different people. Anything that
treats them as the same row loses data silently.

---

## Choose a landing strategy

### Strategy A — separate tables per source *(recommended, start here)*

Each source gets its own table. Collision is impossible by construction.

```
legacy_customers     ← LEGACY.Customer
yz_customers         ← YZ.client
```

```ts
{ source: "client", target: "yz_customers" }
```

Then merge in a view when you're ready (see "Merging" below). This is the
lowest-risk option and the easiest to reason about, because each table is a
faithful copy of one upstream table and nothing else.

**Pick this unless you have a specific reason not to.**

### Strategy B — one shared table, tagged by source

Both sources write into one table, kept apart by a composite key of
`(_source, _source_id)`.

```sql
create table unified_customers (
  row_id     bigserial primary key,
  full_name  text,
  email      text,
  _source    text not null,
  _source_id text not null,
  _synced_at timestamptz,
  unique (_source, _source_id)     -- REQUIRED: this is the conflict key
);
```

```ts
{ source: "Customer", target: "unified_customers", conflictKey: ["_source", "_source_id"] }
{ source: "client",   target: "unified_customers", conflictKey: ["_source", "_source_id"],
  identity: "client_id", columns: { client_name: "full_name", client_email: "email" } }
```

Useful when the two schemas are close and you want one place to query. The
trade-off is that a schema change on either side now touches a shared table.

### Strategy C — deduplicated master table

Same as B, plus a rule for when a legacy row and a YZ row are *the same
entity* (matching email, matching phone…). **Do not attempt this in the sync.**
Land with A or B, then build the dedupe as a view or a scheduled SQL job, where
a wrong rule is a `create or replace view` away from being fixed rather than a
re-import.

---

## Adding the YZ source, step by step

### 1. Confirm the dialect and connectivity

In `sources.ts`, set `dialect` on the `yz` entry to `"mysql"` or `"postgres"`.

Set `YZ_DATABASE_URL` in Trigger.dev → Settings → Environment Variables →
Production. Use a **read-only** user. For Supabase sources use the Session
pooler string, not "Direct connection".

Leave `required: false` until it's working — the legacy sync keeps running
regardless, and YZ failures show as a log line instead of a failed run.

### 2. Look at the actual schema before mapping anything

Don't guess column names. From `sync/`, with `YZ_DATABASE_URL` in your `.env`:

```bash
# MySQL
mysql "$YZ_DATABASE_URL" -e "show tables;"
mysql "$YZ_DATABASE_URL" -e "describe orders;"

# Postgres
psql "$YZ_DATABASE_URL" -c "\dt"
psql "$YZ_DATABASE_URL" -c "\d orders"
```

For each table you intend to sync, write down:

| Question | Why it matters |
|---|---|
| What's the primary key, and is it an integer, a uuid, or composite? | Decides `identity` and the cursor type |
| Is there a reliable `updated_at` / `modified_at`? | Decides whether edits can be captured at all |
| Roughly how many rows? | Sets expectations for the first backfill |
| Are there soft-delete flags (`is_deleted`, `status`)? | Probably belongs in `where` |

### 3. Create the target table in YENES

Columns are up to you. The sync copies what exists on both sides and ignores
the rest, so adding a column later is enough to start pulling that field — no
code change.

```sql
create table yz_orders (
  id          bigint primary key,
  order_no    text,
  order_date  timestamptz,
  grand_total numeric,

  -- optional but recommended, see "Metadata columns"
  _source      text,
  _source_id   text,
  _source_table text,
  _synced_at   timestamptz
);
```

> **RLS:** these tables live in the same Supabase project the public dashboard
> reads with a publishable key. If you turn RLS off, their contents are readable
> by anyone who views the page source. Leave RLS on unless the data is meant to
> be public.

### 4. Pick the cursor

This is the decision that most affects correctness.

| Source has | Use | Catches edits? |
|---|---|---|
| auto-increment integer id | `{ column: "id", type: "numeric" }` *(the default)* | No — inserts only |
| **reliable** `updated_at` | `{ column: "updated_at", type: "timestamp", tiebreak: "id" }` | **Yes** |
| a key that always increases with insert order | `{ column: "k", type: "text" }` | No — inserts only |

### ⚠️ Never use a random UUID as the cursor

**A cursor column must increase with insert order.** Paging works by asking
"give me rows after the last one I saw" — if new rows don't sort *after* the
ones already synced, they are invisible.

A v4 UUID is random, so it fails this completely:

1. The first backfill walks the whole table and parks the cursor at the largest
   uuid it saw — something like `ffff52ed-…`.
2. Every row inserted afterwards gets a *random* uuid, which is almost always
   **smaller** than that.
3. `where id > 'ffff52ed-…'` matches nothing. The table syncs once, reports
   success forever, and never updates again.

This is not hypothetical — it's what happened to the YZ tables here, and
`test/uuid-cursor.test.mts` reproduces it: **0 of 500** new rows picked up with
a uuid cursor, **500 of 500** with a timestamp cursor.

If your table has a uuid primary key, page on a timestamp and use the uuid as
the tiebreaker:

```ts
identity: "id",
cursor: { column: "updated_at", type: "timestamp", tiebreak: "id" },
```

`type: "text"` is only safe for keys that genuinely ascend with insertion —
ULIDs, KSUIDs, Snowflake ids, or a zero-padded sequence. If you're unsure,
use a timestamp.

**Recovering a table that's already stuck on a uuid cursor:** change the cursor,
then clear the position so it re-scans. Re-importing is safe — every write is an
upsert — just slow.

```sql
update sync_state set cursor_value = null, cursor_key = null
 where source_key = 'yz';
```

The timestamp cursor is the only one that picks up changes to rows that were
already synced. It pages on `(updated_at, identity)` together, so rows sharing
one timestamp are never skipped and never loop — there's a test for exactly
that with 25 rows on a single timestamp.

Only use it if the source really does maintain the column on every write. The
legacy database does not, which is why its tables page on `id` and are
insert-only.

### 5. Map the columns

If the names already match on both sides, omit `columns` entirely — matching
names are copied, everything else is ignored.

If they don't, list them `{ sourceColumn: "targetColumn" }`. Once you provide
`columns`, **only** those columns are copied.

```ts
columns: {
  order_uuid:   "source_ref",
  order_number: "order_no",
  placed_at:    "order_date",
  total_amount: "grand_total",
}
```

### 6. Set the conflict key

`conflictKey` is what makes a row "the same row" on the next sync. Default
`["id"]`.

- Strategy A (separate tables): leave the default if your target has `id`.
- Strategy B (shared table): use `["_source", "_source_id"]`.

**The columns in `conflictKey` must have a unique or primary key constraint in
YENES**, or Postgres rejects the insert. The sync checks that it will actually
write those columns and skips the table with a clear message if not, but it
cannot check your constraints for you.

### 7. Deploy and watch the first run

```bash
cd sync
npm install
npm run check      # type-check + tests
npm run deploy
```

Open the task in the Trigger.dev dashboard and hit **Test** rather than waiting
for the schedule. The first lines should be `Connected to YENES` and
`YZ: connected, N table(s) to sync`.

The first run backfills and it may be large. Each run works to a 25-minute
budget, saves its position, and stops; the next continues. Trigger it manually
a few times until the row counts stop climbing.

---

## Rules that must not be broken

1. **Never change a source's `key` once data has been synced.** It's written
   into `_source` and into the `sync_state` bookkeeping. Renaming it makes the
   sync think it has never run (full re-copy) and leaves old rows tagged with a
   name nothing produces any more.

2. **Never point two sources at the same target with `conflictKey: ["id"]`.**
   Both will claim the same ids and overwrite each other's rows, silently. Use
   `["_source", "_source_id"]` for any shared table.

3. **Never map two different source columns to the same target column.** The
   last one wins, unpredictably.

4. **Don't put reconciliation logic in the sync.** Land the raw rows; join in a
   view. A wrong view is fixable in seconds; a wrong import is not.

5. **`where` is interpolated into SQL as written.** It must be a literal you
   typed, never built from user input.

6. **Keep source credentials read-only.** Nothing here should ever need write
   access to LEGACY or YZ.

---

## Metadata columns

Add any of these to a target table and the sync fills them in. Leave them out
and nothing changes — they're entirely opt-in, which is why the existing
`legacy_*` tables keep working untouched.

| Column | Type | Contents |
|---|---|---|
| `_source` | `text` | The source key, e.g. `legacy`, `yz` |
| `_source_id` | `text` | The row's `identity` value on that source, as text |
| `_source_table` | `text` | The table it was read from |
| `_synced_at` | `timestamptz` | When the sync last wrote this row |

`_source` + `_source_id` together are what make a shared table safe, and they
make "where did this row come from?" answerable months later. Adding them costs
nothing; skipping them limits you to Strategy A.

---

## Merging

Once both sources are landing, join them in a view. Nothing below is created
for you — these are the patterns.

**Stack two landing tables into one shape:**

```sql
create or replace view all_customers as
  select 'legacy' as source, id::text as source_id, full_name, email
    from legacy_customers
  union all
  select 'yz', _source_id, full_name, email
    from yz_customers;
```

**Prefer one source when a row exists in both** (here: matching email, legacy
wins):

```sql
create or replace view customers_master as
  select distinct on (lower(email))
         source, source_id, full_name, email
    from all_customers
   where email is not null
   order by lower(email),
            case source when 'legacy' then 0 else 1 end;   -- precedence
```

**Feed the dashboard.** The dashboard reads `dashboard_sales` and
`expense_entry` (see `../README.md`). To surface merged data there, either
point it at a new view via `src/data/schema.js` → `TABLE_NAME`, or write into
`dashboard_sales` from a scheduled SQL job. Keep the landing tables raw either
way.

If a merged view gets slow, make it a materialized view refreshed on a
schedule — the dashboard polls every 5 minutes, so freshness to the minute is
plenty.

---

## Reference: every option

```ts
{
  source: "sales_order",       // table name on the source          (required)
  target: "yz_orders",         // table name in YENES               (required)

  identity: "order_uuid",      // uniquely identifies a source row  (default "id")

  cursor: {                    // how to page  (default { column: identity, type: "numeric" })
    column: "updated_at",
    type: "timestamp",         // "numeric" | "text" | "timestamp"
    tiebreak: "order_uuid",    // timestamp only (default: identity)
  },

  conflictKey: ["_source", "_source_id"],   // default ["id"]

  columns: {                   // omit to copy same-named columns
    order_number: "order_no",
    total_amount: "grand_total",
  },

  where: "status <> 'draft'",  // extra filter, source dialect, literal only
  pageSize: 1000,              // default 1000
  enabled: true,               // false = keep the mapping, stop syncing
}
```

---

## When something goes wrong

The run fails loudly with the reason. Every message below is a **skip** — the
table is left alone and the rest of the sync continues.

| Message | What it means |
|---|---|
| `table "X" does not exist in YENES yet` | Create the target table; it syncs next run |
| `table "X" was not found on <source>` | Typo in `source`, or the read user can't see it |
| `have no column names in common` | Schemas differ — add a `columns` map |
| `none of the mapped columns exist on both sides` | Every entry in `columns` is wrong; re-check with `describe` |
| `cursor column "X" does not exist` | Wrong `cursor.column` |
| `identity column "X" does not exist` | Wrong `identity` |
| `has no "id" column to match rows on` | Target has no `id`; set `conflictKey` explicitly |
| `conflictKey [...] includes [...] which the sync never writes` | Add those columns to `columns`, or add `_source`/`_source_id` to the target |
| `cursor "X" did not advance` | The cursor column isn't unique/ordered enough — switch to `timestamp` with a tiebreak |

Connection-level problems:

| Message | Fix |
|---|---|
| `Could not connect to your Supabase Postgres` | You're using the direct connection string. Switch to Session pooler. |
| `Could not connect to <source>` | Check the URL, and that the host allows Trigger.dev's IPs |
| `<X>_DATABASE_URL is not set` | Missing env var in the Trigger.dev project settings |
| `connected but no tables mapped yet` | Expected until you add entries to `tables` |

---

## Things to know

- **New rows, not edits — unless you use a timestamp cursor.** With `numeric`
  or `text` cursors, rows are matched on `cursor > last_seen`, so new records
  arrive but changes to existing ones don't. Treat imported data as
  correct-as-of-import.

- **Deletes are never propagated.** No source here has a deletion log. A row
  deleted upstream stays in YENES. If that matters, add an `is_deleted` column
  upstream and sync it, or reconcile periodically.

- **To re-pull a table from scratch:**

  ```sql
  update sync_state set cursor_value = null, cursor_key = null
   where source_key = 'yz' and target_table = 'yz_orders';
  ```

  Re-importing is safe — every write is an upsert — just slow.

- **`sync_state` replaced `sync_watermarks`.** The old table was keyed by target
  table alone, which can't tell two sources apart. Positions were copied across
  automatically on first run; the old table is no longer read or written and can
  be dropped once you've seen a good run:

  ```sql
  drop table if exists sync_watermarks;
  ```

- **The task id is still `legacy-sync`** even though it now handles several
  sources. That's deliberate: the deployed schedule is attached to that id, and
  renaming it would orphan the schedule.

- **MySQL zero-dates** (`0000-00-00`) become `NULL`, since Postgres rejects them.

- **A page that fails to write doesn't advance the cursor**, so it's retried next
  run rather than silently skipped.
