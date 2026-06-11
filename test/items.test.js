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
});

describe("rowToItem", () => {
  it("maps a DB row to a camelCase API object", () => {
    const row = { id: 1, ticker: "AAPL", name: "苹果", symbol: "usAAPL",
      fair_low: 215, fair_high: 265, mos: 20, ext: 25, sort_order: 3, updated_at: "2026-06-11T00:00:00Z" };
    expect(rowToItem(row)).toEqual({
      id: 1, ticker: "AAPL", name: "苹果", symbol: "usAAPL",
      fairLow: 215, fairHigh: 265, mos: 20, ext: 25, sortOrder: 3,
    });
  });
});
