import { describe, expect, it } from "vitest";
import { midpointForm, scheduleSeries, sensitivityMatrix } from "../public/shared/valuation/workbench.js";

const model = {
  key: "demo",
  fields: [
    { k: "base", col: "single" },
    { k: "growth", col: "dual", unit: "%" },
    { k: "multiple", col: "dual" },
  ],
};

describe("valuation workbench helpers", () => {
  it("builds midpoint form from dual scenario fields", () => {
    const form = {
      base: 10,
      growth: { c: 5, o: 15 },
      multiple: { c: 8, o: 12 },
    };

    expect(midpointForm(model, null, form)).toEqual({
      base: 10,
      growth: 10,
      multiple: 10,
    });
  });

  it("normalizes schedule rows into finite chart points", () => {
    const series = scheduleSeries({
      rows: [
        { year: 1, cf: 100, pv: 90 },
        { year: 2, cf: 125, pv: 100 },
        { year: 3, cf: NaN, pv: 95 },
      ],
    });

    expect(series).toEqual([
      { label: "1", value: 100, pv: 90 },
      { label: "2", value: 125, pv: 100 },
    ]);
  });

  it("creates a centered 5x5 sensitivity matrix for two numeric assumptions", () => {
    const matrix = sensitivityMatrix({
      model,
      mode: null,
      form: {
        base: 10,
        growth: { c: 5, o: 15 },
        multiple: { c: 8, o: 12 },
      },
      ctx: {},
      run: (m, f) => {
        const growth = typeof f.growth === "object" ? f.growth.c : f.growth;
        const multiple = typeof f.multiple === "object" ? f.multiple.c : f.multiple;
        const value = f.base * growth * multiple;
        return { low: value, high: value };
      },
      lang: "en",
    });

    expect(matrix).not.toBeNull();
    expect(matrix.x.key).toBe("growth");
    expect(matrix.y.key).toBe("multiple");
    expect(matrix.rows).toHaveLength(5);
    expect(matrix.rows[2].cells[2].center).toBe(true);
    expect(matrix.rows[2].cells[2].value).toBe(1000);
  });

  it("returns null sensitivity when fewer than two numeric assumptions are available", () => {
    const singleFieldModel = {
      fields: [
        { k: "base", col: "single" },
      ],
    };

    expect(sensitivityMatrix({
      model: singleFieldModel,
      mode: null,
      form: { base: 10 },
      ctx: {},
      run: () => ({ low: 10, high: 10 }),
      lang: "en",
    })).toBeNull();
  });
});
