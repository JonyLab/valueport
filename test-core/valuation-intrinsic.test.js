import { describe, it, expect } from "vitest";
import { INTRINSIC } from "../public/shared/valuation/intrinsic.js";

const fcff = INTRINSIC.find((m) => m.key === "fcff");
const fcfe = INTRINSIC.find((m) => m.key === "fcfe");
const ddm = INTRINSIC.find((m) => m.key === "ddm");

describe("INTRINSIC contract", () => {
  it("exports three intrinsic models with the expected keys", () => {
    expect(INTRINSIC.map((m) => m.key)).toEqual(["fcff", "fcfe", "ddm"]);
    expect(INTRINSIC.every((m) => m.group === "intrinsic")).toBe(true);
    expect(INTRINSIC.every((m) => m.label && m.label.zh && m.label.en)).toBe(true);
    expect(INTRINSIC.every((m) => Array.isArray(m.fields) && typeof m.compute === "function")).toBe(true);
  });

  it("only single fields carry prefill", () => {
    for (const m of INTRINSIC) {
      for (const f of m.fields) {
        if (f.col === "dual") expect(f.prefill).toBeUndefined();
      }
    }
  });
});

describe("FCFF (2-stage)", () => {
  // revenue=1000, n=5, g=10%, opMargin=20%, tax=25%, salesToCap=2,
  // wacc=10%, termGrowth=2%, netDebt=100, shares=100
  // Hand-derived (independent re-computation of the spec formula) -> 22.102272...
  const vals = { revenue: 1000, n: 5, growth: 10, opMargin: 20, taxRate: 25, salesToCap: 2, wacc: 10, termGrowth: 2, netDebt: 100 };

  it("computes per-share fair value", () => {
    expect(fcff.compute(vals, { shares: 100 })).toBeCloseTo(22.102272727, 2);
  });

  it("returns null when wacc <= termGrowth", () => {
    expect(fcff.compute({ ...vals, wacc: 2, termGrowth: 2 }, { shares: 100 })).toBeNull();
  });

  it("returns null when shares <= 0", () => {
    expect(fcff.compute(vals, { shares: 0 })).toBeNull();
  });

  it("returns null on NaN input", () => {
    expect(fcff.compute({ ...vals, growth: NaN }, { shares: 100 })).toBeNull();
  });
});

describe("FCFE (2-stage)", () => {
  // netIncome=1000, g=8%, reinvestRate=40%, ke=10%, n=5, termGrowth=2%, shares=100
  // Hand-derived -> 98.19655947...
  const vals = { netIncome: 1000, growth: 8, reinvestRate: 40, costOfEquity: 10, n: 5, termGrowth: 2 };

  it("computes per-share fair value", () => {
    expect(fcfe.compute(vals, { shares: 100 })).toBeCloseTo(98.19655947, 2);
  });

  it("returns null when costOfEquity <= termGrowth", () => {
    expect(fcfe.compute({ ...vals, costOfEquity: 2, termGrowth: 2 }, { shares: 100 })).toBeNull();
  });

  it("returns null when shares <= 0", () => {
    expect(fcfe.compute(vals, { shares: -5 })).toBeNull();
  });

  it("prefills netIncome from epsTtm * shares", () => {
    const f = fcfe.fields.find((x) => x.k === "netIncome");
    expect(f.prefill({ epsTtm: 5, shares: 100 })).toBe(500);
    expect(f.prefill({ epsTtm: NaN, shares: 100 })).toBe("");
  });
});

describe("DDM (2-stage)", () => {
  // dps=2, g=5%, n=5, ke=10%, termGrowth=2%
  // Hand-derived -> 28.9242378...
  const vals = { dps: 2, growth: 5, n: 5, costOfEquity: 10, termGrowth: 2 };

  it("computes per-share fair value (independent of shares scale)", () => {
    expect(ddm.compute(vals, { shares: 1000 })).toBeCloseTo(28.92423780, 2);
  });

  it("returns null when costOfEquity <= termGrowth", () => {
    expect(ddm.compute({ ...vals, costOfEquity: 2, termGrowth: 2 }, { shares: 1000 })).toBeNull();
  });

  it("returns null when shares <= 0", () => {
    expect(ddm.compute(vals, { shares: 0 })).toBeNull();
  });

  it("prefills dps from price * dividendYield / 100", () => {
    const f = ddm.fields.find((x) => x.k === "dps");
    expect(f.prefill({ price: 100, dividendYield: 3 })).toBeCloseTo(3, 6);
    expect(f.prefill({ price: NaN, dividendYield: 3 })).toBe("");
  });
});
