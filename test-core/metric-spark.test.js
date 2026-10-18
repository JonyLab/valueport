import { describe, it, expect } from "vitest";
import { METRICS, METRIC_KEYS, metricKey, metricSeries, sparkGeom } from "../public/shared/metric-spark.js";

// 长桥年报形状：values 最新在前
const acct = (field, pairs) => ({ field, values: pairs.map(([year, value]) => ({ year, value })).reverse() });
const FIN = {
  IS: [acct("OperatingRevenue", [[2021, 100], [2022, 110], [2023, 121]]), acct("ROE", [[2022, 18], [2023, NaN], [2024, 21]])],
  BS: [acct("NetDebt", [[2023, 5], [2024, -3]])],
  CF: [],
};
const DIV = { years: [{ year: 2023, perShare: 1.2 }, { year: 2024, perShare: 1.3 }] };

describe("metric whitelist", () => {
  it("accepts only own whitelist keys", () => {
    expect(METRIC_KEYS).toEqual(expect.arrayContaining(["revenue", "netIncome", "fcf", "roe", "netMargin", "netDebt", "dividends"]));
    expect(metricKey("roe")).toBe("roe");
    for (const bad of ["pe", "constructor", "toString", "__proto__", "", null, 3, ["roe"], { k: "roe" }]) expect(metricKey(bad)).toBeNull();
    for (const k of METRIC_KEYS) expect(METRICS[k].zh && METRICS[k].en).toBeTruthy();
  });
});

describe("metricSeries", () => {
  it("reads the statement series in ascending years, skipping gaps", () => {
    expect(metricSeries("revenue", FIN)).toEqual([{ year: 2021, value: 100 }, { year: 2022, value: 110 }, { year: 2023, value: 121 }]);
    expect(metricSeries("roe", FIN)).toEqual([{ year: 2022, value: 18 }, { year: 2024, value: 21 }]);
    expect(metricSeries("revenue", FIN, null, 2).map((x) => x.year)).toEqual([2022, 2023]);
  });
  it("reads dividends per share from the dividend history", () => {
    expect(metricSeries("dividends", FIN, DIV)).toEqual([{ year: 2023, value: 1.2 }, { year: 2024, value: 1.3 }]);
  });
  it("returns nothing for unknown metrics or missing data", () => {
    expect(metricSeries("pe", FIN)).toEqual([]);
    expect(metricSeries("fcf", FIN)).toEqual([]);
    expect(metricSeries("revenue", null)).toEqual([]);
    expect(metricSeries("dividends", FIN, null)).toEqual([]);
  });
});

describe("sparkGeom", () => {
  it("scales to its own range within the box", () => {
    const g = sparkGeom([{ year: 2021, value: 100 }, { year: 2022, value: 110 }, { year: 2023, value: 120 }], 64, 20, 2);
    expect(g.line).toBe("0,18 32,10 64,2");
    expect(g.area).toBe("0,20 0,18 32,10 64,2 64,20");
    expect(g.last).toEqual([64, 2]);
    expect(g.zero).toBeNull();
    expect(g.latest).toEqual({ year: 2023, value: 120 });
  });
  it("marks the zero line when the series crosses zero, and centers a flat series", () => {
    expect(sparkGeom([{ year: 1, value: 5 }, { year: 2, value: -5 }], 64, 20, 2).zero).toBe(10);
    expect(sparkGeom([{ year: 1, value: 7 }, { year: 2, value: 7 }], 64, 20, 2).line).toBe("0,10 64,10");
  });
  it("needs at least two points", () => {
    expect(sparkGeom([{ year: 1, value: 1 }])).toBeNull();
    expect(sparkGeom([])).toBeNull();
    expect(sparkGeom(null)).toBeNull();
  });
});
