import { describe, it, expect } from "vitest";
import { annuityFactor, assetResetValue, navPerShare, normCdf, blackScholesCall, optionValue, COMMODITIES, RESOURCE } from "../public/shared/valuation/resource.js";
import { MODELS } from "../public/shared/valuation/index.js";

const nav = RESOURCE[0];
const priceConst = (v) => () => v; // 固定价解析器

describe("annuityFactor", () => {
  it("matches Damodaran annuity factors at 7% (mockup 折现系数)", () => {
    expect(annuityFactor(25, 7)).toBeCloseTo(11.65, 2); // 卡莫阿 25年 → ~11.7
    expect(annuityFactor(30, 7)).toBeCloseTo(12.41, 2); // 巨龙 30年 → ~12.4
    expect(annuityFactor(20, 7)).toBeCloseTo(10.59, 2); // 佩吉 20年 → ~10.6
    expect(annuityFactor(15, 7)).toBeCloseTo(9.108, 2); // 金矿 15年 → ~9.1
  });
  it("degenerates to L when wacc<=0; NaN when L<=0", () => {
    expect(annuityFactor(10, 0)).toBe(10);
    expect(Number.isNaN(annuityFactor(0, 7))).toBe(true);
  });
});

describe("assetResetValue (commodity-driven mine)", () => {
  it("reproduces 卡莫阿铜矿: 17.5万吨×(77000−20000)×0.75 → 74.8亿/年; ×11.65 → 871亿", () => {
    const a = { type: "mine", commodity: "copper", output: 17.5, unitCost: 20000, life: 25 };
    // 税后年现金流单独核验
    const af = annuityFactor(25, 7);
    const v = assetResetValue(a, priceConst(77000), 7, 25);
    const cfYear = 17.5 * COMMODITIES.copper.toBase * (77000 - 20000) * 0.75; // 元/年
    expect(cfYear / 1e8).toBeCloseTo(74.8, 1);   // ≈74.8亿/年（mockup）
    expect(v / 1e8).toBeCloseTo(871.8, 0);        // ≈871.8亿（mockup）
    expect(v).toBeCloseTo(cfYear * af, 4);        // 与公式自洽
  });
  it("reproduces 武里蒂卡金矿: 5.8吨×(720−190)×0.75 → 23.1亿/年", () => {
    const a = { type: "mine", commodity: "gold", output: 5.8, unitCost: 190, life: 15 };
    const cfYear = 5.8 * COMMODITIES.gold.toBase * (720 - 190) * 0.75;
    expect(cfYear / 1e8).toBeCloseTo(23.1, 1); // ≈23.1亿/年（mockup）
    expect(assetResetValue(a, priceConst(720), 7, 25)).toBeCloseTo(cfYear * annuityFactor(15, 7), 4);
  });
  it("fixed-value pack returns its value verbatim (锂/期权现值)", () => {
    expect(assetResetValue({ type: "fixed", value: 300e8 }, priceConst(0), 7, 25)).toBe(300e8);
  });
  it("loss-making mine (cost>price) yields negative value", () => {
    const a = { type: "mine", commodity: "copper", output: 10, unitCost: 90000, life: 10 };
    expect(assetResetValue(a, priceConst(77000), 7, 25)).toBeLessThan(0);
  });
  it("NaN on missing inputs", () => {
    expect(Number.isNaN(assetResetValue({ type: "mine", commodity: "copper", output: NaN, unitCost: 1, life: 10 }, priceConst(7e4), 7, 25))).toBe(true);
  });
});

describe("navPerShare + run (SOTP sum − net debt)", () => {
  // 简化两资产组合
  const form = {
    assets: [
      { type: "mine", commodity: "copper", output: 17.5, unitCost: 20000, life: 25 },
      { type: "fixed", value: 300e8 },
    ],
    prices: { copper: { c: 70000, o: 84000 } },
    taxRate: 25, netDebt: 1200e8, wacc: { c: 8, o: 7 },
  };
  it("sums asset values, subtracts net debt, divides by shares", () => {
    const ps = navPerShare(form, { shares: 1e10 }, priceConst(77000), 7);
    // (871.x亿 + 300亿 − 1200亿) / 1e10
    const expected = (assetResetValue(form.assets[0], priceConst(77000), 7, 25) + 300e8 - 1200e8) / 1e10;
    expect(ps).toBeCloseTo(expected, 4);
  });
  it("run() returns low–high; 乐观(高价+低WACC) > 保守(低价+高WACC)", () => {
    const r = nav.run(form, { shares: 1e10 });
    expect(r.low).not.toBeNull();
    expect(r.high).toBeGreaterThan(r.low);
  });
  it("run() null when shares invalid", () => {
    expect(nav.run(form, { shares: 0 }).low).toBeNull();
  });
});

