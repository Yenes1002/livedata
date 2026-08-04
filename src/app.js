/* =====================================================================
   APP — 组装：建 store，挂组件，跑第一次刷新

   每个组件只做两件事：
   1. 挂载时把自己的静态 DOM 建好、事件绑好
   2. 订阅 store，在数据到达时更新已有节点（而不是整块重画）
   ===================================================================== */
import { createStore } from "./data/store.js";
import { mountStatusBar } from "./components/status-bar.js";
import { mountHeader } from "./components/header.js";
import { mountFilterBar } from "./components/filter-bar.js";
import { mountKpi } from "./components/kpi.js";
import { mountRanking } from "./components/ranking.js";
import { mountPerfTable } from "./components/perf-table.js";

function boot() {
  const store = createStore();

  mountStatusBar({ store });
  mountHeader({ store, onRefreshDue: () => store.refresh() });
  mountFilterBar({ store });
  mountKpi({ store });
  mountRanking({ store });
  mountPerfTable({ store });

  // 标签页重新可见时，如果已经超过一个刷新周期就立刻补一次
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const { lastRefresh } = store.getState();
    if (!lastRefresh) return;
    if (Date.now() - lastRefresh.getTime() > 60_000) store.refresh();
  });

  store.refresh();

  // 方便在 devtools 里手动戳
  window.__dashboard = { store };
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
