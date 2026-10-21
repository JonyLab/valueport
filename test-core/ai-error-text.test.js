import { describe, it, expect, vi } from "vitest";
import { aiErrorText } from "../public/shared/ai-panel.js";

describe("aiErrorText", () => {
  it("never shows bare status codes or internal error tokens to users", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [status, body] of [[503, {}], [502, { error: "upstream_error" }], [500, { detail: "TypeError: x is undefined" }], [504, null]]) {
      const zh = aiErrorText(status, body, "zh");
      expect(zh).not.toMatch(/\d{3}|upstream|TypeError/); expect(zh).toContain("稍后再试");
      expect(aiErrorText(status, body, "en")).not.toMatch(/\d{3}|upstream|TypeError/);
    }
    expect(aiErrorText(401, {}, "zh")).toContain("重新登录");
    expect(aiErrorText(429, {}, "zh")).toContain("次数已用完");
    expect(aiErrorText(400, { error: "bad turns" }, "zh")).not.toContain("bad turns");
    expect(aiErrorText(500, { detail: "模型暂时不可用" }, "zh")).toBe("模型暂时不可用"); // 已经是给人看的中文说明
  });
});
