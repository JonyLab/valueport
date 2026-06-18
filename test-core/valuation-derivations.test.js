import { describe, it, expect } from "vitest";
import { CAPM, REV_GROWTH, derivationForMeta } from "../public/shared/valuation/derivations.js";

describe("CAPM derivation", () => {
  it("股权成本 = Rf + β×ERP", () => {
    expect(CAPM.compute({ rf: 3, beta: 1.2, erp: 5 }, { meta: "costOfEquity" })).toBeCloseTo(9);
  });
  it("WACC 按股权权重混合税后债务成本", () => {
    // Ke = 3 + 1×5 = 8;ew=80% → 0.8×8 + 0.2×3 = 7
    expect(CAPM.compute({ rf: 3, beta: 1, erp: 5, kd: 3, ew: 80 }, { meta: "wacc" })).toBeCloseTo(7);
  });
  it("costOfEquity 口径忽略债务段", () => {
    expect(CAPM.compute({ rf: 3, beta: 1, erp: 5, kd: 99, ew: 0 }, { meta: "costOfEquity" })).toBeCloseTo(8);
  });
  it("componentsFor 仅 wacc 显示债务行", () => {
    expect(CAPM.componentsFor("costOfEquity").map((c) => c.key)).toEqual(["rf", "beta", "erp"]);
    expect(CAPM.componentsFor("wacc").map((c) => c.key)).toEqual(["rf", "beta", "erp", "kd", "ew"]);
  });
});

describe("revenue-growth derivation", () => {
  it("行业+份额+提价 求和", () => {
    expect(REV_GROWTH.compute({ industry: 4, share: 1, price: 2 })).toBeCloseTo(7);
  });
  it("空值按 0 处理", () => {
    expect(REV_GROWTH.compute({ industry: 8 })).toBeCloseTo(8);
  });
});

describe("derivationForMeta", () => {
  it("字段 meta → 推导", () => {
    expect(derivationForMeta("wacc").id).toBe("capm");
    expect(derivationForMeta("costOfEquity").id).toBe("capm");
    expect(derivationForMeta("revGrowth").id).toBe("revGrowth");
    expect(derivationForMeta("targetPE").id).toBe("multipleAnchor");
    expect(derivationForMeta("targetMultiple").id).toBe("multipleAnchor");
    expect(derivationForMeta("netDebt")).toBe(null);
  });
});
