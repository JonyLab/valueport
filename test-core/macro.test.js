import { describe, it, expect } from "vitest";
import { parseFredCsv, parseMultplTable, parseLeguleguPe, monthly, percentile, combine, buildMacro, buildRates, parseMarketsParam, normTime, parsePulseQuote, parsePulseQuotes, parseTencentKline, klineStats, fetchPulse } from "../src/macro.js";

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

describe("market filter and rates", () => {
  const mk = (vals, start = 2000) => vals.map((v, i) => ({ date: `${start + i}-01`, value: v }));
  it("parses the markets query: absent = all, empty = none, junk dropped", () => {
    expect(parseMarketsParam(undefined)).toEqual(["us", "hk", "cn"]);
    expect(parseMarketsParam("")).toEqual([]);
    expect(parseMarketsParam("CN, us,xx,cn")).toEqual(["cn", "us"]);
  });
  it("returns only the requested markets and their gravity, plus rates", () => {
    const series = { US_CAPE: mk([20, 30]), US_REAL10Y: mk([1, 2]), CN_PE: mk([15, 12]), CN_10Y: mk([3, 2.5]) };
    const m = buildMacro(series, "t", ["cn"]);
    expect(m.markets.map((x) => x.key)).toEqual(["cn"]);
    expect(Object.keys(m.gravity)).toEqual(["cn"]);
    expect(m.rates.map((r) => r.key)).toEqual(["us_real10y", "cn10y"]);
    expect(buildMacro(series, "t", []).markets).toEqual([]);
  });
  it("computes monthly and yearly changes in percentage points", () => {
    const s = Array.from({ length: 14 }, (_, i) => ({ date: `2025-${String(i + 1).padStart(2, "0")}`, value: 4 + i * 0.1 }));
    const [us] = buildRates({ US_10Y: s });
    expect(us).toMatchObject({ key: "us10y", value: 5.3, chg1m: 0.1, chg1y: 1.2 });
    expect(us.spark.length).toBe(14);
    expect(buildRates({ US_10Y: [{ date: "2026-10", value: 4 }] })[0]).toMatchObject({ chg1m: null, chg1y: null });
  });
});

describe("pulse quote parsing", () => {
  const idx = (sym, price, prev, time, chg, pct) => { const f = Array(50).fill("0"); f[3] = price; f[4] = prev; f[30] = time; f[31] = chg; f[32] = pct; return `v_${sym}="${f.join("~")}";`; };
  it("normalizes the three time formats", () => {
    expect(normTime("2026-10-21 10:43:40")).toBe("2026-10-21 10:43");
    expect(normTime("2026/10/21 18:31:19")).toBe("2026-10-21 18:31");
    expect(normTime("20261021161500")).toBe("2026-10-21 16:15");
    expect(normTime("garbage")).toBe("");
  });
  it("reads index, FX and futures lines", () => {
    const text = [
      idx("us.INX", "7727.15", "7712.57", "2026-10-21 10:43:40", "14.58", "0.19"),
      idx("hkHSI", "23651.870", "23867.740", "2026/10/21 18:31:19", "-215.870", "-0.90"),
      'v_whUSDCNY="310~美元人民币~USDCNY~6.6758~0~20261021224323~6.6781~6.6770~6.6807~6.6756~6.6758~6.6760~-0.0023~-0.03~-0.33";',
      'v_hf_GC="4149.04,0.16,4147.70,4148.00,4160.60,4124.00,22:43:02,4142.60,4143.40,0,3,1,2026-10-21,纽约黄金";',
      'v_sh000300="1~沪深300~000300~0~4152.11";', // 停牌 / 没价 → 丢弃
    ].join("\n");
    const q = parsePulseQuotes(text);
    expect(q["us.INX"]).toEqual({ price: 7727.15, prevClose: 7712.57, change: 14.58, pct: 0.19, time: "2026-10-21 10:43" });
    expect(q.hkHSI).toMatchObject({ price: 23651.87, pct: -0.9, time: "2026-10-21 18:31" });
    expect(q.whUSDCNY).toEqual({ price: 6.6758, prevClose: 6.6781, change: -0.0023, pct: -0.03, time: "2026-10-21 22:43" });
    expect(q.hf_GC).toMatchObject({ price: 4149.04, prevClose: 4142.6, pct: 0.16, time: "2026-10-21 22:43" });
    expect(q.hf_GC.change).toBeCloseTo(6.44, 4);
    expect(q.sh000300).toBeUndefined();
  });
  it("computes change from the previous close when the line lacks it", () => {
    const f = Array(40).fill(""); f[3] = "110"; f[4] = "100";
    expect(parsePulseQuote("sz399006", f.join("~"))).toMatchObject({ change: 10, pct: 10 });
  });
});

