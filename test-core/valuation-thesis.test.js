import { describe, it, expect } from "vitest";
import { cleanThesis, thesisLines, suggestedImpacts, impactParameterHint } from "../public/shared/valuation/thesis.js";
import { MODELS, modeFields } from "../public/shared/valuation/index.js";

describe("scenario stories", () => {
  it("keeps scenarios separate and normalizes legacy records without assigning them a case", () => {
    const raw = { c: { story: "  竞争加剧  " }, o: { story: "新品放量" }, story: "旧的共享故事" };
    const clean = cleanThesis(raw);
    expect(clean).toEqual({ c: { story: "竞争加剧" }, o: { story: "新品放量" }, legacy: { story: "旧的共享故事" } });
    expect(cleanThesis(clean)).toEqual(clean);
    expect(thesisLines(clean)).toEqual(["保守场景 · 核心判断：竞争加剧", "乐观场景 · 核心判断：新品放量", "未分场景的旧记录 · 核心判断：旧的共享故事"]);
  });
  it("supports one unfinished story without inventing another one", () => {
    expect(cleanThesis({ o: { story: "只写了乐观场景", assessment: null }, c: [] })).toEqual({ o: { story: "只写了乐观场景" } });
    expect(thesisLines({ c: { assessment: "尚待验证" } }, "en")).toEqual(["Conservative case · Test the story：尚待验证"]);
  });
  it("round-trips evidence and separate impact directions without losing older prose", () => {
    const thesis = { c: { story: "扩张放缓", assessment: "旧记录", evidence: " 年报第 20 页 ", uncertainties: "客户留存待核实", impacts: [{ key: "risk", direction: "up", reason: " 竞争加剧 " }] }, o: { impacts: [{ key: "growth", direction: "unknown", reason: "" }] } };
    const clean = cleanThesis(thesis);
    expect(clean.c).toMatchObject({ assessment: "旧记录", evidence: "年报第 20 页", impacts: [{ key: "risk", direction: "up", reason: "竞争加剧" }] });
    expect(cleanThesis(clean)).toEqual(clean);
    expect(thesisLines(clean)).toContain("保守场景 · 经营与融资风险：上升：竞争加剧");
    expect(thesisLines(clean)).toContain("保守场景 · 已有依据：年报第 20 页");
    expect(clean.o.impacts[0].direction).toBe("unknown");
  });
  it("bounds untrusted impact data and does not create numerical assumptions", () => {
    const clean = cleanThesis({ c: { impacts: [{ key: "growth", direction: "invented", reason: "x".repeat(900), value: 100 }, { key: "growth", direction: "up", reason: "duplicate" }, { key: "fake", direction: "up" }, null] } });
    expect(clean.c.impacts).toEqual([{ key: "growth", direction: "unknown", reason: "x".repeat(800) }]);
    expect(suggestedImpacts("新产品推动海外扩张，但竞争加剧")).toEqual(["growth", "reinvestment", "risk"]);
    expect(suggestedImpacts("")).toEqual([]);
  });
  it("maps only actual model fields and explains indirect PB effects", () => {
    const fcff = MODELS.find((model) => model.key === "fcff"), pb = MODELS.find((model) => model.key === "pb");
    expect(impactParameterHint("growth", modeFields(fcff), "fcff")).toContain("高增长期营收增速");
    expect(impactParameterHint("reinvestment", modeFields(fcff), "fcff")).toContain("销售/资本比");
    expect(impactParameterHint("growth", modeFields(pb), "pb")).toContain("P/B 不直接预测");
    expect(impactParameterHint("returns", modeFields(pb), "pb")).toContain("目标 PB");
  });
});
