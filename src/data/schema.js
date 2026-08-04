/* =====================================================================
   SCHEMA — Supabase 表结构映射 + KPI / 表格列定义

   dashboard_sales 是一张「订单明细表」（一行 = 一笔订单/SKU），
   不是预先汇总好的数据，所以汇总成「项目」是在前端做的。
   ===================================================================== */

export const TABLE_NAME = "ai_order";

export const COLUMN_MAP = {
  order_no:       "order_no",
  order_date:     "order_date",     // timestamp
  customer_id:    "customer_id",
  brand_name:     "brand_name",     // ai_order 本身没有这一列，client.js 从 ai_market/ai_brand 拼上去
  market_id:      "market_id",      // 跟 expense_entry.market_id 对应，用来拆算 Ads Spent
  grand_total:    "grand_total",
  order_status:   "order_status",
  payment_status: "payment_status",
};

/** ai_order 没有 brand_name 列，要靠 market_id -> ai_market.brand_id -> ai_brand.name 拼出来 */
export const MARKET_TABLE_NAME = "ai_market";
export const BRAND_TABLE_NAME = "ai_brand";

/** Orders / Sales 不计入这些状态的订单（小写比较，不分大小写） */
export const EXCLUDED_ORDER_STATUSES = ["draft", "cancelled"];

/**
 * 要过滤掉未付款订单的话，把有效状态值填进来，例如 ["paid","completed"]。
 * 留空 = 不过滤，所有订单都算进 Total Sales。
 */
export const VALID_PAYMENT_STATUSES = [];

/* ---------------------------------------------------------------------
   ADS SPEND — expense_entry 里 expense_type_id = Ads Spent 的行，
   按 market_id（= 项目）+ entry_date 汇总
--------------------------------------------------------------------- */
export const EXPENSE_TABLE_NAME = "ai_expenses_entry";

export const EXPENSE_COLUMN_MAP = {
  entry_date:      "entry_date",     // date
  expense_type_id: "expense_type_id",
  amount:          "amount",
  amount_total:    "amount_total",   // 含税总额，优先用这个
  market_id:       "market_id",
};

export const ADS_SPEND_EXPENSE_TYPE_ID = "cbae5a79-fddc-4fc0-bce7-d7ecbfaff86e";

export function expenseAmount(row) {
  const total = row[EXPENSE_COLUMN_MAP.amount_total];
  if (total !== null && total !== undefined) return Number(total) || 0;
  return Number(row[EXPENSE_COLUMN_MAP.amount]) || 0;
}

/* ---------------------------------------------------------------------
   BRAND CLASSIFICATION — Internal / External
--------------------------------------------------------------------- */
export const INTERNAL_BRANDS = ["Skindae", "Beyoute", "Masternerve"];

export function classifyBrand(brandName) {
  const norm = (brandName || "").trim().toLowerCase();
  const isInternal = INTERNAL_BRANDS.some((b) => b.toLowerCase() === norm);
  return isInternal ? "internal" : "external";
}

/* ---------------------------------------------------------------------
   KPI — key 对应汇总结果里的字段名，fmt 决定展示格式
   第一个是 Hero 卡（放大展示）
--------------------------------------------------------------------- */
export const KPI_DEFS = [
  { key: "total_sales",  label: "Total Sales",  fmt: "currency" },
  { key: "total_orders", label: "Total Orders", fmt: "int" },
  { key: "aov",          label: "AOV",          fmt: "currency" },
  { key: "roas",         label: "ROME",         fmt: "ratio" },
];

/* ---------------------------------------------------------------------
   PROJECT PERFORMANCE 表格列
--------------------------------------------------------------------- */
export const TABLE_COLUMNS = [
  { key: "project_name",  label: "Project",     sortable: true,  numeric: false },
  { key: "ads_spent",     label: "Ads Spent",   sortable: true,  numeric: true,  fmt: "currency" },
  { key: "total_sales",   label: "Total Sales", sortable: true,  numeric: true,  fmt: "currency" },
  { key: "roas",          label: "ROME",        sortable: true,  numeric: true,  fmt: "ratio" },
  { key: "aov",           label: "AOV",         sortable: true,  numeric: true,  fmt: "currency" },
  { key: "total_orders",  label: "Orders",      sortable: true,  numeric: true,  fmt: "int" },
  { key: "status",        label: "Status",      sortable: false, numeric: false },
];
