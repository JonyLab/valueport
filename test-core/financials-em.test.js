import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  emMarket, fetchEastmoneyFinancials, hkAmountCurrency, recordsFromHK, quarterPeriods, annualPeriods, buildStatements,
} from "../src/financials-em.js";
import { parseFinancials, pickLatestAnnual } from "../src/longbridge.js";

// 录制自东财 F10 / Frankfurter 的真实响应(裁剪到近几年 + 用到的科目),测试不走网络
const FX = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/em-financials.json", import.meta.url)), "utf8"));
const lbFixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/financials-aapl.json", import.meta.url)), "utf8"));

function fakeFetch(key, { calls = [], failFx = false } = {}) {
  const rec = FX[key];
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.hostname.includes("frankfurter")) {
      if (failFx) return new Response("nope", { status: 503 });
      return Response.json(FX.fx[u.searchParams.get("from")]);
    }
    const body = rec[u.searchParams.get("reportName")];
    return body ? Response.json(body) : Response.json({ result: null, success: false, code: 9201 });
  };
}
const acct = (f, kind, field) => f[kind].find((a) => a.field === field);
const vals = (f, kind, field) => acct(f, kind, field).values.map((v) => v.value);

describe("emMarket", () => {
  it("maps project symbols to eastmoney codes + quote currency", () => {
    expect(emMarket("sh600519")).toMatchObject({ market: "A", secucode: "600519.SH", quoteCurrency: "CNY" });
    expect(emMarket("hk700")).toMatchObject({ market: "HK", secucode: "00700.HK", quoteCurrency: "HKD" });
    expect(emMarket("usBRK.B")).toMatchObject({ market: "US", ticker: "BRK.B", quoteCurrency: "USD" });
    expect(emMarket("INVALID")).toBe(null);
    expect(emMarket("")).toBe(null);
  });
});

describe("hkAmountCurrency", () => {
  it("RMB reporters stay CNY; everything else is pre-converted to HKD by eastmoney; unknown → null", () => {
    expect(hkAmountCurrency("人民币")).toBe("CNY");
    expect(hkAmountCurrency("美元")).toBe("HKD");
    expect(hkAmountCurrency("港币")).toBe("HKD");
    expect(hkAmountCurrency(undefined)).toBe(null);
  });
});

describe("fetchEastmoneyFinancials · A股 (sh600519)", () => {
  it("annual: Longbridge-shaped {IS,BS,CF}, newest first, aligned periods, CNY", async () => {
    const f = await fetchEastmoneyFinancials("sh600519", "af", { fetchImpl: fakeFetch("sh600519|af") });
    expect(Object.keys(f)).toEqual(["IS", "BS", "CF"]);
    const rev = acct(f, "IS", "OperatingRevenue");
    expect(rev.currency).toBe("CNY");
    expect(rev.name).toBe("营业收入(CNY)");
    expect(rev.values.length).toBeGreaterThanOrEqual(5);
    expect(rev.values[0]).toMatchObject({ year: 2025, period: "FY 2025", fpEnd: "2025-12-31" });
    expect(rev.values[0].value).toBeCloseTo(168838102514.79, 0);
    expect(vals(f, "IS", "NetProfit")[0]).toBeCloseTo(82320067101.68, 0);
    expect(vals(f, "IS", "GrossMgn")[0]).toBeCloseTo(91.18, 1);
    expect(vals(f, "IS", "NetProfitMargin")[0]).toBeCloseTo(48.76, 1);
    expect(vals(f, "IS", "ROE")[0]).toBeGreaterThan(30);
    expect(vals(f, "IS", "EPS")[0]).toBeCloseTo(65.66, 2);
    expect(vals(f, "BS", "BPS")[0]).toBeCloseTo(195.36, 1);
    expect(vals(f, "BS", "Leverage")[0]).toBeCloseTo(1.196, 2);
    expect(vals(f, "BS", "NetDebt")[0]).toBeLessThan(0); // 净现金
    expect(vals(f, "CF", "CapEx")[0]).toBeCloseTo(-3127594916.41, 0);
    expect(vals(f, "CF", "NetFreeCashFlow")[0]).toBeCloseTo(61522204989.35 - 3127594916.41, 0);
    // 各科目期数一致(field-meta 按下标对齐不同科目)
    const n = rev.values.length;
    for (const k of ["IS", "BS", "CF"]) for (const a of f[k]) expect(a.values.length).toBe(n);
    // 喂给 pickLatestAnnual 与长桥同样可用
    expect(pickLatestAnnual(f)).toMatchObject({ year: 2025 });
    expect(pickLatestAnnual(f).revenue).toBeCloseTo(168838102514.79, 0);
  });
  it("quarterly: single-quarter values derived from cumulative reports", async () => {
    const f = await fetchEastmoneyFinancials("sh600519", "qf", { fetchImpl: fakeFetch("sh600519|qf") });
    const rev = acct(f, "IS", "OperatingRevenue").values;
    expect(rev[0].period).toBe("Q2 2026");
    expect(rev[1].period).toBe("Q1 2026");
    expect(rev[2].period).toBe("Q4 2025");
    // Q2 单季 = 中报累计 − 一季报;与长桥单季口径一致(36.79B / 53.91B)
    expect(rev[0].value / 1e9).toBeCloseTo(36.79, 1);
    expect(rev[1].value / 1e9).toBeCloseTo(53.91, 1);
    // 近 4 季之和 ≈ 全年量级
    const ttm = rev.slice(0, 4).reduce((a, v) => a + v.value, 0);
    expect(ttm / 1e9).toBeGreaterThan(150);
  });
});

