import { describe, it, expect } from "vitest";
import { guideClaims, cleanGuideAudit, guideAuditLabels } from "../public/shared/valuation/guide-audit.js";
import { cleanFlowState } from "../public/shared/valuation/thesis-guide-ui.js";

const guide = { type: "question", context: "[1] 净负债上升", question: "如何平衡增长和负债？", options: [{ label: "如果产量提升，利润可能增长", detail: "仍需观察现金流" }, { label: "[9] 不存在的资料" }] };
const references = ["2025 年净负债上升"];
const audit = { status: "used", references, items: [
  { path: "context", text: guide.context, kind: "fact", support: "supported" },
  { path: "options.1.label", text: guide.options[1].label, kind: "fact", support: "supported" },
] };

describe("guide evidence checks", () => {
  it("binds each judgment to its exact passage and numbered source snapshot", () => {
    expect(guideClaims(guide)).toHaveLength(5);
    expect(cleanGuideAudit(audit, guide, references).items[0].support).toBe("supported");
    expect(cleanGuideAudit(audit, { ...guide, context: "[1] 净负债下降" }, references).items.map((i) => i.path)).not.toContain("context");
    expect(cleanGuideAudit(audit, guide, ["2026 年净负债下降"])).toBeNull();
    expect(cleanGuideAudit(audit, guide, [])).toBeNull();
    expect(cleanGuideAudit({ ...audit, items: [null, { path: "context", text: guide.context, kind: "html", support: "supported" }] }, guide, references).items).toEqual([]);
  });
  it("overrides favorable model judgments for missing sources and keeps warnings separate from assumptions", () => {
    const clean = cleanGuideAudit(audit, guide, references);
    expect(clean.items[1].support).toBe("missing_source");
    expect(guideAuditLabels(clean.items[1])).toMatchObject({ warning: true, support: "引用编号缺少对应资料" });
    expect(guideAuditLabels({ kind: "assumption", support: "not_applicable" })).toMatchObject({ kind: "叙事假设", warning: false });
    expect(guideAuditLabels({ kind: "fact", support: "uncited" }, "en").warning).toBe(true);
  });
  it("keeps conservative and optimistic evidence paths separate", () => {
    const claims = guideClaims({ type: "summary", drafts: { c: { story: "保守", evidence: "[1] 历史事实", impacts: [{ reason: "可能承压" }] }, o: { story: "乐观", evidence: "[2] 待验证" }, conflict: "方向待确认" } });
    expect(claims.map((i) => i.path)).toEqual(["drafts.c.story", "drafts.c.evidence", "drafts.c.impacts.0.reason", "drafts.o.story", "drafts.o.evidence", "drafts.conflict"]);
  });
  it("restores previous questions with their own reference snapshots and drops stale checks", () => {
    const question = { ...guide, selection: "single", options: guide.options.map((option, i) => ({ ...option, id: String.fromCharCode(97 + i) })) };
    const state = cleanFlowState({ stage: "story", turns: [{ question: "q", answer: "a" }], question,
      references: ["new sources"], audit, history: [{ question, references, audit, selected: ["a"] }] });
    expect(state.audit).toBeNull();
    expect(state.history[0].references).toEqual(references);
    expect(state.history[0].audit.items[0].support).toBe("supported");
    const legacy = cleanFlowState({ stage: "story", turns: [], question, history: [] });
    expect(legacy.references).toEqual([]); expect(legacy.audit).toBeNull();
  });
});
