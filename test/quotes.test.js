import { describe, it, expect } from "vitest";
import { parseTencentQuotes, parseTencentHints } from "../src/quotes.js";

describe("parseTencentQuotes", () => {
  it("extracts price (field index 3) per symbol", () => {
    const text =
      'v_usAAPL="1~苹果~AAPL~232.10~230~231~..."; \n' +
      'v_usNVDA="1~英伟达~NVDA~118.40~117~118~...";';
    expect(parseTencentQuotes(text, ["usAAPL", "usNVDA"])).toEqual({
      usAAPL: 232.1, usNVDA: 118.4,
    });
  });
  it("omits symbols with no/zero price", () => {
    const text = 'v_usAAPL="1~苹果~AAPL~0~...";';
    expect(parseTencentQuotes(text, ["usAAPL"])).toEqual({});
  });
  it("ignores symbols with illegal (regex-injection) characters", () => {
    const text = 'v_usAAPL="1~苹果~AAPL~232.10~...";';
    expect(parseTencentQuotes(text, ["usAAPL", "us(.*"])).toEqual({ usAAPL: 232.1 });
  });
});

describe("parseTencentHints", () => {
  it("parses smartbox hint string into structured suggestions", () => {
    const text = 'v_hint="us~AAPL.OQ~Apple Inc~~^sh~600519~贵州茅台~~";';
    const out = parseTencentHints(text);
    expect(out[0]).toMatchObject({ mkt: "us", code: "AAPL", name: "Apple Inc", symbol: "usAAPL" });
    expect(out[1]).toMatchObject({ mkt: "sh", code: "600519", symbol: "sh600519" });
  });
  it("decodes \\u-escaped names back to real characters (sz 万科A)", () => {
    // smartbox actually returns names as \uXXXX (backslash-u)
    const text = 'v_hint="sz~000002~\\u4e07\\u79d1A~~";';
    const out = parseTencentHints(text);
    expect(out[0]).toMatchObject({ mkt: "sz", code: "000002", name: "万科A", symbol: "sz000002" });
  });
  it("also decodes %u-escaped names", () => {
    const text = 'v_hint="us~MRVL~%u8FC8%u5A01%u5C14%u79D1%u6280~~";';
    const out = parseTencentHints(text);
    expect(out[0]).toMatchObject({ mkt: "us", code: "MRVL", name: "迈威尔科技", symbol: "usMRVL" });
  });
  it("returns at most 8 suggestions", () => {
    const entry = "us~AAPL.OQ~Apple Inc~~";
    const text = `v_hint="${Array(12).fill(entry).join("^")}";`;
    expect(parseTencentHints(text).length).toBe(8);
  });
});
