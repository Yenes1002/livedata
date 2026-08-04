# CTG 巅峰购物嘉年华 · Live Command Center

Live sales dashboard. Single self-contained `index.html` — no build step, no
ES modules. Reads OXM2 (`ai_order` + `ai_market` + `ai_brand` +
`ai_expenses_entry`) and OXM1/legacy (`legacy_orders` + `legacy_projects` +
`legacy_page` + `legacy_pagead`) from Supabase directly in the browser, merges
both sources into one project list, and refreshes every 5 minutes.

No build step. Vercel serves the folder as static files.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:8000
```

`index.html` has no `<script type="module">` — it's a single inline script, so
opening it directly with `file://` also works. `npm run dev` (or any static
server) is still the easiest way to see console output alongside the page.

> **Note on `package.json`:** it exists only for local tooling — a dev server.
> There is deliberately **no `build` script**, so Vercel keeps treating this as
> a static site and just serves the folder. `sync/` is excluded from
> deployments via `.vercelignore`.

---

## Layout

```
index.html    everything — markup, styles, Supabase queries, aggregation, rendering
sync/         separate Trigger.dev job (legacy MySQL + YZ Postgres → Supabase). Unrelated to the page.
src/, test/   earlier modular implementation (OXM2-only, ES modules). Superseded by
              index.html above — kept for reference, not deployed, not exercised by any test run.
```

### How it works

`fetchDashboardData()` runs on load and on a 5-minute timer. It pages through
`ai_order` + `ai_expenses_entry` (OXM2) and `legacy_orders` + `legacy_pagead`
(OXM1) for the selected date range, joins `ai_order.market_id → ai_market →
ai_brand.name` and `legacy_orders.project_id → legacy_projects.project_name`
to get a brand/project name for every row, merges both sources into one list,
and re-renders the KPI cards, rankings, and table in place.

---

## Configuration

Everything you'd normally change lives inside `index.html`, near the top of
the `<script>` block:

| What | Where |
|---|---|
| Supabase URL / publishable key | `CONFIG` |
| Refresh interval | `CONFIG.REFRESH_INTERVAL_MS` |
| OXM2 table + column names | `COLUMN_MAP`, `TABLE_NAME`, `MARKET_TABLE_NAME`, `BRAND_TABLE_NAME` |
| Legacy table + column names | `LEGACY_ORDER_COLUMN_MAP`, `LEGACY_ORDERS_TABLE`, `LEGACY_PROJECTS_TABLE`, `LEGACY_PAGE_TABLE`, `LEGACY_PAGEAD_TABLE` |
| Which legacy `project_id`s count at all | `LEGACY_ALLOWED_PROJECT_IDS` — a project not in this list never appears, even with real orders |
| Which OXM2 brands count at all | `OXM2_ALLOWED_BRAND_NAMES` — same deal, for `ai_brand.name` |
| Brands/projects excluded outright | `EXCLUDED_BRAND_NAMES` |
| Same brand, different spelling across legacy projects | `PROJECT_NAME_ALIAS_MAP` |
| Which brands count as Internal | `INTERNAL_BRANDS` |
| Excluded order statuses | `EXCLUDED_ORDER_STATUSES` |
| KPI defs / table columns | `KPI_DEFS`, `TABLE_COLUMNS` |

Leaving the Supabase values as `YOUR_...` puts the page in **demo mode**: it
renders fixed sample data and shows a notice, so you can work on layout without
a database.

**Adding a brand/project that already has real orders but isn't showing up:**
check `LEGACY_ALLOWED_PROJECT_IDS` (legacy) or `OXM2_ALLOWED_BRAND_NAMES`
(OXM2) first — both are manually curated allowlists, not "whatever exists in
the table."

---

## Interaction

| Action | Result |
|---|---|
| Click a table header | Sorts the Project Performance table |
| Date range + Apply | Refetches for that range; picking "today → today" re-enables auto-follow-today |
| Reset to now | Snaps back to today and re-enables auto-follow-today |
| Project filter | Restricts everything to one project/brand |

Values show `▲`/`▼`/`—` vs the previous period of equal length. `status` is
`active` if the project had orders on the most recent day within the selected
range, otherwise `idle`.

---

## Notes

- **Rows are paged.** PostgREST caps a request at 1000 rows; `fetchAllRows()`
  pages with `.range()` until a short page comes back.
- **Dates are local, not UTC.** Date-range boundaries are built as naive
  `YYYY-MM-DDTHH:MM:SS` strings (`toNaiveTimestampString` / `toLocalDateString`),
  never `.toISOString()`. `order_date`/`created_datetime` are
  `timestamp without time zone` columns — Postgres discards any timezone
  info on a value sent to that type, so a UTC-converted string silently shifts
  the boundary by the browser's UTC offset. This bit the OXM2-only version in
  `src/`; don't reintroduce it.
- **Orders are counted by distinct `order_no`**, since one order can span
  several SKU rows. OXM2 order numbers are prefixed `oxm2-` and legacy ones
  `legacy-` before counting, so the two sources can never collide.
- **Ads Spend** combines OXM2 (`ai_expenses_entry`, filtered to the Ads Spend
  `expense_type_id`, joined to a brand via `market_id`) and legacy
  (`legacy_pagead.fb_ad_cost_spent`, adjusted by `legacy_page`'s GST +
  withholding tax percentages, joined to a project via `project_id`).
- **`status`** is derived, not stored: `active` if the project has orders on
  the most recent day in the selected range, otherwise `idle`.
- The publishable key is in client-side source by design — that's what it's
  for. Every table the page reads has RLS enabled with an anon-read-only
  policy; tables it doesn't read (e.g. `legacy_customer`, which has PII) have
  RLS enabled with **no** policy, so the anon key can't touch them.
