import { describe, it, expect } from "vitest";
import { aggregateSegments } from "../public/shared/valuation/segments.js";

describe("aggregateSegments", () => {
  const rows = [
    { revenue: 120e8, growth: { c: 5, o: 9 }, netMargin: { c: 18, o: 20 } },
    { revenue: 45e8, growth: { c: 18, o: 25 }, netMargin: { c: 10, o: 14 } },
  ];
  const n = 5;
  const segE = (k) => rows.reduce((s, x) => s + x.revenue * Math.pow(1 + x.growth[k] / 100, n) * x.netMargin[k] / 100, 0);

  it("合计当前营收 = 各部之和", () => {
    expect(aggregateSegments(rows, n).revenue).toBe(165e8);
  });
  it("回填的混合增速+净利率重算 E 精确等于 ΣEᵢ", () => {
    const r = aggregateSegments(rows, n);
    const reE = (k) => r.revenue * Math.pow(1 + r.growth[k] / 100, n) * r.netMargin[k] / 100;
    expect(reE("c")).toBeCloseTo(segE("c"), 1);
    expect(reE("o")).toBeCloseTo(segE("o"), 1);
  });
  it("futNi 直接给出合计净利 E(保守/乐观)", () => {
    const r = aggregateSegments(rows, n);
    expect(r.futNi.c).toBeCloseTo(segE("c"), 1);
    expect(r.futNi.o).toBeCloseTo(segE("o"), 1);
  });
  it("n 缺失 / 0 行 / 合计营收<=0 → null", () => {
    expect(aggregateSegments(rows, 0)).toBe(null);
    expect(aggregateSegments([], 5)).toBe(null);
    expect(aggregateSegments([{ revenue: 0, growth: { c: 5, o: 5 }, netMargin: { c: 10, o: 10 } }], 5)).toBe(null);
  });
  it("空增速/净利率按 0 处理", () => {
    const r = aggregateSegments([{ revenue: 100, growth: { c: "", o: "" }, netMargin: { c: "", o: "" } }], 5);
    expect(r.growth.c).toBeCloseTo(0);
    expect(r.netMargin.c).toBeCloseTo(0);
  });
});
