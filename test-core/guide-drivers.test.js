import { describe, it, expect } from "vitest";
import { cleanDriverPlan, rankGuideDrivers, FALLBACK_DRIVERS } from "../public/shared/valuation/guide-drivers.js";
import { cleanFlowState } from "../public/shared/valuation/thesis-guide-ui.js";
const plan = { version: 1, status: "used", keys: ["gold_price", "copper_price", "capacity", "reinvestment"] };
const core = (p = 0.9, confidence = 0.8) => ({ choice: "core", confidence, probabilities: { core: p } });
const question = { type: "question", question: "金价未来如何？", context: "价格预期仍待验证", selection: "single", options: [{ id: "a", label: "偏弱" }, { id: "b", label: "偏强" }] };
describe("driver question plans", () => {
  it("bounds and validates closed keys without trusting model or stored metadata", () => {
    expect(cleanDriverPlan(plan)).toEqual(plan);
    for (const keys of [["made_up", "capacity", "margin"], ["demand", "demand", "margin"], ["demand"], [...plan.keys, "margin"]]) expect(cleanDriverPlan({ ...plan, keys })).toBeNull();
    expect(cleanDriverPlan({ ...plan, version: 2 })).toBeNull();
  });
  it("selects a deterministic top four and excludes low confidence and irrelevant answers", () => {
    const ranked = rankGuideDrivers({ gold_price: core(0.96), copper_price: core(0.94), capacity: core(0.93), reinvestment: core(0.92), financing: core(0.9), pricing: core(0.99, 0.1), pipeline: { ...core(), choice: "negligible" } });
    expect(ranked).toEqual(plan);
  });
  it("does not call a generic fallback an evidence-based decision or repeat specific profitability", () => {
    expect(rankGuideDrivers({})).toEqual({ version: 1, status: "uncertain", keys: FALLBACK_DRIVERS });
    const ranked = rankGuideDrivers({ unit_cost: core(0.96), margin: core(0.95), demand: core(0.94), reinvestment: core(0.93) });
    expect(ranked.keys).toEqual(["unit_cost", "demand", "reinvestment"]);
    expect(rankGuideDrivers({ unit_cost: core() }).keys).toEqual(["unit_cost", "demand", "reinvestment"]);
    expect(rankGuideDrivers({ gold_price: core(0.99), copper_price: core(0.98), commodity_price: core(0.97), capacity: core(0.96) }).keys).toEqual(["gold_price", "copper_price", "capacity"]);
  });
  it("restores a driver draft and its own history without converting legacy drafts", () => {
    const raw = { guideMode: "drivers", driverPlan: plan, stage: "story", turns: [{ question: question.question, answer: "偏强" }], history: [{ question, selected: ["b"] }], question, selected: ["a"] };
    const clean = cleanFlowState(raw);
    expect(clean.driverPlan).toEqual(plan); expect(clean.turns).toEqual(raw.turns); expect(clean.selected).toEqual(["a"]);
    expect(cleanFlowState(clean)).toEqual(clean);
    expect(cleanFlowState({ ...raw, driverPlan: null })).toBeNull();
    expect(cleanFlowState({ ...raw, turns: Array(5).fill(raw.turns[0]) })).toBeNull();
    const { guideMode, driverPlan, ...legacy } = raw;
    expect(cleanFlowState(legacy).guideMode).toBeUndefined();
  });
});
