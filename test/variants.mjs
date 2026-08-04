/* =====================================================================
   Variant tests: fetch failure, demo mode, prefers-reduced-motion.
   Each boots a fresh jsdom with its own module graph.
   ===================================================================== */
import { stageSrc, bootDom, settle, createChecks, cleanStage } from "./harness.mjs";
import { createFailingStub, createMinimalStub, createSupabaseStub } from "./fixtures.mjs";

const { check, report } = createChecks();

/* ---------------- 1. fetch failure ---------------- */
{
  const { q, store, errors } = await bootDom({
    stage: stageSrc(),
    supabase: createFailingStub(),
  });

  const st = store.getState();
  check("[error] store status = error", st.status === "error", `status=${st.status}`);
  check("[error] banner is visible", !q("#statusBanner").classList.contains("hidden"));
  check("[error] banner names the failing table", /dashboard_sales/.test(q("#statusBanner").textContent),
        q("#statusBanner").textContent);
  check("[error] retry button offered", !!q("#statusRetry"));
  check("[error] status label = ERROR", q("#statusLabel").textContent === "ERROR", q("#statusLabel").textContent);
  check("[error] last-refresh shows failure", /失败/.test(q("#lastRefresh").textContent),
        q("#lastRefresh").textContent);
  check("[error] page shell still renders", !!q("#kpiHero") && !!q("#perfTableBody"));
  check("[error] no uncaught errors", errors.length === 0, errors.join("; "));
}

/* ---------------- 2. demo mode ---------------- */
{
  const { q, qa, store, errors, consoleErrors } = await bootDom({
    stage: stageSrc({ demo: true }),
    supabase: createMinimalStub(),
  });

  const st = store.getState();
  check("[demo] status ready", st.status === "ready", `status=${st.status} ${st.error?.message}`);
  check("[demo] 12 sample projects", st.data.projects.length === 12, `got ${st.data.projects.length}`);
  check("[demo] banner explains demo mode", /DEMO MODE/.test(q("#statusBanner").textContent),
        q("#statusBanner").textContent);
  check("[demo] hero value populated", /\d/.test(q("#heroValue").textContent), q("#heroValue").textContent);
  check("[demo] internal ranking = 3", qa("#internalRanking .rank-row").length === 3);
  check("[demo] external ranking = 9", qa("#externalRanking .rank-row").length === 9,
        `got ${qa("#externalRanking .rank-row").length}`);
  check("[demo] table shows 12 rows", qa("#perfTableBody tr").length === 12);
  check("[demo] sparkline drawn", (q(".spark-line")?.getAttribute("d") || "").startsWith("M"));
  check("[demo] no console errors", consoleErrors.length === 0, consoleErrors.join("; "));

  const before = st.data.overall.total_sales;
  await store.refresh();
  await settle(300);
  check("[demo] refresh jitters values (so motion is visible)",
        store.getState().data.overall.total_sales !== before,
        `${store.getState().data.overall.total_sales} vs ${before}`);
  check("[demo] prevData set on 2nd refresh", !!store.getState().prevData);
  check("[demo] no uncaught errors", errors.length === 0, errors.join("; "));
}

/* ---------------- 3. prefers-reduced-motion ---------------- */
{
  const { q, qa, store, errors, consoleErrors } = await bootDom({
    stage: stageSrc(),
    supabase: createSupabaseStub(),
    reduced: true,
  });

  const st = store.getState();
  check("[reduced] status ready", st.status === "ready", `status=${st.status}`);
  check("[reduced] hero value set immediately (no tween)", /\d/.test(q("#heroValue").textContent),
        q("#heroValue").textContent);
  check("[reduced] table rows rendered", qa("#perfTableBody tr").length === 5,
        `got ${qa("#perfTableBody tr").length}`);
  check("[reduced] share bars jump to final width",
        qa("#internalRanking [data-role=bar]").every((b) => b.style.width && b.style.width !== "0%"),
        qa("#internalRanking [data-role=bar]").map((b) => b.style.width).join(","));
  check("[reduced] sparkline shown or empty-state shown",
        !!q(".spark-line")?.getAttribute("d") || q(".spark-empty").style.display !== "none");
  check("[reduced] no uncaught errors", errors.length === 0, errors.join("; "));
  check("[reduced] no console errors", consoleErrors.length === 0, consoleErrors.join("; "));
}

cleanStage();
process.exit(report("VARIANTS") ? 1 : 0);
