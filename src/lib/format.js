/* =====================================================================
   FORMAT — 数字/日期格式化 + 趋势计算
   ===================================================================== */
import { CONFIG } from "../config.js";

const NUM_2DP = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

/**
 * 按 fmt 类型把原始值格式化成展示字符串。
 * null/undefined 一律显示 "--"，避免出现 "RM NaN"。
 */
export function fmtValue(val, type) {
  if (val === null || val === undefined || (typeof val === "number" && !Number.isFinite(val))) {
    return "--";
  }
  const n = Number(val);
  switch (type) {
    case "currency":
      return CONFIG.CURRENCY_PREFIX + n.toLocaleString(CONFIG.LOCALE, NUM_2DP);
    case "ratio":
      return n.toFixed(2) + "x";
    case "percent":
      return n.toFixed(1) + "%";
    case "int":
      return Math.round(n).toLocaleString(CONFIG.LOCALE);
    default:
      return String(val);
  }
}

/** a 相对 b 的变化百分比；b 为 0 或缺失时返回 null（不是 0，也不是 Infinity） */
export function pct(a, b) {
  if (a === null || a === undefined) return null;
  if (b === null || b === undefined || b === 0) return null;
  return ((a - b) / b) * 100;
}

/** 把变化百分比翻译成图标 / 颜色 class / 文案 */
export function trendMeta(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) {
    return { icon: "—", cls: "flat", text: "No Change", dir: 0 };
  }
  if (p > 0.05) return { icon: "▲", cls: "up", text: `+${p.toFixed(1)}%`, dir: 1 };
  if (p < -0.05) return { icon: "▼", cls: "down", text: `${p.toFixed(1)}%`, dir: -1 };
  return { icon: "—", cls: "flat", text: "No Change", dir: 0 };
}

/**
 * 本地时区的 YYYY-MM-DD。
 * 注意：不能用 toISOString().slice(0,10) —— 那是 UTC，在马来西亚（UTC+8）
 * 早上 8 点之前会算成「昨天」，导致当天的数据被整段漏掉。
 */
export function localDateStr(date = new Date(), offsetDays = 0) {
  const d = new Date(date);
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 本地时间的 HH:MM:SS */
export function localTimeStr(date = new Date()) {
  return date.toLocaleTimeString(CONFIG.LOCALE, { hour12: false });
}

/** mm:ss，给刷新倒计时用 */
export function mmss(totalMs) {
  const totalSec = Math.max(0, Math.round(totalMs / 1000));
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** 项目名来自数据库，插进 innerHTML 前先转义 */
export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
