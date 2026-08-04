# CTG 巅峰购物嘉年华 · Live Command Center

Live sales dashboard. Reads `dashboard_sales` + `expense_entry` from Supabase
directly in the browser, aggregates into "projects" (by `brand_name`) on the
client, and refreshes every 5 minutes. Animation is driven by
[anime.js v4](https://animejs.com).

No build step. Vercel serves the folder as static files.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:8000
```

```bash
npm test             # integration tests (see test/)
```

### ⚠️ You must serve it over HTTP

The dashboard is split into ES modules, so **opening `index.html` by
double-clicking it does not work** — browsers block `import` over `file://` and
you'll get a blank page plus a CORS error in the console. Use `npm run dev`
(or any static server; `python3 -m http.server 8000` works too).

Deployment is unaffected — Vercel serves over HTTP.

> **Note on `package.json`:** it exists only for local tooling — a dev server
> and the tests. There is deliberately **no `build` script**, so Vercel keeps
> treating this as a static site and just serves the folder. `test/` and
> `sync/` are excluded from deployments via `.vercelignore`.

---

## Layout

```
package.json                dev server + tests only — no build step
index.html                  shell: design tokens, static markup, mount points
src/
  config.js                 Supabase creds, refresh interval, campaign start date
  app.js                    boot: create store, mount components
  lib/
    format.js               number/date formatting, trend maths
    motion.js               ALL animation goes through here (the only anime.js import)
  data/
    schema.js               table + column names, KPI defs, table columns, brand classification
    client.js               Supabase client + paged reads
    demo.js                 sample data for when Supabase isn't connected
    fetch.js                queries + aggregation into projects/KPIs/daily series
    store.js                single state source, snapshot diffing, subscriptions
  components/
    header.js               clock, countdown ring, live pulse, TV mode
    filter-bar.js           date range, quick presets, project select
    kpi.js                  hero card + KPI grid (count-up values)
    sparkline.js            daily sales trend in the hero card
    ranking.js              internal/external Top 10 (FLIP reordering, rank deltas)
    perf-table.js           sortable project table (FLIP re-sort, change flashes)
    status-bar.js           load progress bar, error banner, demo notice
test/
  harness.mjs               boots the real app in jsdom against a stubbed Supabase
  fixtures.mjs              synthetic rows (deliberately >1000, to exercise paging)
  run.mjs                   main integration test
  variants.mjs              fetch failure, demo mode, reduced motion
sync/                       separate Trigger.dev job (legacy MySQL → Supabase). Unrelated to the page.
```

### How a component works

Components don't fetch. Each one builds its DOM once on mount, then subscribes
to the store and **updates existing nodes** when data arrives. That's what makes
the animation possible — values can tween from the old number to the new one,
and rows can slide from their old position instead of being thrown away.

```js
store.subscribe((state, reason) => {
  if (reason !== "data") return;
  // update nodes in place
});
```

`reason` is one of `loading` / `data` / `error` / `filters`.

---

## Configuration

Everything you'd normally change lives in two files:

| What | Where |
|---|---|
| Supabase URL / publishable key | `src/config.js` |
| Refresh interval, campaign start date | `src/config.js` |
| Table + column names | `src/data/schema.js` |
| Which KPIs show, and their format | `src/data/schema.js` → `KPI_DEFS` |
| Table columns | `src/data/schema.js` → `TABLE_COLUMNS` |
| Which brands count as Internal | `src/data/schema.js` → `INTERNAL_BRANDS` |
| Excluded order statuses | `src/data/schema.js` → `EXCLUDED_ORDER_STATUSES` |
| Animation durations / easings | `src/lib/motion.js` → `MOTION` |

Leaving the Supabase values as `YOUR_...` puts the page in **demo mode**: it
renders fixed sample data and shows a notice, so you can work on layout and
motion without a database.

---

## Interaction

| Action | Result |
|---|---|
| Click a ranking row | Filters the whole dashboard to that project; click again to clear |
| Click a table row | Same |
| Click a table header | Sorts; rows animate to their new positions |
| Quick presets | 今天 / 近 7 天 / 活动至今 |
| TV 模式 | Slow auto-scroll for an unattended wall display |
| Countdown ring | Time until the next auto-refresh |

Values count up from their previous number on refresh. Cells flash **green when
they rose, red when they fell**, and stay quiet when nothing changed. Ranking
rows show how many places they moved (`▲2`, `▼1`, `NEW`).

`prefers-reduced-motion: reduce` disables all of it — values jump straight to
their final state.

---

## Tests

```bash
npm test
```

There's no build to check, so the tests boot the **real** module graph in jsdom
— the actual anime.js build resolved from `node_modules` (pinned to the same
version the CDN URL requests, and asserted to match), against a stubbed
Supabase. They cover aggregation correctness, pagination, every render path,
sorting, row-click filtering, refresh diffing, fetch failure, demo mode and
reduced motion.

Two things jsdom genuinely cannot check, so don't read a pass as covering them:

- **Motion itself.** jsdom has no layout, so `getBoundingClientRect()` returns
  zeros and the FLIP reordering is a no-op there.
- **`box-shadow`.** jsdom's computed style returns `""`, so anime skips writing
  it. The change-flash is verified by instrumenting `flash()` instead — the
  tests assert it fires on the right cells with the right direction, not that
  it paints.

Check those two in a browser.

## Notes

- **Rows are paged.** PostgREST caps a request at 1000 rows. `src/data/client.js`
  pages with `.range()` until a short page comes back. Without this, any range
  containing more than 1000 order rows silently produced totals that were too
  low. Raise `CONFIG.MAX_PAGES` if you ever hit the warning in the console.
- **Dates are local, not UTC.** `localDateStr()` formats in the browser's
  timezone. Using `toISOString().slice(0,10)` here would report "yesterday" for
  the first 8 hours of every Malaysian day and drop that day's data.
- **Orders are counted by distinct `order_no`**, since one order can span
  several SKU rows.
- **Ads Spend is joined via `market_id`.** `expense_entry` only records
  `market_id`, so the `market_id → brand_name` mapping is derived from
  `dashboard_sales`. A brand with no orders in the range gets no spend attributed.
- **`status`** is derived: `active` if the project has orders on the most recent
  day in range, otherwise `idle`.
- The publishable key is in client-side source by design — that's what it's for.
  Keep RLS on for every table the page reads.
