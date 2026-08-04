/* =====================================================================
   RANKING — Internal / External Top 10

   新增的交互：
   · 排名变动时用 FLIP 把行从旧位置滑到新位置（不是整块重画）
   · 每行显示升降几位（▲2 / ▼1 / NEW）
   · 占比条按「占该榜第一名的比例」填充，宽度带动画
   · 点某一行 = 把该项目设成筛选条件；再点一次取消
   ===================================================================== */
import { fmtValue, esc } from "../lib/format.js";
import { rankMap } from "../data/store.js";
import { MOTION, animate, flip, animateBar, reveal } from "../lib/motion.js";

const TOP_N = 10;

function rankBadgeClass(i) {
  if (i === 0) return "rank-1";
  if (i === 1) return "rank-2";
  if (i === 2) return "rank-3";
  return "rank-n";
}

/** 升降标记 */
function deltaHTML(prevRank, curRank) {
  if (prevRank === null || prevRank === undefined) {
    return `<span class="rank-delta is-new">NEW</span>`;
  }
  const diff = prevRank - curRank; // 正数 = 上升
  if (diff === 0) return `<span class="rank-delta is-flat">–</span>`;
  if (diff > 0) return `<span class="rank-delta is-up">▲${diff}</span>`;
  return `<span class="rank-delta is-down">▼${Math.abs(diff)}</span>`;
}

function rowHTML(p, i, prevRank, sharePct) {
  return `
    <div class="rank-row" data-flip-key="${esc(p.project_name)}" data-project="${esc(p.project_name)}"
         role="button" tabindex="0" title="点击筛选此项目">
      <div class="rank-badge ${rankBadgeClass(i)}">${i + 1}</div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <p class="text-sm font-medium truncate">${esc(p.project_name)}</p>
          ${deltaHTML(prevRank, i)}
        </div>
        <p class="text-xs font-mono" style="color:var(--text-low)">${fmtValue(p.total_orders, "int")} orders</p>
        <div class="progress-track mt-1.5 h-1">
          <div class="progress-fill h-full" data-role="bar" data-share="${sharePct.toFixed(2)}" style="width:0%"></div>
        </div>
      </div>
      <p class="font-mono text-sm font-semibold shrink-0">${fmtValue(p.total_sales, "currency")}</p>
    </div>`;
}

function renderList(host, list, prevRanks) {
  const top = [...list]
    .sort((a, b) => (b.total_sales ?? -Infinity) - (a.total_sales ?? -Infinity))
    .slice(0, TOP_N);

  if (!top.length) {
    host.innerHTML = `<p class="text-sm" style="color:var(--text-mid)">暂无数据</p>`;
    return;
  }

  const leader = top[0].total_sales || 0;

  flip(host, () => {
    host.innerHTML = top
      .map((p, i) => {
        const share = leader > 0 ? (p.total_sales / leader) * 100 : 0;
        return rowHTML(p, i, prevRanks ? prevRanks.get(p.project_name) ?? null : undefined, share);
      })
      .join("");
  });

  // 占比条：错开一点填充
  host.querySelectorAll('[data-role="bar"]').forEach((bar, i) => {
    animateBar(bar, Number(bar.dataset.share), { delay: i * 40 });
  });
}

export function mountRanking({ store }) {
  const section = document.getElementById("rankingSection");
  const internalPanel = document.getElementById("internalPanel");
  const externalPanel = document.getElementById("externalPanel");
  const internalHost = document.getElementById("internalRanking");
  const externalHost = document.getElementById("externalRanking");
  const internalTitle = document.getElementById("internalTitle");

  /* ---- 点击某行 = 筛选该项目 ---- */
  function bindRowClicks(host) {
    const trigger = (row) => {
      const name = row?.dataset.project;
      if (!name) return;
      const cur = store.getState().filters.project;
      const next = cur === name ? "all" : name;
      if (MOTION.enabled) {
        animate(row, { scale: [1, 0.97, 1], duration: 280, ease: MOTION.ease.soft });
      }
      store.setFilters({ project: next });
    };

    host.addEventListener("click", (e) => trigger(e.target.closest(".rank-row")));
    host.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        trigger(e.target.closest(".rank-row"));
      }
    });
  }
  bindRowClicks(internalHost);
  bindRowClicks(externalHost);

  store.subscribe((state, reason) => {
    if (reason !== "data") return;

    const { projects } = state.data;
    const prevProjects = state.prevData?.projects;

    const hasClassification = projects.some(
      (p) => p.project_type === "internal" || p.project_type === "external"
    );

    if (hasClassification) {
      section.className = "grid grid-cols-1 xl:grid-cols-2 gap-4";
      externalPanel.classList.remove("hidden");
      internalTitle.textContent = "Internal Ranking · Top 10";

      const internal = projects.filter((p) => p.project_type === "internal");
      const external = projects.filter((p) => p.project_type === "external");

      renderList(internalHost, internal, prevProjects ? rankMap(prevProjects.filter((p) => p.project_type === "internal")) : null);
      renderList(externalHost, external, prevProjects ? rankMap(prevProjects.filter((p) => p.project_type === "external")) : null);
    } else {
      section.className = "grid grid-cols-1 gap-4";
      externalPanel.classList.add("hidden");
      internalTitle.textContent = "Brand Ranking · Top 10";
      renderList(internalHost, projects, prevProjects ? rankMap(prevProjects) : null);
    }

    // 首次出现时整块错落入场
    if (!prevProjects) {
      reveal(internalHost.querySelectorAll(".rank-row"), { delayStep: 40 });
      reveal(externalHost.querySelectorAll(".rank-row"), { delayStep: 40 });
    }
  });
}
