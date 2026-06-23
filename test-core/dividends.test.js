import { describe, it, expect } from "vitest";
import {
  emSecucode, usDivTicker, parsePlanExplain,
  aggregateAShare, aggregateHK, aggregateUS, normalizeDividends,
} from "../src/dividends.js";

describe("emSecucode / usDivTicker", () => {
  it("maps A-share and HK codes; rejects others", () => {
    expect(emSecucode("sh688981")).toBe("688981.SH");
    expect(emSecucode("sz000001")).toBe("000001.SZ");
    expect(emSecucode("hk00883")).toBe("00883.HK");
    expect(emSecucode("hk700")).toBe("00700.HK"); // zero-pad to 5
    expect(emSecucode("usAAPL")).toBeNull();
  });
  it("extracts US ticker", () => {
    expect(usDivTicker("usAAPL")).toBe("AAPL");
    expect(usDivTicker("hk00883")).toBeNull();
  });
});

describe("parsePlanExplain", () => {
  it("parses HK dividend text (港币)", () => {
    expect(parsePlanExplain("每股派港币0.55元")).toEqual({ amount: 0.55, currency: "HKD" });
  });
  it("parses US dividend text (美元)", () => {
    expect(parsePlanExplain("每1股派0.27美元股息")).toEqual({ amount: 0.27, currency: "USD" });
  });
  it("returns null for no-dividend rows", () => {
    expect(parsePlanExplain("未派发或宣派股息")).toBeNull();
    expect(parsePlanExplain("")).toBeNull();
    expect(parsePlanExplain(null)).toBeNull();
  });
});

describe("aggregateAShare", () => {
  it("sums cash dividends per REPORT_DATE year, /10 per share, skips nulls", () => {
    const rows = [
      { REPORT_DATE: "2026-06-30 00:00:00", PRETAX_BONUS_RMB: null },
      { REPORT_DATE: "2025-12-31 00:00:00", PRETAX_BONUS_RMB: 280.2423 },
      { REPORT_DATE: "2025-09-30 00:00:00", PRETAX_BONUS_RMB: 239.57 },
      { REPORT_DATE: "2024-12-31 00:00:00", PRETAX_BONUS_RMB: 276.73 },
    ];
    const { currency, byYear } = aggregateAShare(rows);
    expect(currency).toBe("CNY");
    expect(byYear[2025]).toBeCloseTo((280.2423 + 239.57) / 10, 4);
    expect(byYear[2024]).toBeCloseTo(276.73 / 10, 4);
    expect(byYear[2026]).toBeUndefined();
  });
});

describe("aggregateHK", () => {
  it("sums interim + final per fiscal YEAR (CNOOC FY2025 = 1.28)", () => {
    const rows = [
      { YEAR: "2025", PLAN_EXPLAIN: "每股派港币0.55元" }, // 年度
      { YEAR: "2025", PLAN_EXPLAIN: "每股派港币0.73元" }, // 中期
      { YEAR: "2024", PLAN_EXPLAIN: "每股派港币0.66元" },
      { YEAR: "2024", PLAN_EXPLAIN: "每股派港币0.74元" },
      { YEAR: "2021", PLAN_EXPLAIN: "未派发或宣派股息" },
    ];
    const { currency, byYear } = aggregateHK(rows);
    expect(currency).toBe("HKD");
    expect(byYear[2025]).toBeCloseTo(1.28, 4);
    expect(byYear[2024]).toBeCloseTo(1.40, 4);
    expect(byYear[2021]).toBeUndefined();
  });
});

describe("aggregateUS", () => {
  it("sums quarterly dividends per ASSIGN_PERIOD year", () => {
    const rows = [
      { ASSIGN_PERIOD: "2024季度分配", PLAN_EXPLAIN: "每1股派0.26美元股息" },
      { ASSIGN_PERIOD: "2024季度分配", PLAN_EXPLAIN: "每1股派0.25美元股息" },
      { ASSIGN_PERIOD: "2024季度分配", PLAN_EXPLAIN: "每1股派0.25美元股息" },
      { ASSIGN_PERIOD: "2024季度分配", PLAN_EXPLAIN: "每1股派0.25美元股息" },
    ];
    const { currency, byYear } = aggregateUS(rows);
    expect(currency).toBe("USD");
    expect(byYear[2024]).toBeCloseTo(1.01, 4);
  });
});

describe("normalizeDividends", () => {
  it("returns ascending years, rounded, drops zero/empty", () => {
    expect(normalizeDividends({ currency: "HKD", byYear: { 2025: 1.28, 2024: 1.40 } }))
      .toEqual({ currency: "HKD", years: [{ year: 2024, perShare: 1.4 }, { year: 2025, perShare: 1.28 }] });
    expect(normalizeDividends({ currency: "CNY", byYear: {} })).toBeNull();
    expect(normalizeDividends(null)).toBeNull();
  });
});
