/* =====================================================================
   DEMO DATA — 没接 Supabase 时用来预览整个 dashboard 长什么样

   固定写死（不是随机生成），这样直接打开文件看到的数字是稳定的。
   接上 Supabase 之后，这些会被真实数据完全覆盖。
   ===================================================================== */
import { pct, localDateStr } from "../lib/format.js";

const RAW = [
  { project_name: "Skindae",                project_type: "internal", total_sales: 98200, prev_total_sales: 87400, ads_spent: 16930, prev_ads_spent: 15200, aov: 142.50, total_orders: 689 },
  { project_name: "Beyoute",                project_type: "internal", total_sales: 81400, prev_total_sales: 79100, ads_spent: 16610, prev_ads_spent: 16900, aov: 128.90, total_orders: 632 },
  { project_name: "Masternerve",            project_type: "internal", total_sales: 76900, prev_total_sales: 58200, ads_spent: 12400, prev_ads_spent: 11800, aov: 98.40,  total_orders: 781 },
  { project_name: "Agency A - KOL Live",    project_type: "external", total_sales: 71600, prev_total_sales: 64300, ads_spent: 14040, prev_ads_spent: 13100, aov: 118.70, total_orders: 603 },
  { project_name: "Agency B - Affiliate",   project_type: "external", total_sales: 63500, prev_total_sales: 65100, ads_spent: 14430, prev_ads_spent: 14100, aov: 134.20, total_orders: 473 },
  { project_name: "Agency C - FB Ads",      project_type: "external", total_sales: 52100, prev_total_sales: 47800, ads_spent: 13360, prev_ads_spent: 12900, aov: 121.60, total_orders: 428 },
  { project_name: "Agency D - Marketplace", project_type: "external", total_sales: 44800, prev_total_sales: 46200, ads_spent: 14000, prev_ads_spent: 13700, aov: 96.30,  total_orders: 465 },
  { project_name: "Agency E - Influencer",  project_type: "external", total_sales: 38700, prev_total_sales: 32900, ads_spent: 13340, prev_ads_spent: 12200, aov: 143.90, total_orders: 269 },
  { project_name: "Agency F - Livestream",  project_type: "external", total_sales: 34200, prev_total_sales: 35700, ads_spent: 9860,  prev_ads_spent: 10100, aov: 88.50,  total_orders: 386 },
  { project_name: "Agency G - SEM",         project_type: "external", total_sales: 29500, prev_total_sales: 26100, ads_spent: 8420,  prev_ads_spent: 7900,  aov: 167.30, total_orders: 176 },
  { project_name: "Agency H - Content",     project_type: "external", total_sales: 24800, prev_total_sales: 25300, ads_spent: 6790,  prev_ads_spent: 6600,  aov: 79.40,  total_orders: 312 },
  { project_name: "Agency I - Retargeting", project_type: "external", total_sales: 21100, prev_total_sales: 18700, ads_spent: 7150,  prev_ads_spent: 6800,  aov: 71.80,  total_orders: 294 },
];

/** 每次调用都轻微扰动一下，方便看数字滚动 / 排名换位的动画 */
let demoTick = 0;

function genDemoProjects({ jitter = false } = {}) {
  if (jitter) demoTick++;

  return RAW.map((p, i) => {
    // 用确定性的正弦扰动，不用 Math.random —— 刷新时的变化可复现
    const wobble = jitter ? 1 + Math.sin(demoTick * 0.9 + i * 1.7) * 0.06 : 1;
    const total_sales = +(p.total_sales * wobble).toFixed(2);
    const total_orders = Math.round(p.total_orders * wobble);
    const roas = +(total_sales / p.ads_spent).toFixed(2);
    const prevRoas = +(p.prev_total_sales / p.prev_ads_spent).toFixed(2);

    return {
      project_name: p.project_name,
      project_type: p.project_type,
      total_sales,
      total_orders,
      ads_spent: p.ads_spent,
      aov: total_orders ? +(total_sales / total_orders).toFixed(2) : 0,
      roas,
      status: "active",
      // 上一周期的值，算大盘趋势时要用
      _prev: { total_sales: p.prev_total_sales, ads_spent: p.prev_ads_spent, total_orders: p.total_orders },
      trends: {
        ads_spent:    pct(p.ads_spent, p.prev_ads_spent),
        total_sales:  pct(total_sales, p.prev_total_sales),
        roas:         pct(roas, prevRoas),
        aov:          pct(total_orders ? total_sales / total_orders : 0, p.prev_total_sales / p.total_orders),
        total_orders: pct(total_orders, p.total_orders),
      },
    };
  });
}

function sumOverall(projects, salesKey = "total_sales") {
  const sum = (k) => projects.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  const sales = sum(salesKey);
  const ads = sum("ads_spent");
  const orders = sum("total_orders");
  return {
    total_sales: +sales.toFixed(2),
    ads_spent: +ads.toFixed(2),
    roas: ads > 0 ? +(sales / ads).toFixed(2) : null,
    aov: orders ? +(sales / orders).toFixed(2) : 0,
    total_orders: orders,
  };
}

/** 造一条按天的走势，给 Hero 卡的 sparkline 用 */
function genDemoSeries(projects) {
  const total = projects.reduce((a, p) => a + p.total_sales, 0);
  const days = 7;
  const out = [];
  for (let i = 0; i < days; i++) {
    const shape = 0.6 + 0.4 * Math.sin((i / (days - 1)) * Math.PI * 0.9) + i * 0.06;
    out.push({
      date: localDateStr(new Date(), i - (days - 1)),
      total_sales: +((total / days) * shape).toFixed(2),
      total_orders: Math.round((projects.reduce((a, p) => a + p.total_orders, 0) / days) * shape),
    });
  }
  return out;
}

export function genDemoDataset(filters, { jitter = false } = {}) {
  const all = genDemoProjects({ jitter });
  const projects = filters.project === "all"
    ? all
    : all.filter((p) => p.project_name === filters.project);

  const overall = sumOverall(projects);
  // 上一周期：用每个项目自己带的 _prev 反推大盘
  const overallPrev = sumOverall(projects.map((p) => ({ ...p, ...p._prev })));

  return {
    overall,
    overallPrev,
    projects,
    series: genDemoSeries(projects),
    availableBrands: all.map((p) => p.project_name).sort(),
  };
}
