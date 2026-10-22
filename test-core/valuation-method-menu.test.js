import { describe, expect, it } from "vitest";
import { METHOD_MENU_GROUPS, METHOD_FRAMEWORK_NOTES, MODELS } from "../public/shared/valuation/index.js";

describe("valuation method menu metadata", () => {
  it("groups methods by valuation lens with titles and subtitles", () => {
    expect(METHOD_MENU_GROUPS.map((group) => group.title.zh)).toEqual([
      "内在估值 · 现金流折现",
      "相对估值 · 市场定价",
      "或有权益 · 期权估值",
      "资产基础 · 清算与净流动资产",
      "组合框架 · 分部加总",
    ]);

    const modelKeys = new Set(MODELS.map((model) => model.key));
    const menuKeys = METHOD_MENU_GROUPS.flatMap((group) => group.methods.map((method) => method.key));

    expect(menuKeys).toEqual(["fcff", "fcf", "fcfe", "ddm", "navsotp", "apv", "pe", "peg", "evebitda", "pb", "ps", "evsales", "tobinq", "sector", "options", "liquidation", "ncav", "sotp"]);
    expect(new Set(menuKeys)).toEqual(modelKeys);
    expect(menuKeys.length).toBe(modelKeys.size);

    for (const group of METHOD_MENU_GROUPS) {
      expect(group.title.zh).toBeTruthy();
      expect(group.title.en).toBeTruthy();
      expect(group.description.zh).toBeTruthy();
      expect(group.description.en).toBeTruthy();
      for (const method of group.methods) {
        expect(method.title.zh).toBeTruthy();
        expect(method.title.en).toBeTruthy();
        expect(method.subtitle.zh).toBeTruthy();
        expect(method.subtitle.en).toBeTruthy();
        expect(method.category.zh).toBeTruthy();
        expect(method.category.en).toBeTruthy();
      }
    }
  });
  it("keeps framework explanations outside selectable calculators", () => {
    for (const note of METHOD_FRAMEWORK_NOTES) {
      expect(MODELS.some((model) => model.key === note.key)).toBe(false);
      for (const lang of ["zh", "en"]) {
        expect(note.title[lang]).toBeTruthy();
        expect(note.description[lang]).toBeTruthy();
      }
    }
    expect(METHOD_MENU_GROUPS[0].methods.map((method) => method.key)).toContain("navsotp");
    expect(MODELS.find((model) => model.key === "navsotp")).toBeDefined();
  });
});
