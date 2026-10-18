import { describe, it, expect } from "vitest";
import { FIELD_META, fieldReference, multipleCompare } from "../public/shared/field-meta.js";

const data = {
  financials: {
    IS: [
      { field: "OperatingRevenue", values: [{ value: 416 }, { value: 391 }, { value: 383 }, { value: 394 }, { value: 366 }, { value: 275 }] },
      { field: "NetProfit", values: [{ value: 112 }, { value: 94 }, { value: 97 }, { value: 100 }, { value: 95 }] },
      { field: "OperatingIncome", values: [{ value: 133 }, { value: 123 }] },
      { field: "NetProfitMargin", values: [{ value: 26.9 }, { value: 24 }, { value: 25.3 }, { value: 25.3 }, { value: 25.9 }] },
    ],
    CF: [{ field: "NetFreeCashFlow", values: [{ value: 90 }, { value: 80 }] }],
  },
  valuationRefs: { pe: { current: 35.9, own5y: 31.2, industryMedian: 26.4 }, pb: {}, ps: {} },
};

describe("FIELD_META", () => {
  it("has bilingual guides for key tags", () => {
    for (const tag of ["revGrowth", "opMargin", "wacc", "termGrowth", "targetPE", "reinvest"]) {
      expect(FIELD_META[tag]).toBeTruthy();
      expect(FIELD_META[tag].guide.zh.length).toBeGreaterThan(4);
      expect(FIELD_META[tag].guide.en.length).toBeGreaterThan(4);
    }
  });
});

describe("fieldReference", () => {
  it("revGrowth → latest YoY + 5y avg", () => {
    const r = fieldReference("revGrowth", data, {}, "zh");
    expect(r.unit).toBe("%");
    expect(r.chips[0].value).toBeCloseTo((416 - 391) / 391 * 100, 1);
    expect(r.chips.length).toBe(2);
  });
  it("netMargin → latest + 5y avg", () => {
    const r = fieldReference("netMargin", data, {}, "zh");
    expect(r.chips[0].value).toBeCloseTo(26.9, 1);
  });
  it("opMargin → OI/OR aligned", () => {
    const r = fieldReference("opMargin", data, {}, "zh");
    expect(r.chips[0].value).toBeCloseTo(133 / 416 * 100, 1);
  });
  it("pe → current/own5y/industryMedian chips", () => {
    const r = fieldReference("pe", data, {}, "zh");
    expect(r.unit).toBe("x");
    expect(r.chips.map((c) => c.value)).toEqual([35.9, 31.2, 26.4]);
  });
  it("returns null when data missing", () => {
    expect(fieldReference("revGrowth", { financials: null }, {}, "zh")).toBe(null);
    expect(fieldReference("pb", data, {}, "zh")).toBe(null); // pb has no usable values
  });
});

describe("multipleCompare", () => {
  it("compares current, own 5y average and industry median as bar lengths", () => {
    const r = multipleCompare({ valuationRefs: { pe: { current: 20, own5y: 25, industryMedian: 10 } } }, "pe", "zh");
    expect(r.unit).toBe("x");
    expect(r.items.map((x) => [x.key, x.label, x.pct])).toEqual([["current", "当前", 0.8], ["own5y", "自身5年均", 1], ["industryMedian", "行业中位", 0.4]]);
  });
  it("hides when current is missing or there is nothing to compare", () => {
    expect(multipleCompare({ valuationRefs: { pe: { own5y: 25, industryMedian: 10 } } }, "pe", "zh")).toBeNull();
    expect(multipleCompare({ valuationRefs: { pb: { current: 2, own5y: null, industryMedian: -1 } } }, "pb", "zh")).toBeNull();
    expect(multipleCompare({}, "ps", "en")).toBeNull();
  });
});
