/* =====================================================================
   FETCH — 拉 dashboard_sales（销售）+ expense_entry（广告花费），
   在前端按 brand_name 汇总成「项目」，并算出上一个等长周期用于趋势对比
   ===================================================================== */
import { DEMO_MODE } from "../config.js";
import { pct, localDateStr } from "../lib/format.js";
import { supabaseClient, fetchAllRows } from "./client.js";
import { genDemoDataset } from "./demo.js";
import {
  TABLE_NAME,
  COLUMN_MAP,
  MARKET_TABLE_NAME,
  BRAND_TABLE_NAME,
  EXCLUDED_ORDER_STATUSES,
  VALID_PAYMENT_STATUSES,
  EXPENSE_TABLE_NAME,
  EXPENSE_COLUMN_MAP,
  ADS_SPEND_EXPENSE_TYPE_ID,
  expenseAmount,
  classifyBrand,
} from "./schema.js";

/**
 * @param {{start:string, end:string, project:string}} filters
 * @returns {Promise<{overall, overallPrev, projects, series, availableBrands}>}
 */
export async function fetchDashboardData(filters, { jitter = false } = {}) {
  if (DEMO_MODE) return genDemoDataset(filters, { jitter });

  const startDate = new Date(filters.start + "T00:00:00");
  const endExclusive = new Date(filters.end + "T00:00:00");
  endExclusive.setDate(endExclusive.getDate() + 1); // 包含 end 当天整天

  // 上一个「等长」周期，紧接在 startDate 之前
  const rangeMs = endExclusive - startDate;
  const prevStart = new Date(startDate.getTime() - rangeMs);
  const prevStartDateStr = localDateStr(prevStart);

  // 一次把当前 + 上一周期都拉回来，后面在内存里切开。
  // market / brand 是小表（几十行），不用分页，直接一次查完。
  const [rawRows, rawExpenseRows, marketRows, brandRows] = await Promise.all([
    fetchAllRows(() => {
      let q = supabaseClient
        .from(TABLE_NAME)
        .select("*")
        .gte(COLUMN_MAP.order_date, prevStart.toISOString())
        .lt(COLUMN_MAP.order_date, endExclusive.toISOString())
        .order(COLUMN_MAP.order_date, { ascending: true });
      if (VALID_PAYMENT_STATUSES.length) {
        q = q.in(COLUMN_MAP.payment_status, VALID_PAYMENT_STATUSES);
      }
      return q;
    }, TABLE_NAME),

    fetchAllRows(() => supabaseClient
      .from(EXPENSE_TABLE_NAME)
      .select("*")
      .eq(EXPENSE_COLUMN_MAP.expense_type_id, ADS_SPEND_EXPENSE_TYPE_ID)
      .gte(EXPENSE_COLUMN_MAP.entry_date, prevStartDateStr)
      .lte(EXPENSE_COLUMN_MAP.entry_date, filters.end)
      .order(EXPENSE_COLUMN_MAP.entry_date, { ascending: true }),
      EXPENSE_TABLE_NAME),

    supabaseClient.from(MARKET_TABLE_NAME).select("id, brand_id")
      .then(({ data, error }) => { if (error) throw new Error(`Supabase 查询失败（${MARKET_TABLE_NAME}）：${error.message}`); return data || []; }),
    supabaseClient.from(BRAND_TABLE_NAME).select("id, name")
      .then(({ data, error }) => { if (error) throw new Error(`Supabase 查询失败（${BRAND_TABLE_NAME}）：${error.message}`); return data || []; }),
  ]);

  // market_id -> brand_name，拼进每一行 ai_order，后面的聚合逻辑就不用再关心这层
  const brandNameById = Object.fromEntries(brandRows.map((b) => [b.id, b.name]));
  const brandNameByMarket = Object.fromEntries(
    marketRows.map((m) => [m.id, brandNameById[m.brand_id] || null])
  );
  for (const r of rawRows) {
    r[COLUMN_MAP.brand_name] = brandNameByMarket[r[COLUMN_MAP.market_id]] || null;
  }

  const rows = rawRows.filter((r) => {
    const status = (r[COLUMN_MAP.order_status] || "").toLowerCase();
    return !EXCLUDED_ORDER_STATUSES.includes(status);
  });

  const currentRows = rows.filter((r) => new Date(r[COLUMN_MAP.order_date]) >= startDate);
  const prevRows = rows.filter((r) => new Date(r[COLUMN_MAP.order_date]) < startDate);

  const availableBrands = [
    ...new Set(currentRows.map((r) => r[COLUMN_MAP.brand_name]).filter(Boolean)),
  ].sort();

  // expense_entry 只按 market_id 记账，要靠 dashboard_sales 建出
  // market_id → brand_name 的对应关系，才能把花费归到具体项目
  const brandToMarket = {};
  for (const r of rows) {
    const brand = r[COLUMN_MAP.brand_name];
    const market = r[COLUMN_MAP.market_id];
    if (brand && market && !brandToMarket[brand]) brandToMarket[brand] = market;
  }

  const currentExpenseRows = rawExpenseRows.filter((r) => r[EXPENSE_COLUMN_MAP.entry_date] >= filters.start);
  const prevExpenseRows = rawExpenseRows.filter((r) => r[EXPENSE_COLUMN_MAP.entry_date] < filters.start);

  const currentAdsByMarket = aggregateAdsSpendByMarket(currentExpenseRows);
  const prevAdsByMarket = aggregateAdsSpendByMarket(prevExpenseRows);

  const isAll = filters.project === "all";
  const selectedMarketId = isAll ? null : brandToMarket[filters.project];

  const filteredCurrentRows = isAll
    ? currentRows
    : currentRows.filter((r) => r[COLUMN_MAP.brand_name] === filters.project);
  const filteredPrevRows = isAll
    ? prevRows
    : prevRows.filter((r) => r[COLUMN_MAP.brand_name] === filters.project);

  // 大盘 Ads Spend：all 时 sum 全部 market，筛了项目就只算那个 market_id
  const sumValues = (obj) => Object.values(obj).reduce((a, v) => a + v, 0);
  const overallCurrentAds = isAll ? sumValues(currentAdsByMarket) : (currentAdsByMarket[selectedMarketId] || 0);
  const overallPrevAds = isAll ? sumValues(prevAdsByMarket) : (prevAdsByMarket[selectedMarketId] || 0);

  const overall = aggregateOverall(filteredCurrentRows, overallCurrentAds);
  const overallPrev = aggregateOverall(filteredPrevRows, overallPrevAds);

  const currentByBrand = aggregateByBrand(filteredCurrentRows);
  const prevByBrand = aggregateByBrand(filteredPrevRows);
  const prevBrandMap = Object.fromEntries(prevByBrand.map((b) => [b.project_name, b]));

  // 「最近有单」= active，否则 idle。原来这里是硬写死 "active"，等于没信息。
  const latestDay = filteredCurrentRows.length
    ? filteredCurrentRows.reduce((max, r) => {
        const d = localDateStr(new Date(r[COLUMN_MAP.order_date]));
        return d > max ? d : max;
      }, "0000-00-00")
    : null;
  const activeBrands = new Set(
    filteredCurrentRows
      .filter((r) => localDateStr(new Date(r[COLUMN_MAP.order_date])) === latestDay)
      .map((r) => r[COLUMN_MAP.brand_name])
  );

  const projects = currentByBrand.map((b) => {
    const y = prevBrandMap[b.project_name];
    const marketId = brandToMarket[b.project_name];
    const adsSpent = marketId ? (currentAdsByMarket[marketId] || 0) : 0;
    const prevAdsSpent = marketId ? (prevAdsByMarket[marketId] || 0) : 0;
    const roas = adsSpent > 0 ? +(b.total_sales / adsSpent).toFixed(2) : null;
    const prevRoas = y && prevAdsSpent > 0 ? +(y.total_sales / prevAdsSpent).toFixed(2) : null;

    return {
      ...b,
      project_type: classifyBrand(b.project_name),
      ads_spent: adsSpent,
      roas,
      status: activeBrands.has(b.project_name) ? "active" : "idle",
      trends: {
        ads_spent:    pct(adsSpent, prevAdsSpent),
        total_sales:  pct(b.total_sales, y ? y.total_sales : null),
        roas:         pct(roas, prevRoas),
        aov:          pct(b.aov, y ? y.aov : null),
        total_orders: pct(b.total_orders, y ? y.total_orders : null),
      },
    };
  });

  return {
    overall,
    overallPrev,
    projects,
    series: buildDailySeries(filteredCurrentRows),
    availableBrands,
  };
}

