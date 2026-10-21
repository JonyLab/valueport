import { describe, it, expect } from "vitest";
import { methodReadiness, cleanReadiness, cleanMethodDecision, readinessText } from "../public/shared/valuation/method-readiness.js";

describe("method readiness, independent of suitability", () => {
  it("does not treat model defaults as actual financial data or confirmed assumptions", () => {
    const r = methodReadiness("fcff", { sharesOutstanding: 100 });
    expect(r.missingInputs.map((x) => x.key)).toEqual(["revenue", "netDebt"]);
    expect(r.assumptions.map((x) => x.key)).toContain("wacc");
    expect(r.status).toBe("needs_data");
  });
  it("accepts reported zero net debt, checks shares, recognizes fiscal-year revenue and still requires assumptions", () => {
    const facts = { "latestAnnualRevenue (FY2025)": 1000, netDebt: 0, sharesOutstanding: 100 };
    expect(methodReadiness("fcff", facts).status).toBe("needs_confirmation");
    expect(methodReadiness("fcff", { ...facts, sharesOutstanding: 0 }).missingInputs.map((x) => x.key)).toContain("shares");
    expect(methodReadiness("pe", { epsTtm: 5 }).missingInputs.map((x) => x.key)).toContain("netIncome"); // default PE uses company net income
    expect(methodReadiness("pb", { bookValuePerShare: 5 }).missingInputs).toEqual([]);
  });
  it("requires real asset packages for resource NAV and tolerates absent facts", () => {
    expect(methodReadiness("navsotp", null).missingInputs.map((x) => x.key)).toContain("assets");
    expect(methodReadiness("unknown")).toBeNull();
    expect(readinessText(methodReadiness("fcff", {}))).toContain("当前资料待补");
  });
  it("bounds persisted metadata and never promotes missing inputs to ready", () => {
    const value = cleanReadiness({ status: "needs_confirmation", missingInputs: [{ key: "revenue", label: "Revenue", injected: true }, { key: 2 }], assumptions: [], executable: "x" });
    expect(value).toEqual({ status: "needs_data", missingInputs: [{ key: "revenue", label: "Revenue" }], assumptions: [] });
    expect(cleanMethodDecision({ engine: "jev", status: "used", secret: "x", classification: { needsReview: true } })).toEqual({ engine: "jev", status: "used", classification: { needsReview: true } });
  });
});

it("preserves Jev readiness and uncertainty when restoring the guide", async () => {
  const { cleanFlowState } = await import("../public/shared/valuation/thesis-guide-ui.js");
  const state = { stage: "method", turns: [], history: [], picks: { summary: "Needs data", decision: { engine: "jev", status: "used", classification: { needsReview: true } }, picks: [{ key: "fcff", reason: "Business fit", suitability: "needs_review", readiness: methodReadiness("fcff", {}) }] } };
  const restored = cleanFlowState(state);
  expect(restored.picks.picks[0].readiness.missingInputs.map((x) => x.key)).toContain("revenue");
  expect(restored.picks.decision.classification.needsReview).toBe(true);
  expect(cleanFlowState(restored)).toEqual(restored);
});
