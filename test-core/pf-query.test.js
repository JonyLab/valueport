import { describe, it, expect } from "vitest";
import { validatePfQuery, runPfQuery, dropFilter, PFQ_ZONES } from "../public/shared/pf-query.js";
import { ZONES } from "../public/shared/core.js";

const CAT = { accounts: ["长桥", "IBKR"], currencies: ["USD", "HKD"] };
const ROWS = [
  { symbol: "hk00700", name: "腾讯控股", ticker: "00700", zone: "over", market: "HK", currency: "HKD", accounts: ["长桥"], byAccount: { 长桥: 300 }, weight: 30, target: 20, drift: 10, driftStatus: "over", action: "trimHot", pnlPct: 40, value: 300, valued: true, held: true },
  { symbol: "usAAPL", name: "Apple", ticker: "AAPL", zone: "fair", market: "US", currency: "USD", accounts: ["长桥", "IBKR"], byAccount: { 长桥: 100, IBKR: 150 }, weight: 25, target: 25, drift: 0, driftStatus: "ok", action: "ok", pnlPct: -5, value: 250, valued: true, held: true },
  { symbol: "hk01810", name: "小米集团", ticker: "01810", zone: "none", market: "HK", currency: "HKD", accounts: ["IBKR"], byAccount: { IBKR: 100 }, weight: 10, target: NaN, drift: NaN, driftStatus: "none", action: "none", pnlPct: NaN, value: 100, valued: false, held: true },
  { symbol: "usKO", name: "Coca-Cola", ticker: "KO", zone: "deep", market: "US", currency: "USD", accounts: [], byAccount: {}, weight: 0, target: 5, drift: -5, driftStatus: "build", action: "buildCheap", pnlPct: NaN, value: 0, valued: true, held: false },
];
const q = (raw) => { const r = validatePfQuery(raw, CAT); if (r.error) throw new Error(r.error); return r.query; };

describe("pf-query catalog", () => {
  it("zone keys match core.js ZONES", () => {
    expect(PFQ_ZONES).toEqual([...ZONES.map((z) => z.key), "none"]);
  });
});

describe("validatePfQuery", () => {
  it("normalizes a valid query", () => {
    expect(q({ view: "table", title: "  高估且超配 ", filter: [{ field: "zone", op: "in", value: ["Over", "xover"] }, { field: "driftStatus", op: "eq", value: "over" }], sort: { field: "weight" }, limit: "5" }))
      .toEqual({ view: "table", title: "高估且超配", filter: [{ field: "zone", op: "in", value: ["over", "xover"] }, { field: "driftStatus", op: "eq", value: "over" }], sort: { field: "weight", dir: "desc" }, limit: 5 });
    expect(q({ view: "stat", metric: "weight", filter: [{ field: "market", op: "eq", value: "hk" }] }).filter[0].value).toBe("HK");
    expect(q({ view: "donut" }).groupBy).toBe("zone");
    expect(q({ view: "stat" }).metric).toBe("count");
    expect(q({ view: "table", filter: [{ field: "pnlPct", op: "lt", value: "-20%" }] }).filter[0].value).toBe(-20);
    expect(q({ view: "table", filter: [{ field: "valued", op: "eq", value: "false" }] }).filter[0].value).toBe(false);
    expect(q({ view: "table", limit: 999 }).limit).toBe(50);
    expect(q({ view: "none", say: "这个问题和持仓无关" })).toEqual({ view: "none", title: "", say: "这个问题和持仓无关" });
  });
  it("rejects unknown fields, ops, values and views", () => {
    const bad = (raw) => validatePfQuery(raw, CAT).error;
    expect(bad(null)).toBeTruthy();
    expect(bad({ view: "chart" })).toMatch(/view/);
    expect(bad({ view: "table", filter: [{ field: "costBasis", op: "gt", value: 1 }] })).toMatch(/unknown field/);
    expect(bad({ view: "table", filter: [{ field: "__proto__", op: "eq", value: 1 }] })).toMatch(/unknown field/);
    expect(bad({ view: "table", filter: [{ field: "zone", op: "gt", value: "over" }] })).toMatch(/bad op/);
    expect(bad({ view: "table", filter: [{ field: "zone", op: "eq", value: "cheap" }] })).toMatch(/unknown value/);
    expect(bad({ view: "table", filter: [{ field: "account", op: "eq", value: "富途" }] })).toMatch(/unknown value/);
    expect(bad({ view: "table", filter: [{ field: "weight", op: "gt", value: "lots" }] })).toMatch(/number/);
    expect(bad({ view: "table", filter: "zone=over" })).toMatch(/filter/);
    expect(bad({ view: "table", sort: { field: "zone" } })).toMatch(/sort/);
    expect(bad({ view: "donut", groupBy: "sector" })).toMatch(/groupBy/);
    expect(bad({ view: "stat", metric: "avg" })).toMatch(/metric/);
    expect(bad({ view: "table", limit: 0 })).toMatch(/limit/);
  });
});

