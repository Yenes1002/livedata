/**
 * ============================================================================
 *  THE ONLY FILE YOU NORMALLY EDIT.
 *
 *  Every source database and every table it copies into YENES is declared
 *  here. The sync task reads this list and does the rest.
 *
 *  ►►  Read MAPPING.md before adding anything. It explains how to pick a
 *      cursor, how to map columns whose names don't match, and how to merge
 *      two sources into one table without them overwriting each other.
 * ============================================================================
 */
import type { SourceSpec } from "./lib/types.js";

export const SOURCES: SourceSpec[] = [
  /* ------------------------------------------------------------------------
     OXM1 / LEGACY — the original MySQL database.

     Auto-increment integer ids, so a numeric cursor (the default) is correct.
     Insert-only: new records arrive but edits to existing ones don't, because
     the legacy `last_modified` column isn't maintained reliably enough to page
     on.
  ------------------------------------------------------------------------ */
  {
    key: "legacy",
    label: "OXM1 Legacy MySQL",
    envVar: "LEGACY_DATABASE_URL",
    dialect: "mysql",
    required: true,
    tables: [
      { source: "Merchant", target: "legacy_merchants" },
      { source: "MerchantProject", target: "legacy_projects" },
      { source: "MerchantProjectPage", target: "legacy_page" },
      // 活动开始日（2026-07-26）之前的广告花费明细已经删了（超过 Supabase 免费版存储上限，
      // legacy_pagead 单表一度占了 185MB）。加这个 where 防止以后同步又把旧数据拉回来。
      { source: "MerchantProjectPageAd", target: "legacy_pagead", where: "date >= '2026-07-26'" },
      { source: "Customer", target: "legacy_customer" },
      { source: "MerchantProjectPageOrder", target: "legacy_orders" },
      { source: "UserDraftOrder", target: "legacy_draftorders" }
    ],
  },

  /* ------------------------------------------------------------------------
     OXM2 / YZ — PostgreSQL. Raw table copy, original column names kept.

     ⚠️ CURSORS: every table here has a RANDOM uuid (v4) primary key, so `id`
     CANNOT be used as the cursor. Keyset paging assumes new rows sort after
     everything already seen; random uuids don't. After the first backfill the
     cursor sits near the top of the uuid range ("ffff…") and virtually every
     new row sorts BELOW it, so `id > cursor` matches nothing and the table
     silently stops updating. See test/uuid-cursor.test.mts — it reproduces
     exactly that: 0 of 500 new rows picked up.

     So these page on `updated_at` with `id` as the tiebreaker, which also
     means edits are captured — important here, because order status,
     payment/fulfilment state and customer merges all mutate after insert.
  ------------------------------------------------------------------------ */
  {
    key: "yz",
    label: "OXM2 PostgreSQL",
    envVar: "YZ_DATABASE_URL",
    dialect: "postgres",

    // false = if YZ_DATABASE_URL isn't set, or YZ is unreachable, log it and
    // carry on with the other sources instead of failing the whole run.
    // Flip to true once you want a broken YZ to fail the run loudly.
    required: false,

    tables: [
      {
        source: "order",
        target: "ai_order",
        identity: "id",
        cursor: { column: "updated_at", type: "timestamp", tiebreak: "id" },
      },
      {
        source: "market",
        target: "ai_market",
        identity: "id",
        cursor: { column: "updated_at", type: "timestamp", tiebreak: "id" },
      },
      {
        source: "brand",
        target: "ai_brand",
        identity: "id",
        cursor: { column: "updated_at", type: "timestamp", tiebreak: "id" },
      },
      {
        source: "expense_entry",
        target: "ai_expenses_entry",
        identity: "id",
        cursor: { column: "updated_at", type: "timestamp", tiebreak: "id" },
      },
      {
        // expense_type has no updated_at — created_at is the only timestamp.
        // It's a 12-row lookup table, so missing edits doesn't matter much.
        source: "expense_type",
        target: "ai_expenses_type",
        identity: "id",
        cursor: { column: "created_at", type: "timestamp", tiebreak: "id" },
      },
      {
        source: "customer",
        target: "ai_customer",
        identity: "id",
        cursor: { column: "updated_at", type: "timestamp", tiebreak: "id" },
      },
    ],
  },
];
