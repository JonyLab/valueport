import { describe, it, expect } from "vitest";
import { parseTencentQuotes, parseTencentHints, parseTencentStatics, parseTencentPrevClose, logoTicker } from "../src/quotes.js";

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

describe("parseTencentStatics", () => {
  // 造一条 n 个字段的行情串，按 {索引: 值} 填充
  const row = (sym, n, vals) => {
    const f = Array.from({ length: n }, () => "0");
    for (const [i, v] of Object.entries(vals)) f[i] = v;
    return `v_${sym}="${f.join("~")}";`;
  };
  it("reads US names, shares at 62, currency at 35 and EPS from price / PE", () => {
    const text = row("usAAPL", 73, { 1: "苹果", 3: "343.46", 35: "USD", 39: "39.39", 46: "Apple Inc.", 62: "14594180000" });
    const r = parseTencentStatics(text, ["usAAPL"]).usAAPL;
    expect(r).toMatchObject({ cn: "苹果", en: "Apple Inc.", currency: "USD", totalShares: 14594180000 });
    expect(r.epsTtm).toBeCloseTo(343.46 / 39.39, 6);
  });
  it("reads 52-week range (US/HK 48/49, A-share 67/68) and PE", () => {
    const us = row("usAAPL", 73, { 3: "343.46", 39: "39.39", 48: "348.15", 49: "242.76" });
    expect(parseTencentStatics(us, ["usAAPL"]).usAAPL).toMatchObject({ high52: 348.15, low52: 242.76, peTtm: 39.39 });
    const a = row("sh600519", 88, { 3: "1329.00", 39: "20.40", 67: "1539.98", 68: "1151.01" });
    expect(parseTencentStatics(a, ["sh600519"]).sh600519).toMatchObject({ high52: 1539.98, low52: 1151.01 });
  });
  it("reads HK shares at 69 and currency at 75", () => {
    const text = row("hk01810", 78, { 1: "小米集团-W", 3: "26.66", 39: "14.92", 46: "XIAOMI-W", 69: "25795798357.00", 75: "HKD" });
    expect(parseTencentStatics(text, ["hk01810"]).hk01810).toMatchObject({ en: "XIAOMI-W", currency: "HKD", totalShares: 25795798357 });
  });
  it("reads A-share shares at 73, currency at 82 and leaves en empty", () => {
    const text = row("sh600519", 88, { 1: "贵州茅台", 3: "1329.00", 39: "20.40", 46: "6.61", 73: "1250081601", 82: "CNY" });
    expect(parseTencentStatics(text, ["sh600519"]).sh600519).toMatchObject({ cn: "贵州茅台", en: "", currency: "CNY", totalShares: 1250081601 });
  });
  it("returns NaN EPS when PE is zero and skips missing or unsafe symbols", () => {
    const text = row("usMU", 73, { 1: "美光科技", 3: "100", 39: "0", 46: "Micron Technology", 62: "1000" });
    expect(parseTencentStatics(text, ["usMU"]).usMU.epsTtm).toBeNaN();
    expect(parseTencentStatics(text, ["usMSFT", "us.*"])).toEqual({});
  });
});

describe("parseTencentPrevClose", () => {
  it("reads previous close at index 4 and skips non-positive values", () => {
    const text = 'v_usAAPL="200~苹果~AAPL.OQ~343.46~342.00~346.09";\nv_hk01810="100~小米~01810~26.66~0~27.02";';
    expect(parseTencentPrevClose(text, ["usAAPL", "hk01810"])).toEqual({ usAAPL: 342 });
  });
});


describe("logoTicker", () => {
  it("maps Tencent symbols to logo tickers per market", () => {
    expect(logoTicker("usAAPL")).toBe("AAPL");
    expect(logoTicker("usBRK.B")).toBe("BRK-B");
    expect(logoTicker("hk01810")).toBe("1810.HK");
    expect(logoTicker("hk00700")).toBe("0700.HK");
    expect(logoTicker("sh600519")).toBe("600519.SS");
    expect(logoTicker("sz000338")).toBe("000338.SZ");
  });
  it("rejects unknown markets and malformed codes", () => {
    for (const s of ["bj430047", "hkABC", "us../x", "", "xx123"]) expect(logoTicker(s)).toBeNull();
  });
});
