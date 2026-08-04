/* =====================================================================
   Main integration test: real Supabase-shaped data → aggregation → render
   → refresh diffing → interactions.
   ===================================================================== */
import {
  assertAnimeVersionPinned, stageSrc, bootDom, settle, createChecks, cleanStage,
} from "./harness.mjs";
import { buildSalesRows, createSupabaseStub, BRANDS } from "./fixtures.mjs";

const { check, report } = createChecks();

const animeVersion = assertAnimeVersionPinned();
check("anime.js version pinned consistently (CDN URL === node_modules)", !!animeVersion, "");

const rangeCalls = {};
let scale = 0;

const stage = stageSrc({ instrumentFlash: true });
const { window, store, errors, consoleErrors, q, qa } = await bootDom({
  stage,
  supabase: createSupabaseStub({ scale: () => scale, rangeCalls }),
});

await store.refresh();
await settle(300);

/* ---------------- data correctness ---------------- */
const s1 = store.getState();

check("store reached ready", s1.status === "ready", `status=${s1.status} err=${s1.error?.message}`);
check("dashboard_sales was paged (>1 request)", (rangeCalls.dashboard_sales || []).length >= 3,
      `range calls = ${JSON.stringify(rangeCalls.dashboard_sales)}`);
check("all 5 brands aggregated", s1.data.projects.length === 5,
      `got ${s1.data.projects.length}: ${s1.data.projects.map((p) => p.project_name)}`);

const allRows = buildSalesRows(0);
const kept = allRows.filter((r) => r.order_status !== "cancelled");
const inRange = kept.filter((r) => r.order_date >= "2026-07-26");
const expectedOrders = new Set(inRange.map((r) => r.order_no)).size;
const expectedSales = +inRange.reduce((a, r) => a + r.grand_total, 0).toFixed(2);

check("total_orders matches the un-truncated row set", s1.data.overall.total_orders === expectedOrders,
      `dashboard=${s1.data.overall.total_orders} expected=${expectedOrders}`);
check("total_sales matches the un-truncated row set",
      Math.abs(s1.data.overall.total_sales - expectedSales) < 0.02,
      `dashboard=${s1.data.overall.total_sales} expected=${expectedSales}`);
check("cancelled orders excluded",
      s1.data.overall.total_orders < new Set(kept.map((r) => r.order_no)).size + 1 &&
      expectedOrders < new Set(allRows.filter(r => r.order_date >= "2026-07-26").map(r => r.order_no)).size);
check("ads_spent attributed to every project", s1.data.projects.every((p) => p.ads_spent > 0),
      JSON.stringify(s1.data.projects.map((p) => [p.project_name, p.ads_spent])));
check("ROME computed per project", s1.data.projects.every((p) => p.roas > 0));
check("internal/external classified", s1.data.projects.filter((p) => p.project_type === "internal").length === 3,
      JSON.stringify(s1.data.projects.map((p) => [p.project_name, p.project_type])));
check("daily series covers the 5 in-range days", s1.data.series.length === 5,
      `got ${s1.data.series.length}: ${s1.data.series.map((d) => d.date)}`);
check("previous period aggregated separately", s1.data.overallPrev.total_sales > 0,
      JSON.stringify(s1.data.overallPrev));

/* ---------------- render ---------------- */
check("hero value rendered", /\d/.test(q("#heroValue").textContent), `"${q("#heroValue").textContent}"`);
check("3 KPI cards rendered", qa("#kpiGrid .kpi-card").length === 3, `got ${qa("#kpiGrid .kpi-card").length}`);
check("KPI values all populated", qa("#kpiGrid [data-role=value]").every((e) => /\d/.test(e.textContent)),
      qa("#kpiGrid [data-role=value]").map((e) => e.textContent).join(" | "));
check("internal ranking rows", qa("#internalRanking .rank-row").length === 3);
check("external ranking rows", qa("#externalRanking .rank-row").length === 2);
check("table rows rendered", qa("#perfTableBody tr").length === 5);
check("sortable headers", qa("#perfTableHead .sort-th").length === 6);
check("sparkline path drawn", (q(".spark-line")?.getAttribute("d") || "").startsWith("M"));
check("countdown ring initialised", !!q("#countdownRing").style.strokeDasharray);
check("status label LIVE", q("#statusLabel").textContent === "LIVE", q("#statusLabel").textContent);
check("quick presets rendered", qa("#filterPresets [data-preset]").length === 3);
check("project dropdown populated", qa("#filterProject option").length === BRANDS.length + 1,
      `got ${qa("#filterProject option").length}`);

