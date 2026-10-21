import { describe, it, expect } from "vitest";
import { MACRO_MARKETS, DEFAULT_PREFS, normalizePrefs, serializePrefs, parsePrefs, visibleMarkets, isDefaultPrefs, toggleMarket, moveMarket, setCross, pickNewer, marketSummary, sparkPath } from "../public/shared/macro-board.js";

describe("macro market prefs", () => {
  it("normalizes junk into a full, unique order with valid hidden keys", () => {
    expect(normalizePrefs(null)).toEqual({ order: MACRO_MARKETS, hidden: [], cross: true, at: 0 });
    expect(normalizePrefs({ order: ["cn", "xx", "cn", "us"], hidden: ["hk", "zz"], cross: false, at: "12" }))
      .toEqual({ order: ["cn", "us", "hk"], hidden: ["hk"], cross: false, at: 12 });
    expect(normalizePrefs({ order: "us", hidden: "cn", at: -5 })).toEqual({ order: ["us", "hk", "cn"], hidden: [], cross: true, at: 0 });
  });
  it("round-trips through serialize/parse and rejects bad JSON", () => {
    const p = { order: ["hk", "us", "cn"], hidden: ["cn"], cross: false, at: 1700000000000 };
    expect(parsePrefs(serializePrefs(p))).toEqual(p);
    expect(parsePrefs("")).toBe(null);
    expect(parsePrefs("{nope")).toBe(null);
    expect(parsePrefs("[1,2]")).toBe(null);
    expect(parsePrefs(undefined)).toBe(null);
  });
  it("derives visible markets in the chosen order", () => {
    expect(visibleMarkets({ order: ["cn", "hk", "us"], hidden: ["hk"] })).toEqual(["cn", "us"]);
    expect(visibleMarkets({ hidden: MACRO_MARKETS })).toEqual([]);
    expect(isDefaultPrefs(DEFAULT_PREFS)).toBe(true);
    expect(isDefaultPrefs({ hidden: ["cn"] })).toBe(false);
  });
  it("toggles, moves and stamps the edit time", () => {
    let p = toggleMarket(DEFAULT_PREFS, "cn", false, 10);
    expect(p).toMatchObject({ hidden: ["cn"], at: 10 });
    p = toggleMarket(p, "cn", true, 11);
    expect(p.hidden).toEqual([]);
    p = moveMarket(p, "cn", -1, 12);
    expect(p).toMatchObject({ order: ["us", "cn", "hk"], at: 12 });
    expect(moveMarket(p, "us", -1, 99)).toEqual(p); // 已在最前：不动、不改时间
    expect(setCross(p, false, 13)).toMatchObject({ cross: false, at: 13 });
  });
  it("picks the newer of local and remote copies", () => {
    const a = { hidden: ["cn"], at: 5 }, b = { hidden: ["hk"], at: 9 };
    expect(pickNewer(a, b).hidden).toEqual(["hk"]);
    expect(pickNewer(b, a).hidden).toEqual(["hk"]);
    expect(pickNewer(a, null).hidden).toEqual(["cn"]);
    expect(pickNewer(null, b).hidden).toEqual(["hk"]);
    expect(pickNewer(null, null)).toBe(null);
  });
});

describe("marketSummary", () => {
  const ix = (name, pct, chg1y, fromHigh) => ({ name, pct, chg1y, fromHigh });
  it("describes a broad rally near the high, with the valuation level", () => {
    const s = marketSummary({ indices: [ix("标普 500", 0.19, 15.4, -1.1), ix("纳指", 0.6), ix("道指", 0.04)], level: 92, zoneName: "泡沫区" }, "zh");
    expect(s).toBe("小幅普涨，标普 500 +0.19%；近一年 +15.4%，贴近一年高点；估值水位 92 分位（泡沫区）。");
  });
  it("describes a sharp broad fall and a deep drawdown in English", () => {
    const s = marketSummary({ indices: [ix("CSI 300", -1.8, -10.9, -25.2), ix("ChiNext", -2.1)] }, "en");
    expect(s).toBe("Sharply lower across the board; CSI 300 −1.80%; −10.9% over a year, 25% off its 1-year high.");
  });
  it("handles mixed / flat sessions and missing data", () => {
    expect(marketSummary({ indices: [ix("A", 0.05), ix("B", -0.04)] }, "zh")).toBe("窄幅震荡，A +0.05%。");
    expect(marketSummary({ indices: [ix("A", 0.8), ix("B", -0.4)] }, "zh")).toBe("涨跌互现，A +0.80%。");
    expect(marketSummary({ indices: [ix("A", NaN)] }, "zh")).toBe("");
    expect(marketSummary({ indices: [], level: 40, zoneName: "Fair" }, "en")).toBe("Valuation P40 (Fair).");
  });
});

describe("sparkPath", () => {
  it("maps values into the box, highest at the top", () => {
    expect(sparkPath([1, 3, 2], 100, 10, 0)).toBe("M0.0,10.0L50.0,0.0L100.0,5.0");
    expect(sparkPath([5], 100, 10)).toBe("");
    expect(sparkPath([2, 2], 100, 10, 1)).toBe("M0.0,1.0L100.0,1.0");
  });
});
