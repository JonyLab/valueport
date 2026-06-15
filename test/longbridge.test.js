import { describe, it, expect } from "vitest";
import { tencentToLongport, longportToTencent } from "../src/longbridge.js";

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