/* ---------------- second refresh: diffing ---------------- */
scale = 5; // shifts grand_total so values move
await store.refresh();
await settle(400);
const s2 = store.getState();

check("second refresh ready", s2.status === "ready", `status=${s2.status}`);
check("prevData retained for diffing", !!s2.prevData, "prevData is null — diff-driven animation would be dead");
check("values actually changed", s2.data.overall.total_sales !== s1.data.overall.total_sales,
      `${s2.data.overall.total_sales} vs ${s1.data.overall.total_sales}`);

const deltas = qa("#internalRanking .rank-delta").map((e) => e.textContent);
check("rank delta badges rendered", deltas.length === 3, JSON.stringify(deltas));
check("rank deltas computed against prev (not all NEW)", deltas.length > 0 && !deltas.every((t) => t === "NEW"),
      JSON.stringify(deltas));
check("table still 5 rows after reorder", qa("#perfTableBody tr").length === 5);

// flash() is observed through instrumentation — jsdom can't render box-shadow
const flashLog = globalThis.__flashLog || [];
const cellFlashes = flashLog.filter((f) => f.tag === "TD" && f.cell);
check("changed table cells flashed", cellFlashes.length > 0, JSON.stringify(flashLog.slice(0, 6)));
check("flash hit the columns that moved (sales/roas/aov)",
      ["total_sales", "roas", "aov"].every((k) => cellFlashes.some((f) => f.cell === k)),
      JSON.stringify([...new Set(cellFlashes.map((f) => f.cell))]));
check("flash tone reflects direction, never neutral",
      cellFlashes.every((f) => f.tone === "up" || f.tone === "down"),
      JSON.stringify([...new Set(cellFlashes.map((f) => f.tone))]));
check("unchanged columns did NOT flash (ads_spent, total_orders)",
      !cellFlashes.some((f) => f.cell === "ads_spent" || f.cell === "total_orders"),
      JSON.stringify([...new Set(cellFlashes.map((f) => f.cell))]));

/* ---------------- interactions ---------------- */
// renderHead() rebuilds the <th> nodes, so the element must be re-queried
// before each click — a stale reference is detached and won't bubble.
const clickHeader = async (key) => {
  const th = qa("#perfTableHead .sort-th").find((t) => t.dataset.key === key);
  if (!th) throw new Error(`no sortable header for "${key}"`);
  th.dispatchEvent(new window.Event("click", { bubbles: true }));
  await settle(150);
};

await clickHeader("roas");
check("clicking ROME header sorts by it", /ROME/.test(q("#tableSortNote").textContent),
      q("#tableSortNote").textContent);
const roasOrder = qa("#perfTableBody [data-cell=roas]").map((td) => parseFloat(td.textContent));
check("ROME sorted descending", roasOrder.every((v, i, a) => i === 0 || a[i - 1] >= v), JSON.stringify(roasOrder));

await clickHeader("roas");
const roasAsc = qa("#perfTableBody [data-cell=roas]").map((td) => parseFloat(td.textContent));
check("clicking again flips to ascending", roasAsc.every((v, i, a) => i === 0 || a[i - 1] <= v),
      JSON.stringify(roasAsc));

const firstRow = q("#internalRanking .rank-row");
const clickedName = firstRow.dataset.project;
firstRow.dispatchEvent(new window.Event("click", { bubbles: true }));
await settle(400);
const s3 = store.getState();

check("ranking row click sets the project filter", s3.filters.project === clickedName,
      `filters.project=${s3.filters.project} expected=${clickedName}`);
check("dashboard narrowed to one project", s3.data.projects.length === 1, `got ${s3.data.projects.length}`);
check("dropdown synced to the clicked project", q("#filterProject").value === clickedName,
      q("#filterProject").value);
check("filter summary updated", q("#filterSummary").textContent.includes(clickedName),
      q("#filterSummary").textContent);

q("#filterReset").dispatchEvent(new window.Event("click", { bubbles: true }));
await settle(400);
check("reset restores all projects", store.getState().data.projects.length === 5,
      `got ${store.getState().data.projects.length}`);
check("reset clears the project filter", store.getState().filters.project === "all");

/* ---------------- clean bill of health ---------------- */
const realErrors = errors.filter((e) => !/Could not parse CSS|Not implemented/.test(e));
const realConsole = consoleErrors.filter((e) => !/Could not parse CSS|Not implemented/.test(e));
check("no uncaught window errors", realErrors.length === 0, realErrors.join("; "));
check("no console errors", realConsole.length === 0, realConsole.join("; "));

cleanStage();
process.exit(report("MAIN") ? 1 : 0);
