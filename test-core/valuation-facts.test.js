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
    expect(en).toContain("Pays a dividend of ~0.3");
  });
  it("copes with no financials", () => {
    expect(verifiedFacts({ financials: null, dividends: null, dps: NaN })).toEqual(["没有查到现金分红记录：视为不分红，不要说它「分红稳定」，也不要推荐股息折现（DDM）"]);
  });
});
