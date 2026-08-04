/* =====================================================================
   FIXTURES — synthetic dashboard_sales / expense_entry rows and a
   minimal PostgREST-shaped client stub.

   The sales fixture is deliberately larger than CONFIG.PAGE_SIZE (1000)
   so the pagination in src/data/client.js is actually exercised.
   ===================================================================== */

export const BRANDS = [
  { name: "Skindae", market: "m1" },              // internal
  { name: "Beyoute", market: "m2" },              // internal
  { name: "Masternerve", market: "m3" },          // internal
  { name: "Agency A - KOL Live", market: "m4" },  // external — spaces + hyphens on purpose
  { name: "Agency B - Affiliate", market: "m5" },
];

export const DAYS = [
  "2026-07-24", "2026-07-25",              // before the campaign start → previous period
  "2026-07-26", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30",
];

export const ADS_TYPE_ID = "cbae5a79-fddc-4fc0-bce7-d7ecbfaff86e";

const ORDERS_PER_BRAND_PER_DAY = 60; // 5 brands × 7 days × 60 = 2100 rows

/** @param {number} scale shifts grand_total so a second fetch returns different numbers */
export function buildSalesRows(scale = 0) {
  const rows = [];
  let n = 0;
  for (const day of DAYS) {
    for (const b of BRANDS) {
      for (let i = 0; i < ORDERS_PER_BRAND_PER_DAY; i++) {
        n++;
        rows.push({
          order_no: `ORD-${day}-${b.market}-${i}`,
          order_date: `${day}T0${(i % 9) + 1}:15:00+08:00`,
          customer_id: 1000 + (n % 400),
          brand_name: b.name,
          market_id: b.market,
          grand_total: +(100 + ((n * 7) % 90) + scale * 3).toFixed(2),
          // every 25th order is cancelled → must be excluded from totals
          order_status: i % 25 === 0 ? "cancelled" : "completed",
          payment_status: "paid",
        });
      }
    }
  }
  return rows;
}

export function buildExpenseRows() {
  const rows = [];
  for (const day of DAYS) {
    for (const b of BRANDS) {
      rows.push({
        entry_date: day,
        expense_type_id: ADS_TYPE_ID,
        amount: 900,
        amount_total: 1000 + BRANDS.indexOf(b) * 120,
        market_id: b.market,
      });
    }
  }
  return rows;
}

/**
 * Minimal chainable stub honouring the filters and .range() paging the real
 * client uses. Records every range() call so tests can assert paging happened.
 */
export function createSupabaseStub({ scale = () => 0, rangeCalls = {} } = {}) {
  return () => ({
    from(table) {
      const filters = [];
      const builder = {
        select: () => builder,
        order: () => builder,
        gte: (c, v) => (filters.push(["gte", c, v]), builder),
        lt:  (c, v) => (filters.push(["lt", c, v]), builder),
        lte: (c, v) => (filters.push(["lte", c, v]), builder),
        eq:  (c, v) => (filters.push(["eq", c, v]), builder),
        in:  (c, v) => (filters.push(["in", c, v]), builder),
        range(from, to) {
          (rangeCalls[table] ??= []).push([from, to]);
          let all = table === "dashboard_sales" ? buildSalesRows(scale()) : buildExpenseRows();
          for (const [op, col, v] of filters) {
            all = all.filter((r) => {
              const cell = r[col];
              if (op === "gte") return String(cell) >= String(v);
              if (op === "lt")  return String(cell) <  String(v);
              if (op === "lte") return String(cell) <= String(v);
              if (op === "eq")  return cell === v;
              if (op === "in")  return v.includes(cell);
              return true;
            });
          }
          return Promise.resolve({ data: all.slice(from, to + 1), error: null });
        },
      };
      return builder;
    },
  });
}

/** A client whose every read fails, for the error-path test. */
export function createFailingStub(message = 'relation "dashboard_sales" does not exist') {
  return () => ({
    from() {
      const b = {
        select: () => b, order: () => b, gte: () => b, lt: () => b,
        lte: () => b, eq: () => b, in: () => b,
        range: () => Promise.resolve({ data: null, error: { message } }),
      };
      return b;
    },
  });
}

/** A client returning a single row, for lightweight boots. */
export function createMinimalStub() {
  return () => ({
    from() {
      const b = {
        select: () => b, order: () => b, gte: () => b, lt: () => b,
        lte: () => b, eq: () => b, in: () => b,
        range: (from) => Promise.resolve({
          data: from === 0 ? [{
            order_no: "A1", order_date: "2026-07-28T10:00:00+08:00", customer_id: 1,
            brand_name: "Skindae", market_id: "m1", grand_total: 250,
            order_status: "completed", payment_status: "paid",
          }] : [],
          error: null,
        }),
      };
      return b;
    },
  });
}
