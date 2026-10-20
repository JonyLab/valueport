import { describe, it, expect } from "vitest";
import { guideQuestion, guideDraft, guideAnswer, cleanGuideState, validGuideTurns } from "../public/shared/valuation/thesis-guide.js";
import { valuationDraftStore } from "../public/shared/valuation/editor-draft.js";
import { valuationChange, persistValuation } from "../public/shared/valuation/save.js";

const question = { type: "question", context: "公司海外收入增长，但利润表现仍待验证。", question: "你更看好哪个业务变化？", selection: "multiple", options: [{ id: "a", label: "如果海外需求持续，收入增长加快", detail: "待验证假设" }, { id: "b", label: "投入增加，短期利润承压" }] };
const draft = { story: "新品拓展海外客户", evidence: "暂时没有证据", uncertainties: "订单持续性待核实", signals: "建议跟踪复购订单", impacts: [{ key: "growth", direction: "unknown", reason: "尚不能确定新品收入" }] };
describe("bounded generative research UI", () => {
  it("accepts known components and rejects executable or malformed UI payloads", () => {
    expect(guideQuestion(question)).toMatchObject({ question: question.question, options: [{ id: "a" }, { id: "b" }] });
    for (const bad of [{ ...question, type: "html" }, { ...question, options: [] }, { ...question, selection: "script" }, { ...question, options: [question.options[0], question.options[0]] }, { ...question, question: "x".repeat(601) }, { ...question, options: [{ id: "unknown", label: "override" }, question.options[0]] }]) expect(guideQuestion(bad)).toBeNull();
    const clean = guideDraft({ ...draft, params: { growth: 99 }, low: 100, high: 200 });
    expect(clean).toEqual(draft); expect(clean.params).toBeUndefined();
    expect(guideDraft({ ...draft, impacts: [{ key: "code", direction: "up", reason: "execute" }] })).toBeNull();
    expect(guideDraft({ ...draft, impacts: [] })).toEqual({ ...draft, impacts: [] });
    expect(guideDraft(guideDraft({ ...draft, impacts: [] }))).not.toBeNull();
  });
  it("keeps selection and free text together, without asserting certainty on unknown answers", () => {
    expect(guideAnswer(question, ["a", "b"], "我还想看海外复购")).toBe(question.options.map((option) => option.label).join("\n") + "\n我还想看海外复购");
    expect(guideAnswer(question, ["unknown", "a"], "")).toBe("还不确定，先留待验证。");
    expect(guideAnswer(question, [], "我的独立判断")).toBe("我的独立判断");
    expect(validGuideTurns([{ question: "q", answer: "a" }])).toBe(true);
    expect(validGuideTurns(Array(4).fill({ question: "q", answer: "a" }))).toBe(false);
    expect(validGuideTurns([{ question: "q", answer: "" }])).toBe(false);
  });
  it("restores partial answers, history and drafts without trusting storage contents", () => {
    const state = { turns: [{ question: question.question, answer: "a" }], history: [{ question, selected: ["a"], freeText: "" }], question, selected: ["b"], freeText: "待研究", draft: null, base: "{}" };
    const clean = cleanGuideState(state); expect(clean.turns).toEqual(state.turns); expect(clean.history[0].question.question).toBe(question.question);
    expect(clean.selected).toEqual(["b"]); expect(clean.freeText).toBe("待研究");
    expect(cleanGuideState({ ...state, question: { type: "html" } })).toBeNull();
    expect(cleanGuideState(clean)).toEqual(clean);
  });
});

describe("browser research drafts", () => {
  const memory = () => { const data = new Map(); return { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) }; };
  it("scopes unfinished research to a user, stock and card, and rejects stale saved versions", () => {
    const storage = memory(), a = valuationDraftStore("alice:DEMO:new", "v1", storage);
    expect(a.write({ thesis: { c: draft }, guides: { c: { freeText: "half an answer" } } })).toBe(true);
    expect(a.read().state.thesis.c.story).toBe(draft.story);
    expect(valuationDraftStore("bob:DEMO:new", "v1", storage).read()).toBeNull();
    expect(valuationDraftStore("alice:OTHER:new", "v1", storage).read()).toBeNull();
    expect(valuationDraftStore("alice:DEMO:existing", "v1", storage).read()).toBeNull();
    expect(valuationDraftStore("alice:DEMO:new", "v2", storage).read()).toBeNull();
    a.clear(); expect(a.read()).toBeNull();
  });
  it("handles disabled or corrupted storage without losing the in-memory workflow", () => {
    const fail = { getItem() { throw new Error("disabled"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("disabled"); } };
    const store = valuationDraftStore("user:stock:new", "", fail);
    expect(store.read()).toBeNull(); expect(store.write({})).toBe(false); expect(() => store.clear()).not.toThrow();
    expect(valuationDraftStore("x", "", { getItem: () => "{broken" }).read()).toBeNull();
  });
});

describe("valuation save transaction", () => {
  const cfg = { symbol: "usDEMO", ticker: "DEMO", name: "Demo", mos: 30, ext: 50, fairLow: 0, fairHigh: 0, valuations: [], selectedValuationId: null };
  const value = { method: "pb", inputs: { bps: 20, targetPB: { c: 2, o: 3 } }, low: 40, high: 60, thesis: { c: draft } };
  it("persists a complete request and does not mutate the displayed card before acknowledgement", async () => {
    const item = { id: 1, cfg: structuredClone(cfg) };
    const result = await persistValuation(item, null, value, async (url, init) => {
      expect(url).toBe("/api/my/items/1"); expect(init.method).toBe("PUT");
      const payload = JSON.parse(init.body); expect(payload.valuations[0].thesis).toEqual(value.thesis); expect(payload.fairLow).toBe(40);
      expect(item.cfg.valuations).toEqual([]); return Response.json({ ok: true });
    });
    expect(result.change.valuations).toHaveLength(1); expect(result.change.fairHigh).toBe(60); expect(item.cfg).toEqual(cfg);
  });
  it("leaves originals untouched on save failure and keeps unselected ranges independent", async () => {
    const item = { id: 1, cfg: structuredClone(cfg) };
    await expect(persistValuation(item, null, value, async () => Response.json({ error: "no" }, { status: 503 }))).rejects.toThrow("503");
    expect(item.cfg).toEqual(cfg);
    const base = { ...cfg, valuations: [{ ...value, id: "a", review: { summary: "old" }, reviewedAt: "old" }, { ...value, id: "b" }], selectedValuationId: "b", fairLow: 10, fairHigh: 20 };
    const updated = valuationChange(base, "a", value); expect(updated.fairLow).toBe(10); expect(updated.selectedValuationId).toBe("b"); expect(updated.valuations[0].review).toBeUndefined(); expect(base.valuations[0].review).toBeDefined();
    expect(() => valuationChange(cfg, null, { ...value, high: 40 })).toThrow();
  });
});
