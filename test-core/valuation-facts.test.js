import { describe, it, expect } from "vitest";
import { verifiedFacts } from "../public/shared/valuation/facts.js";

// 长桥年报形状：values 最新在前；单位：元
const B = 1e9;
const acct = (field, pairs) => ({ field, values: pairs.map(([year, v]) => ({ year, value: v * B })).reverse() });
// 小米 2018–2025（亿元级数据按 B 记）：自由现金流 2021、2022 为负，不派现金股息，2025 资本开支大增
const XIAOMI = {
  IS: [acct("OperatingRevenue", [[2018, 205.9], [2019, 232.9], [2020, 277.8], [2021, 395.1], [2022, 324.0], [2023, 297.6], [2024, 396.1], [2025, 500.0]]),
       acct("NetProfit", [[2018, 16.0], [2019, 11.4], [2020, 23.0], [2021, 23.3], [2022, 2.9], [2023, 19.2], [2024, 25.6], [2025, 45.5]])],
  CF: [acct("NetFreeCashFlow", [[2018, 6.0], [2019, 22.1], [2020, 24.5], [2021, -1.9], [2022, -11.3], [2023, 38.0], [2024, 38.7], [2025, 18.6]]),
       acct("CapEx", [[2022, -6.7], [2023, -6.9], [2024, -7.9], [2025, -14.0]])],
  BS: [acct("NetDebt", [[2024, -68.6], [2025, -73.3]])],
};

describe("verifiedFacts", () => {
  it("states Xiaomi's cash flow and earnings are unstable and that it pays no dividend", () => {
    const f = verifiedFacts({ financials: XIAOMI, dividends: null, dps: NaN, lang: "zh" }).join("\n");
    expect(f).toContain("2021、2022 年为负");
    expect(f).toContain("现金流不稳定");
    expect(f).toContain("2022 年较上年腰斩以上");
    expect(f).toContain("盈利波动较大");
    expect(f).toContain("2022、2023 年营收同比下滑");
    expect(f).toContain("资本开支明显上升");
    expect(f).toContain("净现金 73.3B");
    expect(f).toContain("没有查到现金分红记录");
  });
  it("does not judge free cash flow for financial companies", () => {
    const f = verifiedFacts({ financials: XIAOMI, dividends: null, dps: NaN, financial: true, lang: "zh" }).join("\n");
    expect(f).toContain("金融企业"); expect(f).not.toContain("现金流不稳定"); expect(f).toContain("盈利波动较大");
  });
  it("recognises steady cash flow and a dividend history", () => {
    const steady = {
      IS: [acct("NetProfit", [[2021, 10], [2022, 11], [2023, 12], [2024, 12.5]])],
      CF: [acct("NetFreeCashFlow", [[2021, 9], [2022, 10], [2023, 11], [2024, 11.5]])],
    };
    const div = { currency: "HKD", years: [{ year: 2022, perShare: 0.5 }, { year: 2023, perShare: 0.6 }, { year: 2024, perShare: 0.7 }] };
    const f = verifiedFacts({ financials: steady, dividends: div, lang: "zh" }).join("\n");
    expect(f).toContain("现金流较稳定");
    expect(f).toContain("盈利较稳定");
    expect(f).toContain("连续派息 3 年");
    const en = verifiedFacts({ financials: steady, dividends: null, dps: 0.3, lang: "en" }).join("\n");
    expect(en).toContain("~0.3 per share (no full history)");
  });
  it("judges a steadily growing company (Microsoft-like) as stable growth, not volatile", () => {
    const years = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
    const msft = {
      IS: [acct("NetProfit", [17, 21, 16, 39, 44, 61, 73, 72, 88, 102].map((v, i) => [years[i], v]))],
      CF: [acct("NetFreeCashFlow", [25, 31, 32, 38, 45, 56, 65, 59, 74, 72].map((v, i) => [years[i], v]))],
    };
    const f = verifiedFacts({ financials: msft, dividends: null, lang: "zh" }).join("\n");
    expect(f).toContain("判断：盈利稳定增长");
    expect(f).toContain("判断：现金流稳定增长、可预测");
    expect(f).not.toContain("波动较大");
    expect(f).not.toContain("现金流不稳定");
    const en = verifiedFacts({ financials: msft, dividends: null, lang: "en" }).join("\n");
    expect(en).toContain("Verdict: earnings growing steadily");
    expect(en).toContain("Verdict: cash flow growing steadily and predictable");
  });
  it("still judges flat noisy series by the old rule", () => {
    const years = [2019, 2020, 2021, 2022, 2023, 2024];
    const mk = (ni, fcf) => ({ IS: [acct("NetProfit", ni.map((v, i) => [years[i], v]))], CF: [acct("NetFreeCashFlow", fcf.map((v, i) => [years[i], v]))] });
    // 没有趋势、来回波动但没腰斩、没负值：变异系数不高，仍是「较稳定」，不说「增长」
    const flat = verifiedFacts({ financials: mk([10, 18, 9.5, 17, 9.2, 16.5], [10, 17, 9.5, 16, 9.5, 15]), dividends: null, lang: "zh" }).join("\n");
    expect(flat).toContain("盈利较稳定"); expect(flat).toContain("现金流较稳定"); expect(flat).not.toContain("稳定增长");
    // 有腰斩 / 负值仍然不稳定
    const bad = verifiedFacts({ financials: mk([10, 18, 8, 15, 9, 16], [10, 17, -2, 16, 9, 15]), dividends: null, lang: "zh" }).join("\n");
    expect(bad).toContain("盈利波动较大"); expect(bad).toContain("现金流不稳定");
  });
  it("says DDM doesn't fit a low-payout buyback company like Apple, but fits a high-payout steady payer", () => {
    // 苹果：EPS 6.1→7.5、净利 ~1000 亿，股数逐年下降；每股股息 ~1 美元，分红率 ~14%、股息率 ~0.4%
    const apple = {
      IS: [acct("NetProfit", [[2020, 57.4], [2021, 94.7], [2022, 99.8], [2023, 97.0], [2024, 93.7], [2025, 112.0]]),
           { field: "EPS", values: [[2025, 7.46], [2024, 6.08], [2023, 6.13], [2022, 6.11], [2021, 5.61], [2020, 3.28]].map(([year, value]) => ({ year, value })) }],
    };
    const div = { currency: "USD", years: [2019, 2020, 2021, 2022, 2023, 2024, 2025].map((y, i) => ({ year: y, perShare: 0.75 + i * 0.05 })).concat([{ year: 2099, perShare: 0.27 }]) };
    const f = verifiedFacts({ financials: apple, dividends: div, dps: 1.05, price: 260, eps: 7.46, lang: "zh" }).join("\n");
    expect(f).toMatch(/流通股数 2020–2025 减少 \d+%（持续回购）/);
    expect(f).toContain("股息率约 0.4%");
    expect(f).toContain("分红率（股息 / 每股收益）约 14%");
    expect(f).toContain("股息折现（DDM）不适合做主方法");
    expect(f).not.toContain("2099"); // 当年没派完的不算最近完整年度
    // 年报 EPS 只在美元派息时用（无行情数据）
    const f2 = verifiedFacts({ financials: apple, dividends: div, lang: "zh" }).join("\n");
    expect(f2).toContain("分红率（股息 / 每股收益）约 14%");
    const hk = verifiedFacts({ financials: apple, dividends: { ...div, currency: "HKD" }, lang: "zh" }).join("\n");
    expect(hk).not.toContain("分红率（股息"); // 港币派息不和年报 EPS 相除
    expect(hk).toContain("DDM 只宜作交叉验证");
    // 高分红稳定派息：分红率 60%、股息率 5%、连续 7 年
    const utility = verifiedFacts({ financials: null, dividends: div, dps: 1.2, price: 24, eps: 2, lang: "zh" }).join("\n");
    expect(utility).toContain("股息折现（DDM）可以作为主方法");
  });
  it("copes with no financials", () => {
    expect(verifiedFacts({ financials: null, dividends: null, dps: NaN })).toEqual(["没有查到现金分红记录：视为不分红，不要说它「分红稳定」，也不要推荐股息折现（DDM）"]);
  });
});

