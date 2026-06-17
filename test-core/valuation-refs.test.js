import { describe, it, expect } from "vitest";
import { buildValuationRefs } from "../src/longbridge.js";

describe("buildValuationRefs", () => {
  const dist = { pe: { value: 35.86, median: 26.37 }, pb: { value: 41.27, median: 2.18 }, ps: { value: 9.74, median: 0.85 } };
  const comp = { pe: [30, 32, 34, 40, 28, 31], pb: [38, 39, 40, 41], ps: [6, 7, 7.5, 9] };
  it("combines current/own5y(median)/industryMedian per multiple", () => {
    const r = buildValuationRefs(dist, comp);
    expect(r.pe.current).toBeCloseTo(35.86, 2);
    expect(r.pe.industryMedian).toBeCloseTo(26.37, 2);
    expect(r.pe.own5y).toBeCloseTo(31.5, 1); // median of [28,30,31,32,34,40] = (31+32)/2
  });
  it("returns null when nothing usable", () => {
    expect(buildValuationRefs(null, null)).toBe(null);
  });
  it("tolerates missing own history (own5y null)", () => {
    const r = buildValuationRefs(dist, null);
    expect(r.pe.own5y).toBe(null);
    expect(r.pe.current).toBeCloseTo(35.86, 2);
  });
});
