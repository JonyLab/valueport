import { describe, it, expect } from "vitest";
import { usTicker, parseAdjustedEps } from "../src/finnhub.js";

describe("usTicker", () => {
  it("美股去前缀转大写", () => {
    expect(usTicker("usAAPL")).toBe("AAPL");
    expect(usTicker("usmsft")).toBe("MSFT");
    expect(usTicker("usBRK.B")).toBe("BRK.B");
  });
  it("非美股(A股/港股)→ null", () => {
    expect(usTicker("sh688981")).toBe(null);
    expect(usTicker("hk00700")).toBe(null);
    expect(usTicker("")).toBe(null);
  });
});

describe("parseAdjustedEps", () => {
  it("优先取 TTM(epsExclExtraItemsTTM)", () => {
    const json = { metric: { epsExclExtraItemsTTM: 8.2666, epsNormalizedAnnual: 7.465 } };
    expect(parseAdjustedEps(json)).toBe(8.2666);
  });
  it("TTM 缺失则回退年度 normalized", () => {
    const json = { metric: { epsExclExtraItemsTTM: null, epsNormalizedAnnual: 7.465 } };
    expect(parseAdjustedEps(json)).toBe(7.465);
  });
  it("无 metric / 结构异常 → null", () => {
    expect(parseAdjustedEps({ metric: {} })).toBe(null);
    expect(parseAdjustedEps(null)).toBe(null);
    expect(parseAdjustedEps({})).toBe(null);
  });
});