describe("fetchEastmoneyFinancials · 港股 (hk00700, RMB reporter)", () => {
  const cnyToHkd = 1 / FX.fx.HKD.rates.CNY;
  it("annual: converts RMB statements into HKD (quote currency)", async () => {
    const calls = [];
    const f = await fetchEastmoneyFinancials("hk00700", "af", { fetchImpl: fakeFetch("hk00700|af", { calls }) });
    expect(calls.some((u) => u.includes("frankfurter") && u.includes("from=HKD") && u.includes("CNY"))).toBe(true);
    const rev = acct(f, "IS", "OperatingRevenue");
    expect(rev.currency).toBe("HKD");
    expect(rev.values[0].period).toBe("FY 2025");
    expect(rev.values[0].value).toBeCloseTo(751766000000 * cnyToHkd, -4);
    expect(vals(f, "IS", "NetProfit")[0]).toBeCloseTo(224842000000 * cnyToHkd, -4);
    expect(vals(f, "IS", "EPS")[0]).toBeCloseTo(24.749 * cnyToHkd, 2);
    // 比率不随汇率变
    expect(vals(f, "IS", "NetProfitMargin")[0]).toBeCloseTo(224842 / 751766 * 100, 2);
    expect(vals(f, "IS", "GrossMgn")[0]).toBeCloseTo(422593 / 751766 * 100, 2);
    expect(vals(f, "BS", "Leverage")[0]).toBeCloseTo(2038986 / 1241065, 3);
    expect(vals(f, "CF", "CapEx")[0]).toBeCloseTo(-87482000000 * cnyToHkd, -4);
    expect(vals(f, "CF", "NetFreeCashFlow")[0]).toBeCloseTo((303052000000 - 87482000000) * cnyToHkd, -4);
    expect(vals(f, "CF", "OCFCoverage")[0]).toBeGreaterThan(80);
    expect(vals(f, "BS", "TotalAssets").filter(Number.isFinite).length).toBeGreaterThanOrEqual(5);
  });
  it("quarterly: Q labels by fiscal year, Q2 = interim − Q1", async () => {
    const f = await fetchEastmoneyFinancials("hk00700", "qf", { fetchImpl: fakeFetch("hk00700|qf") });
    const rev = acct(f, "IS", "OperatingRevenue").values;
    expect(rev.map((v) => v.period).slice(0, 4)).toEqual(["Q2 2026", "Q1 2026", "Q4 2025", "Q3 2025"]);
    expect(rev.every((v) => Number.isFinite(v.value))).toBe(true);
    expect(rev[0].value).toBeLessThan(rev[0].value + rev[1].value); // sanity
    expect(rev[0].value / 1e9).toBeGreaterThan(150); // 单季(非累计 ~400B)
    expect(rev[0].value / 1e9).toBeLessThan(300);
  });
  it("returns null rather than mislabeled numbers when the FX rate is unavailable", async () => {
    expect(await fetchEastmoneyFinancials("hk00700", "af", { fetchImpl: fakeFetch("hk00700|af", { failFx: true }) })).toBe(null);
  });
  it("returns null when the report currency cannot be determined", async () => {
    const rec = { ...FX["hk00700|af"], RPT_CUSTOM_HKF10_APPFN_INCOME_SUMMARY: { result: null, success: false, code: 9201 } };
    FX["hk00700|nocur"] = rec;
    expect(await fetchEastmoneyFinancials("hk00700", "af", { fetchImpl: fakeFetch("hk00700|nocur") })).toBe(null);
  });
});

