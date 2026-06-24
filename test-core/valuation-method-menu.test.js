import { describe, expect, it } from "vitest";
import { METHOD_MENU_GROUPS, MODELS } from "../public/shared/valuation/index.js";

describe("valuation method menu metadata", () => {
  it("groups methods by valuation lens with titles and subtitles", () => {
    expect(METHOD_MENU_GROUPS.map((group) => group.title.zh)).toEqual([
      "现金流折现",
      "资产重估",
      "倍数反推",
    ]);

    const modelKeys = new Set(MODELS.map((model) => model.key));
    const menuKeys = METHOD_MENU_GROUPS.flatMap((group) => group.methods.map((method) => method.key));

    expect(menuKeys).toEqual(["fcff", "fcf", "fcfe", "ddm", "navsotp", "pe", "peg", "pb", "ps", "evebitda"]);
    expect(new Set(menuKeys)).toEqual(modelKeys);

    for (const group of METHOD_MENU_GROUPS) {
      expect(group.title.zh).toBeTruthy();
      expect(group.title.en).toBeTruthy();
      for (const method of group.methods) {
        expect(method.title.zh).toBeTruthy();
        expect(method.title.en).toBeTruthy();
        expect(method.subtitle.zh).toBeTruthy();
        expect(method.subtitle.en).toBeTruthy();
      }
    }
  });
});
