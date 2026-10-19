import { describe, it, expect } from "vitest";
import { parseFredCsv, parseMultplTable, parseLeguleguPe, monthly, percentile, combine, buildMacro } from "../src/macro.js";

describe("macro parsers", () => {
  it("reads FRED CSV and skips missing values", () => {
    expect(parseFredCsv("observation_date,DGS10\n2026-10-14,5.19\n2026-10-15,.\n2026-10-16,5.10\n")).toEqual([{ date: "2026-10-14", value: 5.19 }, { date: "2026-10-16", value: 5.1 }]);
  });
  it("reads the multpl table (newest first, odd whitespace entities)", () => {
    const html = '<tr class="odd"><td>Oct 16, 2026</td>\n<td>\n&#x2002;\n40.54\n</td></tr><tr><td>Sep 1, 2026</td><td>&#x2002; 40.42 </td></tr>';
    expect(parseMultplTable(html)).toEqual([{ date: "2026-10-16", value: 40.54 }, { date: "2026-09-01", value: 40.42 }]);
  });
  it("keeps the last observation of each month, oldest first", () => {
    expect(monthly([{ date: "2026-10-16", value: 3 }, { date: "2026-09-30", value: 2 }, { date: "2026-10-01", value: 1 }])).toEqual([{ date: "2026-09", value: 2 }, { date: "2026-10", value: 3 }]);
  });
  it("computes percentiles and joins series by month", () => {
    expect(percentile([1, 2, 3, 4], 3)).toBe(75);
    expect(combine([{ date: "a", value: 5 }, { date: "b", value: 6 }], [{ date: "b", value: 1 }], (x, y) => x - y)).toEqual([{ date: "b", value: 5 }]);
  });
});

describe("buildMacro", () => {
  const mk = (vals, start = 2000) => vals.map((v, i) => ({ date: `${start + i}-01`, value: v }));
  it("turns indicator percentiles into a market level and zone, inverting cheap-when-high indicators", () => {
    const series = {
      US_CAPE: mk([10, 15, 20, 25, 30, 40]),          // 当前最高 → 贵
      US_REAL10Y: mk([1, 1, 1, 1, 1, 1]),
      US_EQUITY: mk([1000, 2000]), US_GDP: mk([10, 10]), // 市值 / GDP：10% → 20%
      CN_PE: mk([20, 15, 10]),                           // 当前最低 → 便宜
      CN_10Y: mk([3, 3, 3]),
    };
    const m = buildMacro(series, "2026-10-18T00:00:00Z");
    const us = m.markets.find((x) => x.key === "us"), cn = m.markets.find((x) => x.key === "cn"), hk = m.markets.find((x) => x.key === "hk");
    expect(us.indicators.find((i) => i.key === "cape")).toMatchObject({ value: 40, pct: 100, expensive: 100 });
    expect(us.indicators.find((i) => i.key === "buffett")).toMatchObject({ value: 20, unit: "%" });
    const erp = us.indicators.find((i) => i.key === "us_erp"); // 100/40 − 1 = 1.5，历史最低 → 最贵
    expect(erp).toMatchObject({ value: 1.5, cheapHigh: true, expensive: 100 - erp.pct });
    expect(us.zone).toBe(4);
    expect(cn.indicators.find((i) => i.key === "cn_pe").pct).toBe(33);
    expect(cn.zone).toBeLessThan(3);
    expect(hk).toEqual({ key: "hk", pending: true }); // 没有恒指数据时仍是占位
    expect(m.gravity.us.ey.length).toBe(6);
  });
  it("builds Hong Kong from Hang Seng P/E since 2000 against the US 10-year yield", () => {
    const series = {
      HK_PE: [{ date: "1973-03", value: 60 }, ...mk([20, 15, 10, 12])], // 1973 的极端值不算进分位
      US_10Y: mk([5, 4, 3, 4]),
    };
    const hk = buildMacro(series, "2026-10-18T00:00:00Z").markets.find((x) => x.key === "hk");
    const pe = hk.indicators.find((i) => i.key === "hk_pe");
    expect(pe).toMatchObject({ value: 12, since: "2000-01", pct: 50 });
    const erp = hk.indicators.find((i) => i.key === "hk_erp"); // 100/12 − 4 ≈ 4.33
    expect(erp).toMatchObject({ value: 4.33, unit: "pp", cheapHigh: true });
    expect(hk.level).toBeGreaterThanOrEqual(0);
    const g = buildMacro(series, "x").gravity.hk;
    expect(g.ey.length).toBe(4);
    expect(g.y10[0][0]).toBe("2000-01");
  });
});

describe("legulegu Hang Seng P/E", () => {
  it("parses the monthly table rows", () => {
    const html = '<tr><th>时间</th></tr><tr><td>2026年9月</td><td>24613.27</td><td>13.79</td></tr><tr><td>1973年5月</td><td>/</td><td>43.56</td></tr><tr><td>2026年8月</td><td>x</td><td>-</td></tr>';
    expect(parseLeguleguPe(html)).toEqual([{ date: "2026-09", value: 13.79 }, { date: "1973-05", value: 43.56 }]);
  });
});
