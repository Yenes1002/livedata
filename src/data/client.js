/* =====================================================================
   SUPABASE CLIENT + 分页读取

   PostgREST 单次请求默认最多返回 1000 行。原来的 .select("*") 没分页，
   一旦某个日期范围里的订单超过 1000 行，就会被静默截断 ——
   Total Sales / Orders 会偏小，而且页面上完全看不出来。
   所以这里统一用 .range() 翻页，直到某一页不满为止。
   ===================================================================== */
import { CONFIG, DEMO_MODE } from "../config.js";

export const supabaseClient = DEMO_MODE
  ? null
  : window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/**
 * 把一个查询的所有页拉完。
 * @param {() => any} buildQuery 每页都重新 build 一次（PostgREST query builder 用过就不能改 range）
 * @param {string} label 出错时的表名，用来拼人话报错
 */
export async function fetchAllRows(buildQuery, label) {
  const all = [];

  for (let page = 0; page < CONFIG.MAX_PAGES; page++) {
    const from = page * CONFIG.PAGE_SIZE;
    const to = from + CONFIG.PAGE_SIZE - 1;

    const { data, error } = await buildQuery().range(from, to);

    if (error) {
      console.error(`[${label}]`, error);
      throw new Error(
        `Supabase 查询失败（${label}）：${error.message || "未知错误"}。` +
        `请检查表是否存在、列名是否和 schema.js 对得上、以及 publishable key 的 RLS 权限。`
      );
    }

    const rows = data || [];
    all.push(...rows);

    // 最后一页一定不满 PAGE_SIZE
    if (rows.length < CONFIG.PAGE_SIZE) return all;
  }

  console.warn(
    `[${label}] 达到分页上限 ${CONFIG.MAX_PAGES} 页（${all.length} 行），` +
    `结果可能仍不完整。需要的话调大 CONFIG.MAX_PAGES。`
  );
  return all;
}
