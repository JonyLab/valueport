import { describe, it, expect } from "vitest";
import { symbolToSecucode, parseDeducted } from "../src/eastmoney.js";

describe("symbolToSecucode", () => {
  it("A股加交易所后缀", () => {
    expect(symbolToSecucode("sh688981")).toBe("688981.SH");
    expect(symbolToSecucode("sz000001")).toBe("000001.SZ");
    expect(symbolToSecucode("bj830799")).toBe("830799.BJ");
  });
  it("非A股(美股/港股)→ null", () => {
    expect(symbolToSecucode("usAAPL")).toBe(null);
    expect(symbolToSecucode("hk00700")).toBe(null);
    expect(symbolToSecucode("")).toBe(null);
  });
});

describe("parseDeducted", () => {
  const json = { result: { data: [
    { SECUCODE: "688981.SH", REPORT_DATE: "2026-03-31 00:00:00", KCFJCXSYJLR: 1232279000 },
    { SECUCODE: "688981.SH", REPORT_DATE: "2025-12-31 00:00:00", KCFJCXSYJLR: 4500000000 },
    { SECUCODE: "688981.SH", REPORT_DATE: "2024-12-31 00:00:00", KCFJCXSYJLR: 4000000000 },
  ] } };
  it("取最新年报(12-31)的扣非,忽略季报行", () => {
    expect(parseDeducted(json)).toBe(4500000000);
  });
  it("不依赖输入顺序(自排序取最新年报)", () => {
    const shuffled = { result: { data: [json.result.data[2], json.result.data[0], json.result.data[1]] } };
    expect(parseDeducted(shuffled)).toBe(4500000000);
  });
  it("最新年报值无效则取上一年报", () => {
    const j = { result: { data: [
      { REPORT_DATE: "2025-12-31", KCFJCXSYJLR: null },
      { REPORT_DATE: "2024-12-31", KCFJCXSYJLR: 4000000000 },
    ] } };
    expect(parseDeducted(j)).toBe(4000000000);
  });
  it("无数据 / 结构异常 → null", () => {
    expect(parseDeducted({ result: { data: [] } })).toBe(null);
    expect(parseDeducted(null)).toBe(null);
    expect(parseDeducted({})).toBe(null);
  });
});