describe("fetchEastmoneyFinancials · 美股 (usAAPL)", () => {
  it("annual: fiscal-year labels (Sept FY), USD, no FX call", async () => {
    const calls = [];
    const f = await fetchEastmoneyFinancials("usAAPL", "af", { fetchImpl: fakeFetch("usAAPL|af", { calls }) });
    expect(calls.some((u) => u.includes("frankfurter"))).toBe(false);
    const rev = acct(f, "IS", "OperatingRevenue");
    expect(rev.currency).toBe("USD");
    expect(rev.values[0]).toMatchObject({ year: 2025, period: "FY 2025", fpEnd: "2025-09-27" });
    expect(rev.values[0].value).toBe(416161000000);
    expect(vals(f, "IS", "NetProfit")[0]).toBe(112010000000);
    expect(vals(f, "IS", "OperatingIncome")[0]).toBe(133050000000);
    expect(vals(f, "IS", "EPS")[0]).toBe(7.49);
    expect(vals(f, "BS", "TotalAssets")[0]).toBe(359241000000);
    expect(vals(f, "CF", "NetFreeCashFlow")[0]).toBe(111482000000 - 12715000000);
    expect(vals(f, "IS", "ROE")[0]).toBeGreaterThan(100);
  });
  it("quarterly: uses eastmoney single-quarter rows with fiscal quarter labels", async () => {
    const f = await fetchEastmoneyFinancials("usAAPL", "qf", { fetchImpl: fakeFetch("usAAPL|qf") });
    const rev = acct(f, "IS", "OperatingRevenue").values;
    expect(rev[0].period).toBe("Q3 2026");
    expect(rev.find((v) => v.period === "Q4 2025").value).toBe(102466000000);
    expect(Number.isFinite(acct(f, "BS", "TotalAssets").values[0].value)).toBe(true);
  });
});

describe("quarterPeriods / annualPeriods", () => {
  it("semi-annual-only HK reporters yield no quarters (no Q1/Q3 to difference against)", () => {
    const mk = (end, start, rev) => ({ REPORT_DATE: end + " 00:00:00", START_DATE: start + " 00:00:00", STD_ITEM_NAME: "营运收入", AMOUNT: rev });
    const recs = recordsFromHK({
      income: [mk("2025-06-30", "2025-01-01", 50), mk("2025-12-31", "2025-01-01", 120)],
      currencies: { _latest: "港币" },
    });
    expect(quarterPeriods(recs)).toEqual([]);
    const a = annualPeriods(recs);
    expect(a.length).toBe(1);
    expect(a[0].label).toBe("FY 2025");
    expect(buildStatements(a, { currency: "HKD" }).IS.find((x) => x.field === "OperatingRevenue").values[0].value).toBe(120);
  });
  it("buildStatements returns null when nothing is finite", () => {
    expect(buildStatements([], { currency: "USD" })).toBe(null);
    expect(buildStatements([{ end: "2025-12-31", year: 2025, label: "FY 2025", cur: "USD", v: {} }], { currency: "USD" })).toBe(null);
  });
  it("network failure → null (never throws)", async () => {
    const boom = async () => { throw new Error("offline"); };
    expect(await fetchEastmoneyFinancials("sh600519", "af", { fetchImpl: boom })).toBe(null);
    expect(await fetchEastmoneyFinancials("INVALID", "af", { fetchImpl: boom })).toBe(null);
  });
});

describe("parseFinancials field aliases", () => {
  it("renames Longbridge ROEDf / NetProfitMarginDf to ROE / NetProfitMargin (what the front end reads)", () => {
    const j = { code: 0, data: { list: { IS: { indicators: [{ currency: "USD", accounts: [
      { field: "ROEDf", name: "ROE", values: [{ year: 2025, value: "171.4" }] },
      { field: "NetProfitMarginDf", name: "净利率", values: [{ year: 2025, value: "26.9" }] },
    ] }] } } } };
    const f = parseFinancials(j);
    expect(f.IS.map((a) => a.field)).toEqual(["ROE", "NetProfitMargin"]);
    expect(parseFinancials(lbFixture).IS.find((a) => a.field === "OperatingRevenue")).toBeTruthy();
  });
});