describe("runPfQuery", () => {
  it("filters held rows and sorts / limits tables", () => {
    const r = runPfQuery(q({ view: "table", filter: [{ field: "zone", op: "in", value: ["over", "xover"] }, { field: "driftStatus", op: "eq", value: "over" }] }), ROWS);
    expect(r.rows.map((x) => x.ticker)).toEqual(["00700"]);
    // 默认不含计划建仓的
    expect(runPfQuery(q({ view: "table", filter: [{ field: "valued", op: "eq", value: true }] }), ROWS).rows.map((x) => x.ticker)).toEqual(["00700", "AAPL"]);
    expect(runPfQuery(q({ view: "table", filter: [{ field: "held", op: "eq", value: false }] }), ROWS).rows.map((x) => x.ticker)).toEqual(["KO"]);
    expect(runPfQuery(q({ view: "table", sort: { field: "pnlPct", dir: "asc" }, limit: 2 }), ROWS).rows.map((x) => x.ticker)).toEqual(["AAPL", "00700"]);
    expect(runPfQuery(q({ view: "table", filter: [{ field: "name", op: "contains", value: "apple" }] }), ROWS).rows).toHaveLength(1);
    expect(runPfQuery(q({ view: "table", filter: [{ field: "account", op: "eq", value: "IBKR" }] }), ROWS).rows.map((x) => x.ticker)).toEqual(["AAPL", "01810"]);
    expect(runPfQuery(q({ view: "table", filter: [{ field: "pnlPct", op: "lt", value: 0 }] }), ROWS).rows.map((x) => x.ticker)).toEqual(["AAPL"]); // NaN 不算
  });
  it("computes stats", () => {
    expect(runPfQuery(q({ view: "stat", metric: "weight", filter: [{ field: "market", op: "eq", value: "HK" }] }), ROWS)).toEqual({ view: "stat", metric: "weight", value: 40, n: 2 });
    expect(runPfQuery(q({ view: "stat", filter: [{ field: "valued", op: "eq", value: false }] }), ROWS).value).toBe(1);
    expect(runPfQuery(q({ view: "stat", metric: "value" }), ROWS).value).toBe(650);
  });
  it("groups donuts, splitting by account", () => {
    expect(runPfQuery(q({ view: "donut", groupBy: "market" }), ROWS).groups).toEqual([["HK", 400], ["US", 250]]);
    expect(runPfQuery(q({ view: "donut", groupBy: "account" }), ROWS).groups).toEqual([["长桥", 400], ["IBKR", 250]]);
    expect(runPfQuery(q({ view: "donut", groupBy: "valued" }), ROWS).groups).toEqual([["true", 550], ["false", 100]]);
  });
  it("drops a filter chip", () => {
    const base = q({ view: "table", filter: [{ field: "zone", op: "eq", value: "over" }, { field: "market", op: "eq", value: "HK" }] });
    expect(dropFilter(base, 0).filter).toEqual([{ field: "market", op: "eq", value: "HK" }]);
    expect(base.filter).toHaveLength(2);
  });
});