describe("Black–Scholes 未开发储量期权 (natres.xls)", () => {
  it("normCdf matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 4);
    expect(normCdf(1.1312)).toBeCloseTo(0.8710, 3);
    expect(normCdf(0.18254)).toBeCloseTo(0.5724, 3);
  });
  it("reproduces natres.xls option value ≈ 472,622", () => {
    // S=125万, K=100万, T=10, σ=0.3, rf=0.08, y=0.04
    const v = blackScholesCall(1.25e6, 1e6, 10, 0.3, 0.08, 0.04);
    expect(v).toBeCloseTo(472622, -3); // 误差<500
  });
  it("NaN when out-of-the-money (S<=0) or bad inputs", () => {
    expect(Number.isNaN(blackScholesCall(0, 1e6, 10, 0.3, 0.08, 0))).toBe(true);
    expect(Number.isNaN(blackScholesCall(1e6, 1e6, 10, 0, 0.08, 0))).toBe(true);
  });
  it("optionValue derives S from macro price; rises with commodity price", () => {
    const opt = { type: "option", commodity: "copper", reserves: 50, marginalCost: 30000, devCost: 2e10, sigma: 30, years: 10, rf: 3, annualCf: 0 };
    const lo = optionValue(opt, () => 70000), hi = optionValue(opt, () => 90000);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(lo); // 价高 → 期权更值钱
  });
  it("assetResetValue dispatches option type", () => {
    const opt = { type: "option", commodity: "gold", reserves: 100, marginalCost: 200, devCost: 1e10, sigma: 35, years: 8, rf: 3, annualCf: 0 };
    expect(assetResetValue(opt, () => 700, 7, 25)).toBeCloseTo(optionValue(opt, () => 700), 6);
  });
});

describe("NAVSOTP integration", () => {
  it("registered as intrinsic asset-model with run()", () => {
    const m = MODELS.find((x) => x.key === "navsotp");
    expect(m && m.group).toBe("intrinsic");
    expect(m.assetModel).toBe(true);
    expect(typeof m.run).toBe("function");
  });
  it("breakdown reports sum value, equity NAV, P/NAV", () => {
    const vals = { assets: [{ type: "mine", commodity: "copper", output: 17.5, unitCost: 20000, life: 25 }], prices: { copper: { c: 77000, o: 77000 } }, taxRate: 25, netDebt: 0, wacc: 7 };
    const rows = nav.breakdown(vals, { shares: 1e10, price: 10 });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.sumpv).toBeGreaterThan(800e8);
    expect(byKey.equity).toBeCloseTo(byKey.sumpv, 6); // netDebt 0
    expect(byKey.pnav).toBeCloseTo(10 / (byKey.equity / 1e10), 4);
  });
  it("schedule: flat CF, depletes at end-of-life, no terminal", () => {
    const vals = { assets: [
      { type: "mine", commodity: "copper", output: 10, unitCost: 0, life: 3 },
      { type: "mine", commodity: "copper", output: 10, unitCost: 0, life: 2 },
      { type: "fixed", value: 50e8 },
    ], prices: { copper: { c: 1, o: 1 } }, taxRate: 0, wacc: 10 };
    const s = nav.schedule(vals);
    expect(s.rows.length).toBe(3);
    expect(s.rows[0].cf).toBeCloseTo(2 * 10 * 1e4 * 1, 6); // 两矿在产
    expect(s.rows[2].cf).toBeCloseTo(1 * 10 * 1e4 * 1, 6); // 仅长寿命矿
    expect(s.terminalPv).toBeNull();
  });

  it("reproduces the Zijin mockup total ≈ 12082 亿 (B-S option as fixed pack)", () => {
    // 各在产矿用 mockup 的产量/成本/寿命 + 全局价 金720 铜77000，税25%，WACC7%
    const px = { gold: { c: 720, o: 720 }, copper: { c: 77000, o: 77000 } };
    const mine = (commodity, output, unitCost, life) => ({ type: "mine", commodity, output, unitCost, life });
    const assets = [
      mine("copper", 17.5, 20000, 25),   // 卡莫阿
      mine("copper", 20, 28000, 30),     // 巨龙二期
      mine("copper", 17, 15000, 20),     // 佩吉
      mine("copper", 96, 30000, 20),     // 其余中小铜矿
      mine("gold", 5.8, 190, 15),        // 武里蒂卡
      mine("gold", 7.5, 280, 15),        // 罗斯贝尔
      mine("gold", 147, 260, 20),        // 其余老金矿
      { type: "fixed", value: 300e8 },   // 锂板块
      { type: "fixed", value: 968e8 },   // 地下未开发期权（B-S 现值，暂作固定包）
    ];
    const form = { assets, prices: px, taxRate: 25, netDebt: 1200e8, wacc: { c: 7, o: 7 } };
    const ps = navPerShare(form, { shares: 1e10 }, (c) => px[c].c, 7);
    const totalEquity = ps * 1e10; // 元
    expect(Math.abs(totalEquity / 1e8 - 12082)).toBeLessThan(1.5); // 复刻 mockup 内在价值，误差<1.5亿
  });
});
