import { describe, it, expect } from "vitest";
import { validateItem, rowToItem } from "../src/items.js";

describe("validateItem", () => {
  const good = { ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 };
  it("accepts a valid payload", () => {
    expect(validateItem(good).ok).toBe(true);
  });
  it("rejects missing symbol", () => {
    expect(validateItem({ ...good, symbol: "" }).ok).toBe(false);
  });
  it("rejects fairHigh <= fairLow", () => {
    expect(validateItem({ ...good, fairHigh: 100 }).ok).toBe(false);
  });
  it("rejects mos >= 100", () => {
    expect(validateItem({ ...good, mos: 100 }).ok).toBe(false);
  });
  it("rejects missing ticker", () => {
    expect(validateItem({ ...good, ticker: "" }).ok).toBe(false);
  });
  it("rejects mos = 0 (open interval)", () => {
    expect(validateItem({ ...good, mos: 0 }).ok).toBe(false);
  });
  it("accepts empty fair range (unvalued), stores 0/0", () => {
    const r = validateItem({ ...good, fairLow: "", fairHigh: "" });
    expect(r.ok).toBe(true);
    expect(r.value.fairLow).toBe(0);
    expect(r.value.fairHigh).toBe(0);
  });
  it("treats fairLow/fairHigh = 0 as unvalued", () => {
    expect(validateItem({ ...good, fairLow: 0, fairHigh: 0 }).ok).toBe(true);
  });
  it("rejects a half-filled fair range (low only)", () => {
    expect(validateItem({ ...good, fairLow: 215, fairHigh: "" }).ok).toBe(false);
  });
  it("drops selectedValuationId when unvalued", () => {
    const card = { id: "v1", method: "pe", inputs: {}, low: 200, high: 260 };
    const r = validateItem({ ...good, fairLow: "", fairHigh: "", valuations: [card], selectedValuationId: "v1" });
    expect(r.ok).toBe(true);
    expect(r.value.selectedValuationId).toBe(null);
  });
});

describe("rowToItem", () => {
  it("maps a DB row to a camelCase API object", () => {
    const row = { id: 1, ticker: "AAPL", name: "苹果", symbol: "usAAPL",
      fair_low: 215, fair_high: 265, mos: 20, ext: 25, sort_order: 3, updated_at: "2026-06-11T00:00:00Z" };
    expect(rowToItem(row)).toEqual({
      id: 1, ticker: "AAPL", name: "苹果", symbol: "usAAPL",
      fairLow: 215, fairHigh: 265, mos: 20, ext: 25, sortOrder: 3,
      valuations: [], selectedValuationId: null,
    });
  });
});

describe("validateItem with valuations", () => {
  const base = { ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 };
  const card = { id: "v1", method: "pe", inputs: { revenue: 4e11, growth: { c: 8, o: 15 } }, low: 211.29, high: 460.13, updatedAt: "2026-06-16T00:00:00Z" };

  it("accepts valid valuations + selectedValuationId", () => {
    const r = validateItem({ ...base, valuations: [card], selectedValuationId: "v1" });
    expect(r.ok).toBe(true);
    expect(r.value.valuations).toHaveLength(1);
    expect(r.value.selectedValuationId).toBe("v1");
  });
  it("defaults valuations to [] when omitted", () => {
    const r = validateItem(base);
    expect(r.ok).toBe(true);
    expect(r.value.valuations).toEqual([]);
    expect(r.value.selectedValuationId).toBe(null);
  });
  it("rejects an unknown method", () => {
    expect(validateItem({ ...base, valuations: [{ ...card, method: "wat" }] }).ok).toBe(false);
  });
  it("rejects a card with high <= low", () => {
    expect(validateItem({ ...base, valuations: [{ ...card, high: 100 }] }).ok).toBe(false);
  });
  it("rejects selectedValuationId that matches no card", () => {
    expect(validateItem({ ...base, valuations: [card], selectedValuationId: "nope" }).ok).toBe(false);
  });
  it("rejects valuations that is not an array", () => {
    expect(validateItem({ ...base, valuations: { id: "v1" } }).ok).toBe(false);
  });
  it("keeps a card note (string) and defaults to '' when absent, capped at 2000 chars", () => {
    const withNote = validateItem({ ...base, valuations: [{ ...card, note: "看好 AI 周期" }] });
    expect(withNote.value.valuations[0].note).toBe("看好 AI 周期");
    expect(validateItem({ ...base, valuations: [card] }).value.valuations[0].note).toBe("");
    const long = validateItem({ ...base, valuations: [{ ...card, note: "x".repeat(3000) }] });
    expect(long.value.valuations[0].note).toHaveLength(2000);
  });
});

describe("rowToItem with valuations", () => {
  const row = { id: 1, ticker: "AAPL", name: "苹果", symbol: "usAAPL", fair_low: 215, fair_high: 265, mos: 20, ext: 25, sort_order: 0, updated_at: "x" };
  it("parses valuations JSON and selected id", () => {
    const out = rowToItem({ ...row, valuations: '[{"id":"v1","method":"pe","inputs":{},"low":1,"high":2,"updatedAt":"x"}]', selected_valuation_id: "v1" });
    expect(out.valuations).toHaveLength(1);
    expect(out.valuations[0].id).toBe("v1");
    expect(out.selectedValuationId).toBe("v1");
  });
  it("falls back to [] on missing/bad JSON", () => {
    expect(rowToItem(row).valuations).toEqual([]);
    expect(rowToItem({ ...row, valuations: "not json" }).valuations).toEqual([]);
    expect(rowToItem(row).selectedValuationId).toBe(null);
  });
});
