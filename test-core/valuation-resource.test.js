import { describe, it, expect } from "vitest";
import { assetPV, navPerShare, RESOURCE } from "../public/shared/valuation/resource.js";
import { MODELS } from "../public/shared/valuation/index.js";

const nav = RESOURCE[0];

describe("assetPV (finite-life, no terminal)", () => {
  it("discounts L years of growing cash flow", () => {
    // cf=100, L=3, g=5%, r=10% → 95.4545 + 91.1157 + 86.9742 = 273.5444
    expect(assetPV(100, 3, 0.05, 0.10)).toBeCloseTo(273.5444, 3);
  });
  it("flat cash flow, no growth", () => {
    // cf=50, L=2, g=0, r=10% → 45.4545 + 41.3223 = 86.7769
    expect(assetPV(50, 2, 0, 0.10)).toBeCloseTo(86.7769, 3);
  });
  it("returns NaN on invalid inputs", () => {
    expect(Number.isNaN(assetPV(100, 0, 0.05, 0.1))).toBe(true);
    expect(Number.isNaN(assetPV(NaN, 3, 0.05, 0.1))).toBe(true);
  });
});

describe("navPerShare (SOTP sum, minus net debt)", () => {
  const A = [{ cf: 100, L: 3, growth: { c: 5, o: 5 } }, { cf: 50, L: 2, growth: { c: 0, o: 0 } }];
  it("sums asset PVs and divides by shares", () => {
    // 273.5444 + 86.7769 = 360.3213 ; /10 = 36.0321
    expect(navPerShare(A, "c", 10, 0, 10)).toBeCloseTo(36.0321, 3);
  });
  it("subtracts net debt before per-share", () => {
    // (360.3213 - 100)/10 = 26.0321
    expect(navPerShare(A, "c", 10, 100, 10)).toBeCloseTo(26.0321, 3);
  });
  it("picks the side-specific growth", () => {
    const B = [{ cf: 100, L: 3, growth: { c: 0, o: 10 } }];
    const c = navPerShare(B, "c", 10, 0, 1), o = navPerShare(B, "o", 10, 0, 1);
    expect(o).toBeGreaterThan(c); // 乐观增速更高 → NAV 更高
  });
  it("returns null when no valid asset / bad shares", () => {
    expect(navPerShare([], "c", 10, 0, 10)).toBeNull();
    expect(navPerShare([{ cf: 100, L: 3, growth: { c: 5, o: 5 } }], "c", 10, 0, 0)).toBeNull();
    expect(navPerShare([{ cf: NaN, L: 3, growth: { c: 5, o: 5 } }], "c", 10, 0, 10)).toBeNull();
  });
});

describe("NAVSOTP model", () => {
  it("is registered in MODELS as an intrinsic asset-model", () => {
    const m = MODELS.find((x) => x.key === "navsotp");
    expect(m).toBeTruthy();
    expect(m.group).toBe("intrinsic");
    expect(m.assetModel).toBe(true);
    expect(typeof m.run).toBe("function");
  });
  it("run() returns a low–high range from the two sides", () => {
    const form = { assets: [{ cf: 100, L: 5, growth: { c: 2, o: 8 } }], discount: { c: 10, o: 8 }, netDebt: 0 };
    const r = nav.run(form, { shares: 10 });
    expect(r.low).not.toBeNull();
    expect(r.high).toBeGreaterThan(r.low); // 乐观(低折现+高增速) > 保守
  });
  it("run() null when shares invalid or no assets", () => {
    expect(nav.run({ assets: [], discount: { c: 10, o: 8 }, netDebt: 0 }, { shares: 10 }).low).toBeNull();
    expect(nav.run({ assets: [{ cf: 100, L: 5, growth: { c: 2, o: 8 } }], discount: { c: 10, o: 8 }, netDebt: 0 }, { shares: 0 }).low).toBeNull();
  });
  it("breakdown() reports sum PV, equity NAV and P/NAV", () => {
    const vals = { assets: [{ cf: 100, L: 3, growth: { c: 5, o: 5 } }], discount: 10, netDebt: 0 };
    const rows = nav.breakdown(vals, { shares: 10, price: 20 });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.sumpv).toBeCloseTo(273.5444, 2);
    expect(byKey.equity).toBeCloseTo(273.5444, 2);
    expect(byKey.pnav).toBeCloseTo(20 / 27.35444, 3); // price / 每股NAV
  });
  it("schedule() depletes as assets reach end-of-life, no terminal", () => {
    const vals = { assets: [{ cf: 100, L: 3, growth: { c: 0, o: 0 } }, { cf: 50, L: 2, growth: { c: 0, o: 0 } }], discount: 10 };
    const s = nav.schedule(vals);
    expect(s.rows.length).toBe(3);          // maxL = 3
    expect(s.rows[0].cf).toBeCloseTo(150, 6); // yr1: both assets
    expect(s.rows[2].cf).toBeCloseTo(100, 6); // yr3: only asset-1 (asset-2 depleted after yr2)
    expect(s.terminalPv).toBeNull();          // 无永续项
  });
});
