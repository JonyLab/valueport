import { describe, expect, it } from "vitest";
import { resourceAiFields, resourceAiFacts, applyResourceAiParams } from "../public/shared/valuation/resource-ai.js";
import { RESOURCE } from "../public/shared/valuation/resource.js";
import { buildSystemPrompt, parseSuggestion, validateChat } from "../src/ai.js";

const form = () => ({
  wacc: { c: 10, o: 8 }, taxRate: 25, netDebt: 1e8,
  prices: { gold: { c: 600, o: 820 } },
  assets: [
    { type: "mine", name: "Gold mine", commodity: "gold", output: 5, unitCost: 300, life: 20 },
    { type: "fixed", name: "Other assets", value: 2e8 },
    { type: "option", name: "Undeveloped copper", commodity: "copper", reserves: 10, marginalCost: 30000, devCost: 1e9, sigma: 30, years: 10, rf: 3 },
  ],
});

describe("resource valuation AI integration", () => {
  it("exposes prices and every editable mine, fixed-pack and option input with units", () => {
    const fields = resourceAiFields(form());
    expect(fields.find((f) => f.k === "resource.price.gold")).toMatchObject({ col: "dual", unit: "元/克", isDefault: true });
    expect(fields.find((f) => f.k === "resource.asset.0.output")).toMatchObject({ value: 5, unit: "吨" });
    expect(fields.find((f) => f.k === "resource.asset.1.value")).toMatchObject({ value: 2e8, money: true, unit: "CNY" });
    expect(fields.filter((f) => f.k.startsWith("resource.asset.2."))).toHaveLength(6);
    expect(resourceAiFacts(form()).assets[0].name).toBe("Gold mine");
  });

  it("keeps missing quantities unknown instead of converting them to zero", () => {
    const f = form(); f.assets[0].output = NaN;
    expect(resourceAiFields(f).find((x) => x.k === "resource.asset.0.output").value).toBeNull();
  });

  it("parses and applies nested suggestions to the real NAV inputs without mutating the snapshot", () => {
    const original = form(), fields = resourceAiFields(original);
    const parsed = parseSuggestion('```json\n' + JSON.stringify({ params: {
      "resource.price.gold": { c: 650, o: 900 }, "resource.asset.0.output": 6,
      "resource.asset.1.value": 3e8, "resource.asset.2.sigma": 35,
      "resource.asset.999.output": 999,
    } }) + '\n```', fields);
    expect(parsed.params).not.toHaveProperty("resource.asset.999.output");
    const next = applyResourceAiParams(original, parsed.params, fields);
    expect(next.prices.gold).toEqual({ c: 650, o: 900 });
    expect(next.assets[0].output).toBe(6);
    expect(next.assets[1].value).toBe(3e8);
    expect(next.assets[2].sigma).toBe(35);
    expect(original.assets[0].output).toBe(5);
    expect(original.prices.gold.c).toBe(600);
    const model = RESOURCE[0], ctx = { shares: 1e9 };
    expect(model.run(next, ctx).low).toBeGreaterThan(model.run(original, ctx).low);
    expect(Object.keys(next).some((k) => k.startsWith("resource."))).toBe(false);
  });

  it("rejects stale suggestions when assets have changed", () => {
    const original = form(), fields = resourceAiFields(original);
    original.assets.reverse();
    expect(() => applyResourceAiParams(original, { "resource.asset.0.output": 7 }, fields)).toThrow("resource_inputs_changed");
  });

  it("sends the company and resource-specific valuation rules with the actual asset context", () => {
    const context = { stock: { name: "Example miner", code: "MINER" }, method: { key: "navsotp", label: "NAV / SOTP" },
      fields: resourceAiFields(form()), facts: { resourceValuation: resourceAiFacts(form()) } };
    const prompt = buildSystemPrompt(context, "zh");
    for (const text of ["Example miner", "Gold mine", "resource.price.gold", "无永续价值", "较高 WACC", "不得凭公司名称补造", "权益年产量", "Black–Scholes", "人民币"]) expect(prompt).toContain(text);
    expect(buildSystemPrompt({ ...context, method: { key: "pe" } }, "zh")).not.toContain("资源股 NAV / SOTP 专用口径");
    expect(validateChat({ messages: [{ role: "user", content: "Full assumptions" }], context })).toBeNull();
    const many = Array.from({ length: 41 }, (_, i) => ({ k: `f${i}`, col: "single" }));
    expect(validateChat({ messages: [{ role: "user", content: "hi" }], context: { ...context, fields: many } })).toBeNull();
    expect(validateChat({ messages: [{ role: "user", content: "hi" }], context: { ...context, method: { key: "pe" }, fields: many } })).toBeTruthy();
  });
});
