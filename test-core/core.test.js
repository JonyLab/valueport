import { describe, it, expect } from "vitest";
import { computeAnchors, priceToPhi, verdictOf, structValid, SEG, N, ZONES, applyZoneColors, DEFAULT_ZONE_COLORS } from "../public/shared/core.js";

describe("computeAnchors", () => {
  it("derives t1..t4 from fair range, mos, ext", () => {
    const a = computeAnchors({ fairLow: 200, fairHigh: 300, mos: 20, ext: 25 });
    expect(a[0]).toBe(0);
    expect(a[1]).toBeCloseTo(160);
    expect(a[2]).toBe(200);
    expect(a[3]).toBe(300);
    expect(a[4]).toBeCloseTo(375);
    expect(a[5]).toBe(Infinity);
  });
});

describe("priceToPhi", () => {
  const anchors = computeAnchors({ fairLow: 200, fairHigh: 300, mos: 20, ext: 25 });
  it("returns 0 for non-positive price", () => {
    expect(priceToPhi(anchors, 0)).toBe(0);
  });
  it("maps fair-range midpoint into the fair band", () => {
    const phi = priceToPhi(anchors, 250);
    expect(phi).toBeGreaterThan(SEG * 2);
    expect(phi).toBeLessThan(SEG * 3);
  });
  it("caps extreme overvalue below 180", () => {
    expect(priceToPhi(anchors, 100000)).toBeLessThanOrEqual(179);
  });
  it("maps deep-value price into the first band", () => {
    expect(priceToPhi(anchors, 80)).toBeCloseTo(18);
  });
});

describe("verdictOf", () => {
  it("flags undervalue with margin-of-safety pct", () => {
    const v = verdictOf({ symbol: "usX", price: 160, fairLow: 200, fairHigh: 300 });
    expect(v.cls).toBe("v-under");
    expect(v.text).toContain("安全边际");
  });
  it("flags overvalue", () => {
    const v = verdictOf({ symbol: "usX", price: 360, fairLow: 200, fairHigh: 300 });
    expect(v.cls).toBe("v-over");
  });
  it("reports waiting state when no symbol", () => {
    expect(verdictOf({ symbol: null, price: 0 }).text).toBe("未选择标的");
  });
});

describe("structValid", () => {
  it("accepts a valid config", () => {
    expect(structValid({ fairLow: 200, fairHigh: 300, mos: 20, ext: 25 })).toBe(true);
  });
  it("rejects fairHigh <= fairLow", () => {
    expect(structValid({ fairLow: 300, fairHigh: 200, mos: 20, ext: 25 })).toBe(false);
  });
  it("rejects mos out of range", () => {
    expect(structValid({ fairLow: 200, fairHigh: 300, mos: 0, ext: 25 })).toBe(false);
  });
  it("rejects ext <= 0", () => {
    expect(structValid({ fairLow: 200, fairHigh: 300, mos: 20, ext: 0 })).toBe(false);
  });
});

describe("zone constants", () => {
  it("keeps SEG, N, and zone count in sync", () => {
    expect(N).toBe(5);
    expect(N * SEG).toBe(180);
  });
});

describe("applyZoneColors", () => {
  it("overrides provided zone colors and falls back to defaults for the rest", () => {
    applyZoneColors({ over: "#ff0000", under: "#00ff00" });
    expect(ZONES.find((z) => z.key === "over").hex).toBe("#ff0000");
    expect(ZONES.find((z) => z.key === "under").hex).toBe("#00ff00");
    expect(ZONES.find((z) => z.key === "deep").hex).toBe(DEFAULT_ZONE_COLORS.deep);
    applyZoneColors({}); // 清空后全部回到默认
    expect(ZONES.find((z) => z.key === "over").hex).toBe(DEFAULT_ZONE_COLORS.over);
  });
});
