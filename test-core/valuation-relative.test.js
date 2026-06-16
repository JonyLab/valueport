import { describe, it, expect } from "vitest";
import { RELATIVE } from "../public/shared/valuation/relative.js";

const model = (key) => RELATIVE.find((m) => m.key === key);

describe("RELATIVE shape", () => {
  it("exports five relative models with stable keys", () => {
    expect(RELATIVE.map((m) => m.key)).toEqual(["pe", "peg", "pb", "ps", "evebitda"]);
    for (const m of RELATIVE) {
      expect(m.group).toBe("relative");
      expect(typeof m.compute).toBe("function");
      expect(m.label.zh && m.label.en).toBeTruthy();
      expect(Array.isArray(m.fields)).toBe(true);
    }
  });
});

describe("PE compute", () => {
  const m = model("pe");
  const ctx = { price: 0, epsTtm: 0, bps: 0, shares: 100, dividendYield: 0 };
  it("futRev*netMargin/shares*targetPE", () => {
    // futRev = 1000 * 1.1^5 = 1610.51005; eps = 1610.51005*0.15/100 = 2.4157651; *20
    const v = m.compute({ revenue: 1000, n: 5, growth: 10, netMargin: 15, targetPE: 20 }, ctx);
    expect(v).toBeCloseTo(48.3153, 2);
  });
  it("returns null when shares <= 0", () => {
    expect(m.compute({ revenue: 1000, n: 5, growth: 10, netMargin: 15, targetPE: 20 }, { ...ctx, shares: 0 })).toBeNull();
  });
  it("returns null on NaN input", () => {
    expect(m.compute({ revenue: NaN, n: 5, growth: 10, netMargin: 15, targetPE: 20 }, ctx)).toBeNull();
  });
});

describe("PEG compute", () => {
  const m = model("peg");
  const ctx = { price: 0, epsTtm: 2, bps: 0, shares: 100, dividendYield: 0 };
  it("uses peg × raw-growth-number (NOT /100)", () => {
    // impliedPE = 1.5 * 20 = 30; fair = 2 * 30 = 60
    const v = m.compute({ eps: 2, growth: 20, peg: 1.5 }, ctx);
    expect(v).toBeCloseTo(60, 2);
  });
  it("returns null when eps is NaN", () => {
    expect(m.compute({ eps: NaN, growth: 20, peg: 1.5 }, ctx)).toBeNull();
  });
  it("prefills eps from ctx.epsTtm when finite", () => {
    expect(m.fields.find((f) => f.k === "eps").prefill(ctx)).toBe(2);
    expect(m.fields.find((f) => f.k === "eps").prefill({ ...ctx, epsTtm: NaN })).toBe("");
  });
});

describe("PB compute", () => {
  const m = model("pb");
  const ctx = { price: 0, epsTtm: 0, bps: 10, shares: 100, dividendYield: 0 };
  it("bps * targetPB", () => {
    expect(m.compute({ bps: 10, targetPB: 2 }, ctx)).toBeCloseTo(20, 2);
  });
  it("returns null on NaN input", () => {
    expect(m.compute({ bps: NaN, targetPB: 2 }, ctx)).toBeNull();
  });
  it("prefills bps from ctx.bps", () => {
    expect(m.fields.find((f) => f.k === "bps").prefill(ctx)).toBe(10);
  });
});

describe("PS compute", () => {
  const m = model("ps");
  const ctx = { price: 0, epsTtm: 0, bps: 0, shares: 100, dividendYield: 0 };
  it("futRev*targetPS/shares", () => {
    // futRev = 1000*1.1^5 = 1610.51005; *5/100 = 80.5255
    expect(m.compute({ revenue: 1000, n: 5, growth: 10, targetPS: 5 }, ctx)).toBeCloseTo(80.5255, 2);
  });
  it("returns null when shares <= 0", () => {
    expect(m.compute({ revenue: 1000, n: 5, growth: 10, targetPS: 5 }, { ...ctx, shares: -1 })).toBeNull();
  });
  it("returns null on NaN input", () => {
    expect(m.compute({ revenue: 1000, n: 5, growth: NaN, targetPS: 5 }, ctx)).toBeNull();
  });
});

describe("EV/EBITDA compute", () => {
  const m = model("evebitda");
  const ctx = { price: 0, epsTtm: 0, bps: 0, shares: 100, dividendYield: 0 };
  it("(ev - netDebt)/shares", () => {
    // futEbitda = 500*1.1^5 = 805.255; ev = *12 = 9663.06; (9663.06-200)/100 = 94.6306
    expect(m.compute({ ebitda: 500, n: 5, growth: 10, targetMultiple: 12, netDebt: 200 }, ctx)).toBeCloseTo(94.6306, 2);
  });
  it("returns null when shares <= 0", () => {
    expect(m.compute({ ebitda: 500, n: 5, growth: 10, targetMultiple: 12, netDebt: 200 }, { ...ctx, shares: 0 })).toBeNull();
  });
  it("returns null on NaN input", () => {
    expect(m.compute({ ebitda: 500, n: 5, growth: 10, targetMultiple: NaN, netDebt: 200 }, ctx)).toBeNull();
  });
});
