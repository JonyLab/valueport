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

  it("keeps a sanitised AI review on a card and drops a malformed one", () => {
    const review = { overall: "watch", summary: "增速放缓", at: "2026-10-17T00:00:00Z", checks: [{ k: "growth", status: "watch", reason: "最新同比 +3%", metric: "revenue" }, { k: "targetPE", status: "ok", reason: "", metric: "toString" }, { k: "x", status: "nope" }], extra: 1 };
    const r = validateItem({ ...base, valuations: [{ ...card, review }], selectedValuationId: "v1" });
    expect(r.value.valuations[0].review).toEqual({ overall: "watch", summary: "增速放缓", at: "2026-10-17T00:00:00Z", checks: [{ k: "growth", status: "watch", reason: "最新同比 +3%", metric: "revenue" }, { k: "targetPE", status: "ok", reason: "" }] });
    const bad = validateItem({ ...base, valuations: [{ ...card, review: { overall: "great" } }], selectedValuationId: "v1" });
    expect(bad.value.valuations[0].review).toBeUndefined();
  });
  it("preserves the review version, mode, input date and evidence snapshot", async () => {
    const { buildReviewEvidence, reviewNeedsUpdate } = await import("../public/shared/valuation/review.js");
    const evidence = buildReviewEvidence({ fields: [{ k: "growth", meta: "revGrowth", col: "dual", unit: "%", value: { c: 8, o: 15 } }], scenarioMode: "single" });
    const review = { version: 2, scenarioMode: "single", valuedAt: card.updatedAt, at: "2026-10-21T00:00:00Z", overall: "watch", summary: "待验证", evidence, checks: [{ k: "growth", status: "watch", reason: "暂无可比数据", condition: "补充收入兑现依据" }] };
    const point = { ...card, scenarioMode: "single", high: card.low, review };
    const saved = validateItem({ ...base, fairLow: card.low, fairHigh: card.low, valuations: [point], selectedValuationId: card.id });
    expect(saved.ok).toBe(true);expect(saved.value.valuations[0].review).toEqual(review);
    const restored = rowToItem({ valuations: JSON.stringify(saved.value.valuations) }).valuations[0];
    expect(reviewNeedsUpdate(restored)).toBe(false);
    expect(restored.review.checks[0].condition).toBe("补充收入兑现依据");
  });
  it("persists thesis fields alongside legacy notes and ignores malformed fields", () => {
    const result = validateItem({ ...base, valuations: [{ ...card, note: "原备注", thesis: { story: "  海外增长  ", drivers: "x".repeat(900), signals: 123, extra: "ignore" } }] });
    expect(result.ok).toBe(true);
    const saved = result.value.valuations[0];
    expect(saved.note).toBe("原备注");
    expect(saved.thesis).toEqual({ legacy: { story: "海外增长", drivers: "x".repeat(800) } });
    expect(validateItem({ ...base, valuations: [card] }).value.valuations[0].thesis).toEqual({});
    const row = rowToItem({ valuations: JSON.stringify([saved]) });
    expect(row.valuations[0].thesis).toEqual(saved.thesis);
  });
  it("round trips conservative and optimistic stories independently", () => {
    const thesis = { c: { story: "竞争加剧", assessment: "历史低谷为参照", drivers: "利润率承压", signals: "跟踪市场份额" }, o: { story: "新品带来增长", assessment: "需求待验证", drivers: "利润率提升", signals: "跟踪新品收入" } };
    const result = validateItem({ ...base, valuations: [{ ...card, thesis }] });
    expect(result.ok).toBe(true);
    expect(rowToItem({ valuations: JSON.stringify(result.value.valuations) }).valuations[0].thesis).toEqual(thesis);
  });
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
  it("keeps a derivations object on the card", () => {
    const card = { id: "v1", method: "fcff", inputs: { wacc: { c: 9, o: 8 } },
      derivations: { wacc: { method: "capm", parts: { rf: { c: 3, o: 3 }, beta: { c: 1, o: 1 }, erp: { c: 5, o: 5 } } } },
      low: 100, high: 200 };
    const r = validateItem({ ...base, valuations: [card], selectedValuationId: "v1" });
    expect(r.ok).toBe(true);
    expect(r.value.valuations[0].derivations.wacc.method).toBe("capm");
  });
  it("coerces a non-object derivations to {}", () => {
    const card = { id: "v1", method: "fcff", inputs: {}, derivations: "nope", low: 100, high: 200 };
    const r = validateItem({ ...base, valuations: [card] });
    expect(r.ok).toBe(true);
    expect(r.value.valuations[0].derivations).toEqual({});
  });
  it("keeps a segments object on the card", () => {
    const c2 = { id: "v1", method: "pe", inputs: {},
      segments: { enabled: true, rows: [{ name: "A", revenue: 120e8, growth: { c: 5, o: 9 }, netMargin: { c: 18, o: 20 } }] },
      low: 100, high: 200 };
    const r = validateItem({ ...base, valuations: [c2] });
    expect(r.ok).toBe(true);
    expect(r.value.valuations[0].segments.enabled).toBe(true);
    expect(r.value.valuations[0].segments.rows).toHaveLength(1);
  });
  it("coerces a non-object segments to {}", () => {
    const c2 = { id: "v1", method: "pe", inputs: {}, segments: "nope", low: 100, high: 200 };
    expect(validateItem({ ...base, valuations: [c2] }).value.valuations[0].segments).toEqual({});
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

describe("valuation review marks", () => {
  it("keeps a manual reviewedAt on valuation cards and drops junk", () => {
    const base = { ticker: "AAPL", name: "Apple", symbol: "usAAPL", fairLow: 100, fairHigh: 150, mos: 30, ext: 40 };
    const card = { id: "v1", method: "pe", inputs: {}, low: 100, high: 150, updatedAt: "2026-06-01T00:00:00Z" };
    const ok = validateItem({ ...base, valuations: [{ ...card, reviewedAt: "2026-10-19T14:39:17.746Z" }], selectedValuationId: "v1" });
    expect(ok.ok).toBe(true);
    expect(ok.value.valuations[0].reviewedAt).toBe("2026-10-19T14:39:17.746Z");
    const none = validateItem({ ...base, valuations: [{ ...card, reviewedAt: 123 }], selectedValuationId: "v1" });
    expect("reviewedAt" in none.value.valuations[0]).toBe(false);
  });
});

describe("explicit single-case valuations", () => {
  const single = { id: "single", method: "pe", scenarioMode: "single", inputs: { eps: 10, targetPE: { c: 12, o: 12 } }, low: 120, high: 120 };
  const body = { ticker: "TEST", name: "Fixture", symbol: "usTEST", fairLow: 120, fairHigh: 120, valuations: [single], selectedValuationId: "single", mos: 20, ext: 25 };
  it("accepts a selected single point and preserves the mode", () => {
    const result = validateItem(body); expect(result.ok).toBe(true);
    expect(result.value.valuations[0].scenarioMode).toBe("single");
  });
  it("requires an explicit valid single card matching the selected fair value", () => {
    expect(validateItem({ ...body, valuations: [{ ...single, scenarioMode: "range" }] }).ok).toBe(false);
    expect(validateItem({ ...body, selectedValuationId: null }).ok).toBe(false);
    expect(validateItem({ ...body, fairLow: 100, fairHigh: 100 }).ok).toBe(false);
    expect(validateItem({ ...body, valuations: [{ ...single, high: 121 }] }).ok).toBe(false);
    expect(validateItem({ ...body, valuations: [{ ...single, low: Infinity, high: Infinity }] }).ok).toBe(false);
  });
});
