import { describe, it, expect } from "vitest";
import { fmt, fmtMoney, parseMoney, fmtKind, fmtRange, initialFor, textFor } from "../public/shared/valuation/ui-format.js";

describe("valuation/ui-format.js", () => {
  it("parses unitized English and Chinese money expressions", () => {
    expect(parseMoney("1,200")).toBe(1200);
    expect(parseMoney("3.5B")).toBe(3.5e9);
    expect(parseMoney("-2.4m")).toBe(-2.4e6);
    expect(parseMoney("1.5万亿")).toBe(1.5e12);
    expect(parseMoney("80亿")).toBe(8e9);
    expect(parseMoney("50万")).toBe(5e5);
    expect(parseMoney("invalid")).toBeNaN();
    expect(parseMoney("")).toBeNaN();
  });

  it("formats numbers, money, kinds, and ranges", () => {
    expect(fmt(12.345)).toBe("12.35");
    expect(fmt(null, "—")).toBe("—");
    expect(fmtMoney(2.5e9)).toBe("2.50B");
    expect(fmtMoney(-1.2e6)).toBe("-1.20M");
    expect(fmtKind(15.23, "mult")).toBe("15.2x");
    expect(fmtKind(12.34, "pct")).toBe("12.3%");
    expect(fmtRange(10, 15, "mult")).toBe("10.0x–15.0x");
    expect(fmtRange(10, 10, "mult")).toBe("10.0x");
    expect(fmtRange(NaN, NaN, "mult")).toBe("—");
  });

  it("resolves field initial values and localized text", () => {
    expect(initialFor({ prefill: () => 42, default: 10 }, {})).toBe(42);
    expect(initialFor({ prefill: () => NaN, default: 10 }, {})).toBe(10);
    expect(initialFor({ prefill: () => { throw new Error("boom"); }, default: 7 }, {})).toBe(7);
    expect(textFor({ zh: "中文", en: "English" }, "en")).toBe("English");
    expect(textFor({ zh: "中文" }, "en")).toBe("中文");
    expect(textFor(null, "en", "fallback")).toBe("fallback");
  });
});