import { latestMetrics } from "../public/shared/valuation/facts.js";
describe("latestMetrics", () => {
  const fin = {
    IS: [acct("OperatingRevenue", [[2021, 100], [2022, 110], [2023, 121], [2024, 133.1]]), acct("NetProfit", [[2021, 10], [2022, 12], [2023, 13], [2024, 13]]),
         acct("OperatingIncome", [[2021, 15], [2022, 16.5], [2023, 18.15], [2024, 26.62]])],
    CF: [acct("NetFreeCashFlow", [[2023, 10], [2024, 8]])],
  };
  const finQ = { IS: [{ field: "OperatingRevenue", values: [{ year: 2025, period: "Q2 2025", value: 40 * B, yoy: "12.50" }] }, { field: "NetProfit", values: [{ year: 2025, period: "Q2 2025", value: 4 * B, yoy: "-3.20" }] }] };
  const refs = { pe: { current: 20, own5y: 25, industryMedian: 18 }, pb: { current: 3.2, own5y: null } };
  it("summarises growth, margins, the latest quarter and multiples", () => {
    const m = latestMetrics({ financials: fin, financialsQ: finQ, valuationRefs: refs, valuedAt: "2024-06-01T00:00:00Z", lang: "zh" }).join("\n");
    expect(m).toContain("最新年报：FY2024（估值做于 2024-06-01，之后可能已有新年报）");
    expect(m).toContain("营收增速：最新年同比 +10.00%，近三年复合 +10.00%");
    expect(m).toContain("净利润增速：最新年同比 +0.00%");
    expect(m).toContain("自由现金流增速：最新年同比 -20.00%");
    expect(m).toContain("营业利润率：最新 20.00%，前三年均值 15.00%");
    expect(m).toContain("最新季度 Q2 2025：营收同比 +12.50%，净利润同比 -3.20%");
    expect(m).toContain("当前 P/E 20.00，自身五年中位 25.00，行业中位 18.00");
    expect(m).toContain("当前 P/B 3.20");
  });
  it("returns nothing without data", () => {
    expect(latestMetrics({})).toEqual([]);
  });
});

