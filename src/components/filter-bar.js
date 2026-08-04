/* =====================================================================
   FILTER BAR — 日期范围 + 项目筛选

   新增：
   · 快捷范围（今天 / 近 7 天 / 活动至今）
   · Apply 时按钮有 pending 状态，正在拉数据时禁用
   · 项目下拉跟 store 双向同步（排名/表格里点某行也会更新这里）
   ===================================================================== */
import { CONFIG } from "../config.js";
import { localDateStr, esc } from "../lib/format.js";
import { MOTION, animate } from "../lib/motion.js";

const PRESETS = [
  { id: "today",    label: "今天",     range: () => ({ start: localDateStr(), end: localDateStr() }) },
  { id: "7d",       label: "近 7 天",  range: () => ({ start: localDateStr(new Date(), -6), end: localDateStr() }) },
  { id: "campaign", label: "活动至今", range: () => ({ start: CONFIG.CAMPAIGN_START_DATE, end: localDateStr() }) },
];

export function mountFilterBar({ store }) {
  const startEl = document.getElementById("filterStartDate");
  const endEl = document.getElementById("filterEndDate");
  const projectEl = document.getElementById("filterProject");
  const applyBtn = document.getElementById("filterApply");
  const resetBtn = document.getElementById("filterReset");
  const summaryEl = document.getElementById("filterSummary");
  const presetHost = document.getElementById("filterPresets");

  /* ---- 快捷范围 ---- */
  presetHost.innerHTML = PRESETS.map(
    (p) => `<button class="preset-btn" data-preset="${esc(p.id)}">${esc(p.label)}</button>`
  ).join("");

  presetHost.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
    if (!preset) return;
    const { start, end } = preset.range();
    startEl.value = start;
    endEl.value = end;
    if (MOTION.enabled) animate(btn, { scale: [1, 0.94, 1], duration: 240, ease: MOTION.ease.soft });
    store.setFilters({ start, end });
  });

  /* ---- Apply / Reset ---- */
  applyBtn.addEventListener("click", () => {
    const start = startEl.value || CONFIG.CAMPAIGN_START_DATE;
    const end = endEl.value || localDateStr();

    if (start > end) {
      shake(applyBtn);
      summaryEl.textContent = "开始日期不能晚于结束日期";
      return;
    }
    store.setFilters({ start, end, project: projectEl.value || "all" });
  });

  resetBtn.addEventListener("click", () => store.resetFilters());

  projectEl.addEventListener("change", () => {
    store.setFilters({ project: projectEl.value || "all" });
  });

  /* ---- 跟 store 同步 ---- */
  let lastBrandsKey = "";

  store.subscribe((state, reason) => {
    const { start, end, project } = state.filters;

    startEl.value = start;
    endEl.value = end;

    if (reason === "data") {
      const brands = state.data.availableBrands || [];
      const key = brands.join("|");
      if (key !== lastBrandsKey) {
        lastBrandsKey = key;
        projectEl.innerHTML =
          `<option value="all">All Projects</option>` +
          brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
      }
    }

    // store 是唯一真源：点排名行改了 project，这里跟着变
    if ([...projectEl.options].some((o) => o.value === project)) {
      projectEl.value = project;
    } else {
      projectEl.value = "all";
    }

    // 高亮当前命中的快捷范围
    presetHost.querySelectorAll("[data-preset]").forEach((btn) => {
      const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
      const r = preset?.range();
      btn.classList.toggle("active", !!r && r.start === start && r.end === end);
    });

    const busy = state.status === "loading";
    applyBtn.disabled = busy;
    applyBtn.classList.toggle("is-busy", busy);
    applyBtn.textContent = busy ? "Loading…" : "Apply";

    if (reason === "data" || reason === "filters") {
      summaryEl.textContent = `${start} → ${end} · ${project === "all" ? "All Projects" : project}`;
    }
  });
}

function shake(el) {
  if (!MOTION.enabled) return;
  animate(el, {
    translateX: [0, -6, 6, -4, 4, 0],
    duration: 420,
    ease: "outQuad",
  });
}
