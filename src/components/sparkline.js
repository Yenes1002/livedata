/* =====================================================================
   SPARKLINE — Hero 卡里的按天走势
   数据来自 buildDailySeries()，不额外查一次库
   ===================================================================== */
import { fmtValue, esc } from "../lib/format.js";
import { MOTION, animate, drawPath } from "../lib/motion.js";

const W = 260;
const H = 54;
const PAD = 3;

/**
 * 造一个 sparkline 组件。
 * @param {HTMLElement} host 容器
 */
export function createSparkline(host) {
  host.innerHTML = `
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="var(--gold-bright)" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="var(--gold-bright)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="spark-area" fill="url(#sparkFill)" d=""></path>
      <path class="spark-line" fill="none" stroke="var(--gold-bright)" stroke-width="1.75"
            stroke-linecap="round" stroke-linejoin="round" d=""></path>
      <circle class="spark-head" r="2.75" fill="var(--gold-bright)" cx="-10" cy="-10"></circle>
    </svg>
    <div class="spark-empty text-xs" style="color:var(--text-low)">走势数据不足</div>
  `;

  const svg = host.querySelector("svg");
  const lineEl = host.querySelector(".spark-line");
  const areaEl = host.querySelector(".spark-area");
  const headEl = host.querySelector(".spark-head");
  const emptyEl = host.querySelector(".spark-empty");

  let lastSignature = "";

  function update(series, { valueKey = "total_sales" } = {}) {
    const points = (series || []).filter((d) => Number.isFinite(Number(d[valueKey])));

    // 少于 2 个点画不出线
    if (points.length < 2) {
      svg.style.display = "none";
      emptyEl.style.display = "";
      lastSignature = "";
      return;
    }
    svg.style.display = "";
    emptyEl.style.display = "none";

    const signature = points.map((d) => `${d.date}:${d[valueKey]}`).join("|");
    if (signature === lastSignature) return; // 数据没变就不重画
    lastSignature = signature;

    const values = points.map((d) => Number(d[valueKey]));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.abs(max) || 1;

    const x = (i) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = (v) => H - PAD - ((v - min) / span) * (H - PAD * 2);

    const linePath = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
    const areaPath = `${linePath} L${x(values.length - 1).toFixed(2)},${H} L${x(0).toFixed(2)},${H} Z`;

    lineEl.setAttribute("d", linePath);
    areaEl.setAttribute("d", areaPath);

    // 描线动画
    drawPath(lineEl);

    if (MOTION.enabled) {
      animate(areaEl, { opacity: [0, 1], duration: MOTION.dur.slow, ease: MOTION.ease.soft });
    } else {
      areaEl.style.opacity = "1";
    }

    // 末点：跟着线走到最后
    const lastX = x(values.length - 1);
    const lastY = y(values[values.length - 1]);
    if (MOTION.enabled) {
      animate(headEl, {
        cx: lastX,
        cy: lastY,
        opacity: [0, 1],
        duration: MOTION.dur.draw,
        ease: MOTION.ease.inOut,
      });
    } else {
      headEl.setAttribute("cx", String(lastX));
      headEl.setAttribute("cy", String(lastY));
      headEl.style.opacity = "1";
    }

    // 悬停显示某天的数值
    svg.setAttribute(
      "aria-label",
      `${points.length} 天走势，${esc(points[0].date)} 至 ${esc(points[points.length - 1].date)}`
    );
    host.title = points
      .map((d) => `${d.date}  ${fmtValue(d[valueKey], "currency")}`)
      .join("\n");
  }

  return { update };
}
