/* =====================================================================
   CONFIG — Supabase 连接 + 全局参数
   在 Supabase Dashboard → Project Settings → API 里拿 URL / publishable key
   ===================================================================== */
export const CONFIG = {
  SUPABASE_URL: "https://qvhwbxrsucttamiljfau.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_rfrK-U1ScPh1EuOdwURB9g_rgeFmdoe",

  /** 自动刷新间隔 */
  REFRESH_INTERVAL_MS: 5 * 60 * 1000,

  /** 活动开始日：默认只看这天之后的数据 */
  CAMPAIGN_START_DATE: "2026-07-26",

  /** PostgREST 单次请求默认最多返回 1000 行，所以要分页把整个范围拉完 */
  PAGE_SIZE: 1000,
  /** 分页安全上限，避免配置错误时无限翻页 */
  MAX_PAGES: 200,

  LOCALE: "en-MY",
  CURRENCY_PREFIX: "RM ",
};

/** 没填真实 key 时进入 demo 模式，用示例数据预览整个 dashboard */
export const DEMO_MODE =
  CONFIG.SUPABASE_URL.startsWith("YOUR_") ||
  CONFIG.SUPABASE_ANON_KEY.startsWith("YOUR_");
