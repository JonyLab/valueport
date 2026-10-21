import { describe, it, expect } from "vitest";
import { cleanGuideRouting, coverageChoices, FOLLOWUP_CHOICES, guideRoutingNote, routingSnapshot } from "../public/shared/valuation/guide-routing.js";
import { guideRoutingRequest, guideRoutingResult } from "../src/jev-guide-routing.js";
import { cleanGuideAudit } from "../public/shared/valuation/guide-audit.js";
import { cleanFlowState } from "../public/shared/valuation/thesis-guide-ui.js";

const question = { type: "question", context: "保守场景仍需权衡产量与负债。", question: "保守情况下如何看待融资压力？", selection: "single", options: [{ id: "a", label: "如果融资成本增加，利润可能承压" }, { id: "b", label: "如果产量抵消成本，利润可能持平" }] };
const turns = [{ question: "未来主要变化是什么？", answer: "保守情况下产量提升有限，我愿意承担已知的融资成本风险。" }];
const choice = (options, selected, p = 0.96) => ({ type: "choice", choice: selected, confidence: (p - 1 / options.length) / (1 - 1 / options.length), probabilities: Object.fromEntries(options.map((key) => [key, key === selected ? p : (1 - p) / (options.length - 1)])) });
const answers = (request) => ({ answer_coverage: choice(request.options, "covered_turn_0"), followup_need: choice(FOLLOWUP_CHOICES, "accepted_risk") });

describe("bounded Jev answer coverage", () => {
  it("binds reuse to the full question, previous answers, case and numbered evidence", () => {
    const request = guideRoutingRequest(question, turns, "both");
    const routing = guideRoutingResult(request, answers(request));
    expect(cleanGuideRouting(routing, question, turns)).toMatchObject({ status: "used", coverage: "covered", matchedTurn: 0, followup: "accepted_risk" });
    for (const q of [{ ...question, context: "另一份资料" }, { ...question, options: [{ ...question.options[0], label: "新条件" }, question.options[1]] }]) expect(cleanGuideRouting(routing, q, turns)).toBeNull();
    expect(cleanGuideRouting(routing, question, [{ ...turns[0], answer: "我还没有决定" }])).toBeNull();
    expect(cleanGuideRouting(routing, question, turns, "c")).toBeNull();
    const audit = { status: "used", references: ["原始资料"], items: [], routing };
    expect(cleanGuideAudit(audit, question, ["不同资料"], turns)).toBeNull();
    expect(cleanGuideAudit(audit, question, audit.references, turns).routing.matchedTurn).toBe(0);
  });
  it("never reuses the opposite case or a bare unknown answer", () => {
    const both = [...turns, { question: "保守情况？", answer: "保守情况下销量下跌" }];
    expect(coverageChoices(both, "both")).not.toContain("covered_turn_1");
    for (const answer of ["还不确定，先留待验证。", "I am not sure yet; keep this unverified."]) expect(coverageChoices([{ question: "q", answer }], "both")).not.toContain("covered_turn_0");
    const request = guideRoutingRequest(question, both, "both");
    const invalid = { ...answers(request), answer_coverage: choice([...request.options, "covered_turn_1"], "covered_turn_1") };
    expect(guideRoutingResult(request, invalid)).toMatchObject({ status: "unavailable", matchedTurn: null });
    expect(guideRoutingRequest({ type: "summary" }, turns, "both")).toBeNull();
    expect(guideRoutingRequest(question, [], "both")).toBeNull();
  });
  it("treats low confidence and malformed decisions as non-reusable without generating prose", () => {
    const request = guideRoutingRequest(question, turns, "both");
    const uncertain = { answer_coverage: choice(request.options, "covered_turn_0", 0.4), followup_need: choice(FOLLOWUP_CHOICES, "accepted_risk", 0.3) };
    expect(guideRoutingResult(request, uncertain)).toMatchObject({ coverage: "uncertain", matchedTurn: null, followup: "uncertain" });
    expect(guideRoutingResult(request, { answer_coverage: "covered_turn_0" })).toMatchObject({ status: "unavailable", matchedTurn: null });
    expect(guideRoutingResult(request, null, "not_configured")).toMatchObject({ status: "not_configured", matchedTurn: null });
    expect(guideRoutingNote({ status: "unavailable", coverage: "covered" })).toBe("");
  });
  it("distinguishes factual gaps from accepted risk and does not turn either into a valuation judgment", () => {
    const request = guideRoutingRequest(question, turns, "both");
    const data = guideRoutingResult(request, { answer_coverage: choice(request.options, "partial"), followup_need: choice(FOLLOWUP_CHOICES, "needs_data") });
    expect(data).toMatchObject({ coverage: "partial", matchedTurn: null, followup: "needs_data" });
    expect(guideRoutingNote(data)).toContain("资料依据"); expect(guideRoutingNote(data)).not.toContain("已明确愿意承担");
    expect(request.questions.followup_need.instructions).toContain("omitting a risk");
    expect(request.questions.followup_need.instructions).toContain("choose needs_data even if the user accepts risk");
    const risk = guideRoutingResult(request, answers(request));
    expect(guideRoutingNote(risk)).toContain("风险仍需跟踪");
    expect(guideRoutingNote(risk, "en")).toContain("explicitly accepted");
  });
  it("restores checks for their own historical transcript and drops them after an earlier answer changes", () => {
    const request = guideRoutingRequest(question, turns, "both");
    const routing = guideRoutingResult(request, answers(request));
    const audit = { status: "used", items: [], references: [], routing };
    const page = { question, selected: [], freeText: turns[0].answer, references: [], audit };
    const current = { stage: "story", turns: [...turns, { question: question.question, answer: turns[0].answer }], history: [{ question }, page], question, references: [] };
    const restored = cleanFlowState(current);
    expect(restored.history[1].audit.routing.matchedTurn).toBe(0);
    expect(cleanFlowState({ ...current, turns: [{ ...turns[0], answer: "情况改变了" }, current.turns[1]] }).history[1].audit.routing).toBeUndefined();
    expect(routingSnapshot(question, [{ question: "q", answer: "x".repeat(801) }], "both")).toBeNull();
  });
});