import { assumptionChecks } from "../public/shared/valuation/facts.js";
describe("assumptionChecks", () => {
  const fin = {
    IS: [acct("OperatingRevenue", [[2021, 100], [2022, 110], [2023, 121], [2024, 133.1]]), acct("NetProfit", [[2021, 10], [2022, 11], [2023, 12], [2024, 9]])],
  };
  const refs = { pe: { current: 18.1, own5y: 26 } };
  it("places the actual value against the conservative / optimistic cases", () => {
    const fields = [
      { k: "growth", label: "营收增速", meta: "revGrowth", col: "dual", unit: "%", value: { c: 12, o: 20 } },
      { k: "targetPE", label: "目标 PE", meta: "targetPE", col: "dual", unit: "", value: { c: 15, o: 25 } },
      { k: "netMargin", label: "净利率", meta: "netMargin", col: "dual", unit: "%", value: { c: 5, o: 8 } },
      { k: "revenue", label: "当前营收", meta: "revenue", col: "single", unit: "", value: 120 * B },
      { k: "wacc", label: "WACC", meta: "wacc", col: "dual", unit: "%", value: { c: 10, o: 8 } },
    ];
    const m = assumptionChecks({ fields, financials: fin, valuationRefs: refs, lang: "zh" });
    expect(m).toContain("growth（营收增速）：当初 保守 12 / 乐观 20；营收近三年复合增速 10.0% → 低于两档");
    expect(m).toContain("targetPE（目标 PE）：当初 保守 15 / 乐观 25；当前倍数 18.1 → 落在两档之间；自身五年中位 26.0（高于两档）");
    expect(m).toContain("netMargin（净利率）：当初 保守 5 / 乐观 8；最新净利率 6.8% → 落在两档之间");
    expect(m).toContain("revenue（当前营收）：当初填 120.0B，最新年报 133.1B（高 10.9%）");
    expect(m.some((x) => x.startsWith("wacc"))).toBe(false);
  });
});

import { marketViews, masterLenses } from "../public/shared/valuation/facts.js";
describe("marketViews / masterLenses", () => {
  const research = { rating: { buy: 19, over: 6, hold: 13, under: 3, sell: 3, total: 46, targetHigh: 405, targetLow: 215, prevClose: 343.46 }, forecastEps: { median: 9.235, mean: 9.287, low: 8.292, high: 10.454 } };
  const fin = {
    IS: [{ field: "EPS", values: [[2025, 7.46], [2024, 6.08], [2023, 6.13]].map(([year, value]) => ({ year, value })) },
         { field: "ROEDf", values: [[2025, 171.4], [2024, 157.4], [2023, 171.9], [2022, 175.5], [2021, 150.1]].map(([year, value]) => ({ year, value })) },
         acct("NetProfit", [[2022, 99.8], [2023, 97.0], [2024, 93.7], [2025, 112.0]])],
    CF: [acct("NetFreeCashFlow", [[2023, 99.6], [2024, 108.8], [2025, 98.8]])],
    BS: [acct("NetDebt", [[2025, -20.0]])],
  };
  it("summarises analyst ratings, targets and consensus EPS", () => {
    const m = marketViews({ research, financials: fin, price: 343.46, market: "us", lang: "zh" }).join("\n");
    expect(m).toContain("分析师评级（46 家）：看多 25（买入 19、增持 6），中性 13，看空 6（看多占 54%）");
    expect(m).toContain("目标价 215–405，中值 310.00（较现价 -9.7%）");
    expect(m).toContain("较最新年报 EPS 7.46（FY2025）增长 23.8%");
    expect(m).toContain("远期市盈率约 37.2");
    expect(marketViews({ research, financials: fin, price: 417.8, market: "hk", lang: "zh" }).join("\n")).not.toContain("远期市盈率");
    expect(marketViews({ research: null })).toEqual([]);
  });
  it("applies Graham, Lynch and Buffett yardsticks with a disclaimer", () => {
    const m = masterLenses({ financials: fin, research, price: 343.46, eps: 8.83, bps: 7.37, lang: "zh" }).join("\n");
    expect(m).toMatch(/按格雷厄姆的方法：PE 38\.9、PB 46\.6，PE×PB = \d+（标准 ≤ 22\.5）/);
    expect(m).toContain("不满足");
    expect(m).toContain("按林奇的方法：PEG = PE 38.9 ÷ 一致预期 EPS 增速 23.8% = 1.63（< 1 便宜、1–2 合理、> 2 偏贵 → 合理）");
    expect(m).toMatch(/按巴菲特看重的：所有者收益率约 2\.6%.*ROE 均值 165%、最低 150%（持续高于 15%），账上净现金/);
    expect(m).toContain("不代表他们本人对这只股票的看法");
    expect(masterLenses({})).toEqual([]);
  });
});
