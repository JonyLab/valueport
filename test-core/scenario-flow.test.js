import { describe, it, expect } from "vitest";
import { scenarioContext, mergeScenarioParams } from "../public/shared/valuation/thesis-guide.js";
import { cleanFlowState } from "../public/shared/valuation/thesis-guide-ui.js";
const plan = { version: 1, status: "uncertain", keys: ["demand", "margin", "reinvestment"] };
const q = { type: "question", context: "资料不足", question: "业务将怎样？", selection: "single", options: [{ id: "a", label: "稳定" }, { id: "b", label: "温和增长" }] };
const draft = { story: "用户本情景判断", evidence: "暂无依据", uncertainties: "订单待核实", signals: "建议跟踪订单", impacts: [] };
const page = (key, stage = "story") => ({ guideMode: "drivers", caseKey: key, driverPlan: plan, stage,
  turns: stage === "story" ? [] : plan.keys.map(() => ({ question: q.question, answer: key })),
  history: stage === "story" ? [] : plan.keys.map(() => ({ question: q, selected: ["a"] })),
  ...(stage === "story" ? {} : { drafts: { [key]: draft } }) });
const flow = () => ({ version: 2, guideMode: "sequential", activeCase: "o", cases: { c: page("c", "result"), o: page("o") }, completed: { c: true, o: false }, basis: { c: "method|base", o: "" } });
describe("independent scenario flow", () => {
  it("restores each case's questions, confirmed progress and shared basis without crossing histories", () => {
    const raw = flow(); raw.cases.o.question = q; raw.cases.o.selected = ["b"];
    const clean = cleanFlowState(raw); expect(clean.activeCase).toBe("o");
    expect(clean.cases.c.turns.every(t => t.answer === "c")).toBe(true);
    expect(clean.cases.o.turns).toEqual([]); expect(clean.cases.o.selected).toEqual(["b"]);
    expect(cleanFlowState(clean)).toEqual(clean);
    expect(cleanFlowState({ ...raw, activeCase: "compare" })).toBeNull();
    expect(cleanFlowState({ ...raw, completed: { c: false } })).toBeNull();
    expect(cleanFlowState({ ...raw, cases: { ...raw.cases, o: { ...page("o"), caseKey: "c" } } })).toBeNull();
    expect(cleanFlowState({ ...raw, cases: { ...raw.cases, c: { ...page("c"), stage: "result" } } })).toBeNull();
  });
  it("scopes valuation requests to one case and removes target ranges while preserving shared facts", () => {
    const raw = { fields: [{ k: "growth", col: "dual", value: { c: 4, o: 18 } }, { k: "years", col: "single", value: 5 }],
      facts: { revenue: 100, currentConclusion: "99–999", resourceValuation: { c: 1, o: 2 } }, thesis: { c: draft, o: { ...draft, story: "不能泄漏另一边" } } };
    const c = scenarioContext(raw, "c"), o = scenarioContext(raw, "o");
    expect(c.fields[0].value).toEqual({ c: 4 }); expect(c.thesis.o).toBeUndefined();
    expect(o.fields[0].value).toEqual({ o: 18 }); expect(o.fields[1]).toMatchObject({ value: 5, readOnly: true });
    expect(c.facts).toEqual({ revenue: 100 }); expect(scenarioContext(c, "c")).toEqual(c);
    expect(raw.fields[0].value).toEqual({ c: 4, o: 18 });
  });
  it("only applies this case's confirmed values and refuses optimistic changes to shared inputs", () => {
    const fields = [{ k: "growth", col: "dual", value: { c: 4, o: 18 } }, { k: "years", col: "single", value: 5 }];
    expect(mergeScenarioParams({ growth: { c: 999, o: 20 }, years: 50, unknown: 1 }, fields, "o")).toEqual({ growth: { c: 4, o: 20 } });
    expect(mergeScenarioParams({ growth: { c: 3 }, years: 6 }, fields, "c")).toEqual({ growth: { c: 3, o: 18 }, years: 6 });
    expect(mergeScenarioParams({ growth: { o: NaN } }, fields, "o")).toEqual({});
  });
});

import { runScenario } from "../public/shared/valuation/index.js";
import { valuationChange } from "../public/shared/valuation/save.js";
import { hasFairRange, verdictOf, priceToPhi, computeAnchors } from "../public/shared/core.js";
it("restores an explicitly chosen single interview and permits only its own completion", () => {
  const state = { ...flow(), guideMode: "single", modeChosen: true, activeCase: "compare", cases: { c: { ...page("c", "result"), singleCase: true }, o: null }, completed: { c: true, o: false } };
  const clean = cleanFlowState(state); expect(clean.activeCase).toBe("compare"); expect(cleanFlowState(clean)).toEqual(clean);
  expect(cleanFlowState({ ...state, activeCase: "o" })).toBeNull();
  expect(cleanFlowState({ ...state, cases: { c: page("c", "result"), o: null } })).toBeNull();
  expect(cleanFlowState({ version: 2, guideMode: "choose" }).guideMode).toBe("choose");
});
it("calculates a case without needing its counterpart and preserves scenario identity when values invert", () => {
  const model = { fields: [{ k: "base", col: "single" }, { k: "mult", col: "dual" }], compute: v => v.base * v.mult };
  expect(runScenario(model, { base: 10, mult: { c: 12 } }, {}, "c")).toBe(120);
  expect(runScenario(model, { base: 10, mult: { c: 12 } }, {}, "o")).toBeNull();
  expect(runScenario(model, { base: 10, mult: { c: 20, o: 12 } }, {}, "c")).toBe(200);
});
it("saves an explicit single point and recognizes it in verdicts without relaxing unmarked ranges", () => {
  const value = { scenarioMode: "single", method: "pe", inputs: {}, low: 120, high: 120 };
  const cfg = { symbol: "usTEST", fairLow: 0, fairHigh: 0, valuations: [], selectedValuationId: null };
  const saved = { ...cfg, ...valuationChange(cfg, null, value, "single-card") };
  expect(saved.valuations[0].scenarioMode).toBe("single"); expect(hasFairRange(saved)).toBe(true);
  expect(verdictOf({ ...saved, price: 100 }).cls).toBe("v-under");
  expect(verdictOf({ ...saved, price: 140 }).cls).toBe("v-over");
  expect(verdictOf({ ...saved, price: 120 }).cls).toBe("v-fair");
  expect(priceToPhi(computeAnchors({ ...saved, mos: 20, ext: 25 }), 120)).toBe(90);
  expect(() => valuationChange(cfg, null, { ...value, scenarioMode: "range" })).toThrow();
  expect(hasFairRange({ fairLow: 120, fairHigh: 120 })).toBe(false);
});
