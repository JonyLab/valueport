import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFinancials, pickLatestAnnual, symbolToCounterId } from "../src/longbridge.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/financials-aapl.json", import.meta.url)), "utf8"));

describe("symbolToCounterId", () => {
  it("maps longport symbols to ST/<MARKET>/<CODE>", () => {
    expect(symbolToCounterId("AAPL.US")).toBe("ST/US/AAPL");
    expect(symbolToCounterId("700.HK")).toBe("ST/HK/700");
    expect(symbolToCounterId("600519.SH")).toBe("ST/SH/600519");
  });
});

describe("parseFinancials", () => {
  it("flattens list[kind].indicators[].accounts[] into {IS,BS,CF}", () => {
    const f = parseFinancials(fixture);
    expect(Object.keys(f)).toEqual(expect.arrayContaining(["IS", "BS", "CF"]));
    const rev = f.IS.find((a) => a.field === "OperatingRevenue");
    expect(rev.name).toContain("营业收入");
    expect(rev.values[0].year).toBe(2025);
    expect(rev.values[0].value).toBeCloseTo(416161000000, 0);
    expect(rev.currency).toBe("USD");
  });
  it("returns null on error/empty payloads", () => {
    expect(parseFinancials({ code: 404000, data: null })).toBe(null);
    expect(parseFinancials(null)).toBe(null);
    expect(parseFinancials({ code: 0, data: {} })).toBe(null);
  });
});

describe("pickLatestAnnual", () => {
  it("picks revenue/netIncome/netDebt from the latest annual period", () => {
    const latest = pickLatestAnnual(parseFinancials(fixture));
    expect(latest.revenue).toBeCloseTo(416161000000, 0);
    expect(latest.netIncome).toBeCloseTo(112010000000, 0);
    expect(typeof latest.netDebt).toBe("number");
  });
  it("returns all-null for null financials", () => {
    expect(pickLatestAnnual(null)).toEqual({ revenue: null, netIncome: null, netDebt: null });
  });
});
