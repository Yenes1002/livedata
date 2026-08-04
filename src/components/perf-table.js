/* =====================================================================
   PROJECT PERFORMANCE TABLE

   新增的交互：
   · 点表头排序时用 FLIP，让行滑到新位置，看得出谁超过了谁
   · 排序状态存在组件内，不用重新拉数据
   · 数值变化的单元格会闪一下（涨绿跌红）
   · 点行 = 筛选该项目
   ===================================================================== */
import { TABLE_COLUMNS } from "../data/schema.js";
import { fmtValue, trendMeta, esc } from "../lib/format.js";
import { direction } from "../data/store.js";
import { MOTION, animate, flip, flash, reveal } from "../lib/motion.js";

export function mountPerfTable({ store }) {
  const headRow = document.getElementById("perfTableHead");
  const body = document.getElementById("perfTableBody");
  const countEl = document.getElementById("tableCount");
  const sortNote = document.getElementById("tableSortNote");

  let sort = { key: "total_sales", dir: "desc" };
  let projects = [];
  /** 上一次渲染时每个项目每个字段的值，用来判断该不该闪 */
  let lastValues = new Map();

  /* ---- 表头 ---- */
  function renderHead() {
    headRow.innerHTML = TABLE_COLUMNS.map((col) => {
      const isActive = sort.key === col.key;
      const arrow = isActive ? (sort.dir === "asc" ? "▲" : "▼") : "";
      const cls = col.sortable ? "py-2 pr-4 sort-th" : "py-2 pr-4";
      const aria = col.sortable
        ? ` aria-sort="${isActive ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}" tabindex="0" role="button"`
        : "";
      return `<th class="${cls}" data-key="${esc(col.key)}"${aria}>${esc(col.label)} <span style="color:var(--gold-bright)">${arrow}</span></th>`;
    }).join("");

    if (sortNote) {
      const col = TABLE_COLUMNS.find((c) => c.key === sort.key);
      sortNote.textContent = `Sort: ${col ? col.label : sort.key} ${sort.dir === "asc" ? "↑" : "↓"}`;
    }
  }

  function applySort(key) {
    if (sort.key === key) {
      sort = { key, dir: sort.dir === "asc" ? "desc" : "asc" };
    } else {
      sort = { key, dir: "desc" };
    }
    renderHead();
    renderBody({ animateReorder: true, flashChanges: false });
  }

  headRow.addEventListener("click", (e) => {
    const th = e.target.closest(".sort-th");
    if (th) applySort(th.dataset.key);
  });
  headRow.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const th = e.target.closest(".sort-th");
    if (th) { e.preventDefault(); applySort(th.dataset.key); }
  });

  /* ---- 行 ---- */
  function sortedProjects() {
    const { key, dir } = sort;
    return [...projects].sort((a, b) => {
      let av = a[key];
      let bv = b[key];
      if (typeof av === "string" || typeof bv === "string") {
        av = String(av ?? "").toLowerCase();
        bv = String(bv ?? "").toLowerCase();
        return dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      av = av ?? -Infinity;
      bv = bv ?? -Infinity;
      return dir === "asc" ? av - bv : bv - av;
    });
  }

  function trendCellHTML(trendPct) {
    const t = trendMeta(trendPct);
    return `<div class="cell-trend ${t.cls}">${t.icon} ${t.text}</div>`;
  }

  function numericCell(p, col) {
    return `
      <td class="py-2.5 pr-4 font-mono${col.key === "total_sales" ? " font-semibold" : ""}"
          data-cell="${esc(col.key)}">
        ${fmtValue(p[col.key], col.fmt)}
        ${trendCellHTML(p.trends?.[col.key])}
      </td>`;
  }

  function rowHTML(p) {
    const cells = TABLE_COLUMNS.map((col) => {
      if (col.key === "project_name") {
        return `
          <td class="py-2.5 pr-4">
            <span class="font-medium">${esc(p.project_name)}</span>
            <span class="text-xs ml-1" style="color:var(--text-low)">${esc(p.project_type || "")}</span>
          </td>`;
      }
      if (col.key === "status") {
        const status = p.status || "active";
        return `
          <td class="py-2.5 pr-4">
            <span class="status-dot status-${esc(status)}"></span>
            <span class="text-xs capitalize">${esc(status)}</span>
          </td>`;
      }
      return numericCell(p, col);
    }).join("");

    return `<tr data-flip-key="${esc(p.project_name)}" data-project="${esc(p.project_name)}">${cells}</tr>`;
  }

  function renderBody({ animateReorder = true, flashChanges = true } = {}) {
    const rows = sortedProjects();
    countEl.textContent = `${projects.length} project${projects.length === 1 ? "" : "s"}`;

    const doRender = () => { body.innerHTML = rows.map(rowHTML).join(""); };

    if (animateReorder) flip(body, doRender);
    else doRender();

    if (!flashChanges) { snapshotValues(rows); return; }

    // 只闪真的变了的单元格。
    // 直接遍历行、读 dataset，不用属性选择器 —— 项目名里有空格/引号也不会出问题。
    const numericCols = TABLE_COLUMNS.filter((c) => c.numeric);
    const byName = new Map(rows.map((p) => [p.project_name, p]));

    for (const tr of body.children) {
      const p = byName.get(tr.dataset.project);
      const prev = p && lastValues.get(p.project_name);
      if (!p || !prev) continue;
      for (const col of numericCols) {
        const dir = direction(p[col.key], prev[col.key]);
        if (dir === 0) continue;
        const cell = tr.querySelector(`[data-cell="${col.key}"]`);
        if (cell) flash(cell, dir > 0 ? "up" : "down");
      }
    }
    snapshotValues(rows);
  }

  function snapshotValues(rows) {
    lastValues = new Map(
      rows.map((p) => [
        p.project_name,
        Object.fromEntries(TABLE_COLUMNS.filter((c) => c.numeric).map((c) => [c.key, p[c.key]])),
      ])
    );
  }

  /* ---- 点行 = 筛选该项目 ---- */
  body.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-project]");
    if (!tr) return;
    const name = tr.dataset.project;
    const cur = store.getState().filters.project;
    if (MOTION.enabled) {
      animate(tr, { opacity: [1, 0.55, 1], duration: 300, ease: MOTION.ease.soft });
    }
    store.setFilters({ project: cur === name ? "all" : name });
  });

  renderHead();

  store.subscribe((state, reason) => {
    if (reason !== "data") return;
    const isFirst = !state.prevData;
    projects = state.data.projects;
    renderBody({ animateReorder: !isFirst, flashChanges: !isFirst });
    if (isFirst) reveal(body.querySelectorAll("tr"), { delayStep: 26, y: 8 });
  });
}
