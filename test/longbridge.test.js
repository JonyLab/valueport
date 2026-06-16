import { describe, it, expect } from "vitest";
import { tencentToLongport, longportToTencent, parseStaticInfo } from "../src/longbridge.js";

describe("symbol mapping tencent <-> longport", () => {
  it("maps each market to longport format", () => {
    expect(tencentToLongport("usAAPL")).toBe("AAPL.US");
    expect(tencentToLongport("hk00700")).toBe("700.HK");   // strip leading zeros
    expect(tencentToLongport("sh600519")).toBe("600519.SH");
    expect(tencentToLongport("sz000001")).toBe("000001.SZ");
    expect(tencentToLongport("bj430047")).toBe("430047.BJ");
    expect(tencentToLongport("garbage")).toBe(null);
  });
  it("round-trips back to tencent format", () => {
    expect(longportToTencent("AAPL.US")).toBe("usAAPL");
    expect(longportToTencent("700.HK")).toBe("hk00700");   // pad back to 5 digits
    expect(longportToTencent("600519.SH")).toBe("sh600519");
    expect(longportToTencent("000001.SZ")).toBe("sz000001");
  });
});

describe("parseStaticInfo extracts fundamentals", () => {
  const pstr = (field, s) => { const b = new TextEncoder().encode(s); return [(field << 3) | 2, b.length, ...b]; };
  const pvar = (field, n) => { const o = [(field << 3) | 0]; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
  const inner = [
    ...pstr(1, "AAPL.US"), ...pstr(2, "苹果"), ...pstr(3, "Apple"),
    ...pstr(6, "NASDAQ"), ...pstr(7, "USD"), ...pvar(9, 15000000000),
    ...pstr(13, "6.5"), ...pstr(14, "4.2"), ...pstr(15, "0.5"),
  ];
  const body = new Uint8Array([(1 << 3) | 2, inner.length, ...inner]);
  it("parses symbol, names, and fundamental fields", () => {
    const out = parseStaticInfo(body);
    expect(out).toHaveLength(1);
    const r = out[0];
    expect(r.sym).toBe("AAPL.US");
    expect(r.cn).toBe("苹果");
    expect(r.en).toBe("Apple");
    expect(r.exchange).toBe("NASDAQ");
    expect(r.currency).toBe("USD");
    expect(r.totalShares).toBe(15000000000);
    expect(r.epsTtm).toBe("6.5");
    expect(r.bps).toBe("4.2");
    expect(r.dividendYield).toBe("0.5");
  });
});
