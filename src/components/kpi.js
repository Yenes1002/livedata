/* =====================================================================
   KPI — Hero 卡（Total Sales + sparkline）+ 其余 KPI 卡

   跟原来最大的区别：卡片只建一次，之后刷新是「更新已有节点」，
   不是每次 innerHTML 重建。这样数字能从旧值滚到新值，
   而且只有真的变了才闪。
   ===================================================================== */
import { KPI_DEFS } from "../data/schema.js";
import { fmtValue, pct, trendMeta, esc } from "../lib/format.js";
import { direction } from "../data/store.js";
import { MOTION, animate, countUp, flash, reveal } from "../lib/motion.js";
import { createSparkline } from "./sparkline.js";

export function mountKpi({ store }) {
  const heroHost = document.getElementById("kpiHero");
  const gridHost = document.getElementById("kpiGrid");

  const [heroDef, ...restDefs] = KPI_DEFS;

  /* ---- Hero ---- */
  heroHost.innerHTML = `
    <p class="eyebrow mb-2">${esc(heroDef.label)}</p>
    <p class="kpi-val font-mono text-4xl font-extrabold leading-none"
       id="heroValue" style="color:var(--gold-bright)">--</p>
    <p class="text-sm mt-2 font-mono flat" id="heroTrend">—</p>
    <div class="mt-3 spark-host" id="heroSpark"></div>
  `;
  const heroValueEl = document.getElementById("heroValue");
  const heroTrendEl = document.getElementById("heroTrend");
  const sparkline = createSparkline(document.getElementById("heroSpark"));

  /* ---- 其余 KPI 卡 ---- */
  gridHost.innerHTML = restDefs
    .map(
      (def) => `
      <div class="panel p-4 kpi-card" data-kpi="${esc(def.key)}">
        <p class="eyebrow mb-2">${esc(def.label)}</p>
        <p class="kpi-val font-mono text-2xl font-bold" data-role="value">--</p>
        <p class="text-xs mt-1 font-mono flat" data-role="trend">—</p>
      </div>`
    )
    .join("");

  const cards = new Map(
    restDefs.map((def) => {
      const el = gridHost.querySelector(`[data-kpi="${def.key}"]`);
      return [def.key, {
        def,
        root: el,
        valueEl: el.querySelector('[data-role="value"]'),
        trendEl: el.querySelector('[data-role="trend"]'),
      }];
    })
  );

  reveal([heroHost, ...gridHost.children], { delayStep: 60 });

  /** 上一次显示过的数值，用来做数字滚动的起点 */
  const shown = new Map();

  function renderTrend(el, changePct) {
    const t = trendMeta(changePct);
    el.classList.remove("up", "down", "flat");
    el.classList.add(t.cls);
    el.innerHTML = `${t.icon} ${t.text} <span class="font-sans" style="color:var(--text-low)">vs previous period</span>`;
  }

  store.subscribe((state, reason) => {
    if (reason !== "data") return;

    const { overall, overallPrev, series } = state.data;

    /* ---- Hero ---- */
    const heroCur = overall[heroDef.key];
    const heroPrevShown = shown.get(heroDef.key);
    countUp(heroValueEl, heroPrevShown, heroCur, (v) => fmtValue(v, heroDef.fmt));
    renderTrend(heroTrendEl, pct(heroCur, overallPrev[heroDef.key]));

    const heroDir = direction(heroCur, heroPrevShown);
    if (heroDir !== 0 && heroPrevShown !== undefined) {
      flash(heroHost, heroDir > 0 ? "up" : "down");
    }
    shown.set(heroDef.key, heroCur);

    sparkline.update(series, { valueKey: heroDef.key });

    /* ---- 其余卡 ---- */
    for (const [key, card] of cards) {
      const cur = overall[key];
      const prevShown = shown.get(key);

      countUp(card.valueEl, prevShown, cur, (v) => fmtValue(v, card.def.fmt));
      renderTrend(card.trendEl, pct(cur, overallPrev[key]));

      const dir = direction(cur, prevShown);
      if (dir !== 0 && prevShown !== undefined) {
        flash(card.root, dir > 0 ? "up" : "down");
        if (MOTION.enabled) {
          animate(card.valueEl, {
            translateY: [dir > 0 ? 6 : -6, 0],
            duration: MOTION.dur.base,
            ease: MOTION.ease.back,
          });
        }
      }
      shown.set(key, cur);
    }
  });
}
