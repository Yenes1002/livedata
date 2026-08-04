/* =====================================================================
   STORE — 单一状态源 + 订阅

   组件不自己拉数据，只订阅 store。每次刷新都保留上一份快照，
   这样动画层能知道「哪个值真的变了、往哪个方向变了、排名升降几位」
   —— 原来的实现是每次 render 都无脑闪一下，看不出信息。
   ===================================================================== */
import { CONFIG, DEMO_MODE } from "../config.js";
import { localDateStr } from "../lib/format.js";
import { fetchDashboardData } from "./fetch.js";

const EMPTY_DATA = {
  overall: {},
  overallPrev: {},
  projects: [],
  series: [],
  availableBrands: [],
};

export function createStore() {
  const listeners = new Set();

  let state = {
    status: "idle",          // idle | loading | ready | error
    error: null,
    filters: {
      start: CONFIG.CAMPAIGN_START_DATE,
      end: localDateStr(),
      project: "all",
    },
    data: EMPTY_DATA,
    prevData: null,          // 上一次成功的数据，用于 diff
    lastRefresh: null,
    refreshCount: 0,
  };

  function emit(reason) {
    for (const fn of listeners) {
      try {
        fn(state, reason);
      } catch (err) {
        console.error("[store] listener 出错：", err);
      }
    }
  }

  let inFlight = null;

  async function refresh() {
    // 已经在拉了就复用同一个请求，避免手动点 Apply 和自动刷新撞在一起
    if (inFlight) return inFlight;

    state = { ...state, status: "loading", error: null };
    emit("loading");

    inFlight = (async () => {
      try {
        const data = await fetchDashboardData(state.filters, {
          // demo 模式下每次刷新轻微扰动，好看清动画
          jitter: DEMO_MODE && state.refreshCount > 0,
        });
        state = {
          ...state,
          status: "ready",
          error: null,
          // 用 refreshCount 判断「之前有没有成功过」，不能用 status ——
          // refresh() 一开始就把 status 设成 loading 了，永远不会等于 ready
          prevData: state.refreshCount > 0 ? state.data : null,
          data,
          lastRefresh: new Date(),
          refreshCount: state.refreshCount + 1,
        };
        emit("data");
      } catch (err) {
        console.error(err);
        state = { ...state, status: "error", error: err };
        emit("error");
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  return {
    getState: () => state,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    refresh,

    setFilters(patch) {
      state = { ...state, filters: { ...state.filters, ...patch } };
      emit("filters");
      return refresh();
    },

    resetFilters() {
      return this.setFilters({
        start: CONFIG.CAMPAIGN_START_DATE,
        end: localDateStr(),
        project: "all",
      });
    },
  };
}

/* ---------------------------------------------------------------------
   DIFF HELPERS — 组件用这些决定「要不要动画、朝哪个方向」
--------------------------------------------------------------------- */

/** 上一份数据里同名项目的排名（0-based），没有则返回 null */
export function rankMap(projects, sortKey = "total_sales") {
  const sorted = [...(projects || [])].sort(
    (a, b) => (b[sortKey] ?? -Infinity) - (a[sortKey] ?? -Infinity)
  );
  return new Map(sorted.map((p, i) => [p.project_name, i]));
}

/** 变化方向：1 涨 / -1 跌 / 0 没变或无从对比 */
export function direction(cur, prev) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return 0;
  if (!Number.isFinite(Number(cur)) || !Number.isFinite(Number(prev))) return 0;
  const delta = Number(cur) - Number(prev);
  if (Math.abs(delta) < 1e-9) return 0;
  return delta > 0 ? 1 : -1;
}