describe("kline → sparkline stats", () => {
  it("reads index (day) and stock (qfqday) shapes, oldest first", () => {
    const j = { data: { "us.INX": { day: [["2026-10-16", "1", "102.5", "1", "1", "1", {}], ["2026-10-15", "1", "101", "1", "1", "1"], ["bad", "1", "9"]] } } };
    expect(parseTencentKline(j, "us.INX")).toEqual([["2026-10-15", 101], ["2026-10-16", 102.5]]);
    expect(parseTencentKline({ data: { x: { qfqday: [["2026-01-02", "1", "5"]] } } }, "x")).toEqual([["2026-01-02", 5]]);
    expect(parseTencentKline(null, "x")).toEqual([]);
  });
  it("downsamples, pins the last point to the live price and measures the drawdown", () => {
    const rows = Array.from({ length: 250 }, (_, i) => [`2026-01-${String(i).padStart(3, "0")}`, 100 + i]); // 100 → 349
    const st = klineStats(rows, 300, 60);
    expect(st.spark.length).toBeLessThanOrEqual(60);
    expect(st.spark[st.spark.length - 1]).toBe(300);
    expect(st).toMatchObject({ chg1y: 200, hi: 349, lo: 100 });
    expect(st.fromHigh).toBeCloseTo((300 / 349 - 1) * 100, 0);
    expect(klineStats([["2026-01-01", 1]], 1)).toBe(null);
  });
});

describe("fetchPulse", () => {
  const enc = (s) => new TextEncoder().encode(s);
  it("only requests the asked-for markets and marks failed series as missing", async () => {
    const urls = [];
    const fake = async (url) => {
      urls.push(url);
      if (url.startsWith("https://qt.gtimg.cn/")) {
        const f = Array(40).fill("0"); f[3] = "200"; f[4] = "198"; f[30] = "20261021161500"; f[31] = "2"; f[32] = "1.01";
        return { ok: true, arrayBuffer: async () => enc(`v_sh000001="${f.join("~")}";`).buffer };
      }
      if (url.includes("sh000001")) return { ok: true, json: async () => ({ data: { sh000001: { day: [["2026-10-20", "0", "190"], ["2026-10-21", "0", "199"]] } } }) };
      return { ok: false, status: 500 };
    };
    const r = await fetchPulse(fake, ["cn"], { cross: false });
    expect(urls.some((u) => /us\.INX|hkHSI|whUSDCNY/.test(u))).toBe(false);
    expect(urls.filter((u) => u.includes("fqkline")).length).toBe(3);
    const [sse, csi, chinext] = r.markets.cn;
    expect(sse).toMatchObject({ key: "sse", price: 200, pct: 1.01, chg1y: 5.3 });
    expect(sse.spark).toEqual([190, 200]);
    expect(csi).toEqual({ key: "csi300", missing: true });
    expect(chinext.missing).toBe(true);
    expect(r.cross).toBeUndefined();
    expect(Object.keys(r.errors).length).toBe(2);
  });
});
