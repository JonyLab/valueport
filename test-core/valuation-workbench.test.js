import { describe, expect, it } from "vitest";
import { midpointForm, scheduleSeries, sensitivityMatrix, fieldSweep } from "../public/shared/valuation/workbench.js";
import { runModel } from "../public/shared/valuation/index.js";

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

describe("fieldSweep", () => {
  // 合理价 = base × (1 + growth%) × multiple
  const m = { key: "demo", fields: model.fields, compute: (v) => v.base * (1 + v.growth / 100) * v.multiple };
  const form = { base: 10, growth: { c: 5, o: 15 }, multiple: { c: 8, o: 12 } };

  it("shifts both scenarios of a dual field and holds other inputs", () => {
    const r = fieldSweep({ model: m, form, ctx: {}, run: runModel, field: model.fields[1], steps: [-5, 0, 5] });
    expect(r.rows.map((x) => x.value)).toEqual([{ c: 0, o: 10 }, { c: 5, o: 15 }, { c: 10, o: 20 }]);
    expect(r.rows[1]).toMatchObject({ current: true, low: 84, high: 138 });
    expect(r.rows[0].low).toBeCloseTo(80);
    expect(form.growth).toEqual({ c: 5, o: 15 }); // 不改原表单
  });
  it("treats money steps as percent changes", () => {
    const r = fieldSweep({ model: m, form, ctx: {}, run: runModel, field: model.fields[0], steps: [-10, 0, 10], money: true });
    expect(r.rows.map((x) => x.value)).toEqual([9, 10, 11]);
  });
  it("returns null when the field has no current value", () => {
    expect(fieldSweep({ model: m, form: { ...form, base: NaN }, ctx: {}, run: runModel, field: model.fields[0], steps: [0] })).toBeNull();
  });
});