/* ---------------------------------------------------------------------
   AGGREGATION
--------------------------------------------------------------------- */

/** expense_entry 的 Ads Spend 行按 market_id 汇总 */
function aggregateAdsSpendByMarket(rows) {
  const map = {};
  for (const r of rows) {
    const market = r[EXPENSE_COLUMN_MAP.market_id];
    if (!market) continue;
    map[market] = (map[market] || 0) + expenseAmount(r);
  }
  return map;
}

/** 订单行按 brand_name 汇总成「项目」。orders 用 order_no 去重（一单可能多行 SKU） */
function aggregateByBrand(rows) {
  const map = {};
  for (const r of rows) {
    const brand = r[COLUMN_MAP.brand_name] || "Unknown";
    if (!map[brand]) map[brand] = { project_name: brand, total_sales: 0, orderSet: new Set() };
    map[brand].total_sales += Number(r[COLUMN_MAP.grand_total]) || 0;
    map[brand].orderSet.add(r[COLUMN_MAP.order_no]);
  }
  return Object.values(map).map((m) => ({
    project_name: m.project_name,
    total_sales: +m.total_sales.toFixed(2),
    total_orders: m.orderSet.size,
    aov: m.orderSet.size ? +(m.total_sales / m.orderSet.size).toFixed(2) : 0,
  }));
}

/** 大盘 KPI */
function aggregateOverall(rows, adsSpent) {
  const sales = rows.reduce((a, r) => a + (Number(r[COLUMN_MAP.grand_total]) || 0), 0);
  const orderSet = new Set(rows.map((r) => r[COLUMN_MAP.order_no]));
  const ads = Number(adsSpent) || 0;
  return {
    total_sales: +sales.toFixed(2),
    ads_spent: +ads.toFixed(2),
    roas: ads > 0 ? +(sales / ads).toFixed(2) : null,
    aov: orderSet.size ? +(sales / orderSet.size).toFixed(2) : 0,
    total_orders: orderSet.size,
  };
}

/**
 * 按本地日期汇总成走势，给 Hero 卡的 sparkline 用。
 * 数据已经在手上了，不用再多查一次。
 */
function buildDailySeries(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = localDateStr(new Date(r[COLUMN_MAP.order_date]));
    if (!byDay.has(day)) byDay.set(day, { date: day, total_sales: 0, orderSet: new Set() });
    const bucket = byDay.get(day);
    bucket.total_sales += Number(r[COLUMN_MAP.grand_total]) || 0;
    bucket.orderSet.add(r[COLUMN_MAP.order_no]);
  }
  return [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      total_sales: +d.total_sales.toFixed(2),
      total_orders: d.orderSet.size,
    }));
}
