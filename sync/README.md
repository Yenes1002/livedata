# Source databases → your Supabase

A scheduled Trigger.dev job that copies tables from one or more source
databases into your own Supabase.

```
  LEGACY_DATABASE_URL ─┐
                       ├─►  YENES_DATABASE_URL
  YZ_DATABASE_URL     ─┘
```

**This does not touch your dashboard.** Everything it writes is prefixed per
source (`legacy_`, `yz_`), so it can't collide with `dashboard_sales` or
`expense_entry`. `index.html` is unaffected — it keeps reading exactly what it
reads today.

Joining the synced data into your dashboard is a separate job, whenever you
want it. This just gets the data into your database.

> **Adding the second source?** Everything except the table and column mapping
> is already built and tested. Read **[MAPPING.md](MAPPING.md)** — it walks
> through picking a cursor, mapping mismatched columns, and merging two sources
> without them overwriting each other.

---

## Repo layout

```
index.html     your dashboard — still what Vercel serves
src/           the dashboard's JS modules (see ../README.md)
sync/          this folder. Vercel ignores it; it only runs on Trigger.dev
  sources.ts     ← what gets synced. The only file you normally edit.
  MAPPING.md     ← how to add a source / map columns / merge
  lib/           connections, paging, bookkeeping, upserts
  trigger/       the scheduled task itself
  test/          npm test — 53 checks against real Postgres (PGlite)
```

Nothing changes on the Vercel side — no env vars, no build settings. The page
talks to Supabase directly, the sync writes to Supabase separately, and the two
never talk to each other.

---

## What you need from Marcus

- **Read-only MySQL credentials** (`LEGACY_DATABASE_URL`)
- **Read-only credentials for YZ** (`YZ_DATABASE_URL`), when you're ready for it
- The **project ref** for your Trigger.dev project

## Setup

### 1. Create the destination tables

In Supabase → SQL Editor. The columns are up to you — the sync copies whatever
exists on both sides and ignores the rest, so to pull an extra field, just add
that column using the same name the legacy table uses. No code change needed.

```sql
create table legacy_orders (
  id             bigint primary key,
  order_no       text,
  order_date     timestamptz,
  customer_id    bigint,
  grand_total    numeric,
  order_status   text,
  payment_status text
);

create table legacy_customers (
  id        bigint primary key,
  full_name text,
  phone_no  text,
  email     text
);
```

Each table needs `id bigint primary key` — that's what rows are matched on.
Create only the tables you actually want; the job logs a warning and skips any
that don't exist yet.

You don't need to create `sync_state`; the job creates its own bookkeeping
table and carries over any position from the older `sync_watermarks` table.

> **RLS:** these tables live in the same Supabase project your public dashboard
> reads with a publishable key. If you turn RLS off on them, their contents are
> readable by anyone who views the page source. Leave RLS on unless you intend
> the data to be public.

### 2. Point at your Trigger.dev project

`trigger.config.ts`:

```ts
project: "proj_...",   // your project ref
```

### 3. Set the environment variables

Trigger.dev dashboard → your project → **Settings → Environment Variables →
Production**:

| Key | Value |
|---|---|
| `LEGACY_DATABASE_URL` | `mysql://user:password@host:3306/database` |
| `YENES_DATABASE_URL` | your Supabase connection string |

For Supabase, use the **Session pooler** string (Connect → Session pooler), not
"Direct connection" — direct is IPv6-only and won't resolve from Trigger.dev's
workers. This is the most common reason the job can't connect.

### 4. Deploy

```bash
cd sync
npm install
npx trigger.dev@latest login
npm run deploy
```

Then open the task in the dashboard and hit **Test** to run it immediately
rather than waiting for the schedule. The first log line should be
`Connected to both databases`.

---

## Schedule

Set in `trigger/sync.ts` — **hourly at :30, skipping 4am, 12pm and 5pm**:

```
30 0-3,5-11,13-16,18-23 * * *     Asia/Kuala_Lumpur
```

Those three hours are when the portal's own pipeline reads the same legacy
database, and its runs can take up to 30 minutes — so the whole hour is skipped
rather than just the hour mark. Works out to 21 runs a day.

To change the cadence, edit the pattern and redeploy. To control it from the UI
instead, delete the `cron` block and add the schedule under **Schedules → New
schedule**.

---

## First run

The first run backfills everything, and it's a lot (~900k customers, plus
orders). Each run works to a 25-minute budget, saves its position, and stops;
the next continues from there. Trigger it manually a few times in a row until
the row counts stop climbing.

## If something goes wrong

The job fails loudly with the reason. The usual ones:

| Message | Fix |
|---|---|
| `Could not connect to your Supabase Postgres` | You're using the direct connection string. Switch to Session pooler. |
| `Could not connect to the legacy MySQL database` | Check the credentials with Marcus, and that the legacy host allows Trigger.dev's IPs. |
| `Skipping X: table "legacy_…" does not exist` | Create it, or remove that entry from `sources.ts`. |
| `... is not set` | The env var is missing in the Trigger.dev project settings. |

[MAPPING.md](MAPPING.md) has the full table of skip messages and what each one
means.

## Things to know

- **The legacy tables sync new rows, not edits.** They're matched on
  `id > last_synced`, so new records arrive but changes to existing ones don't.
  That's a limitation of the legacy database — its `last_modified` column isn't
  reliably maintained. Treat imported data as correct-as-of-import.

  A source that *does* maintain an `updated_at` reliably can use a timestamp
  cursor and pick up edits too — see [MAPPING.md](MAPPING.md).

  To re-pull a table from scratch:

  ```sql
  update sync_state set cursor_value = null, cursor_key = null
   where source_key = 'legacy' and target_table = 'legacy_customers';
  ```

- **Sources are isolated.** If one source is down or misconfigured, the others
  still sync; the run then fails at the end so the problem is visible rather
  than silent.
- MySQL zero-dates (`0000-00-00`) become `NULL`, since Postgres rejects them.
- A page that fails to write doesn't advance the cursor, so it's retried next
  run rather than silently skipped.
