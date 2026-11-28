import { describe, it, expect } from "vitest";
import { zoneFor, normSymbol, currencyOfSymbol, parseCredBlob, summarizePortfolio } from "../public/shared/portfolio/model.js";

describe("portfolio/model.js", () => {
  it("normalizes symbols across US, HK, and CN formats", () => {
    expect(normSymbol("AAPL")).toBe("usAAPL");
    expect(normSymbol("aapl.us")).toBe("usAAPL");
    expect(normSymbol("700.HK")).toBe("hk00700");
    expect(normSymbol("700")).toBe("hk00700");
    expect(normSymbol("600519")).toBe("sh600519");
    expect(normSymbol("000858.SZ")).toBe("sz000858");
    expect(currencyOfSymbol("usAAPL")).toBe("USD");
    expect(currencyOfSymbol("hk00700")).toBe("HKD");
    expect(currencyOfSymbol("sh600519")).toBe("CNY");
  });

  it("parses Longbridge and IBKR credential blobs", () => {
    const lb = parseCredBlob("LONGBRIDGE_APP_KEY=k1\nLONGBRIDGE_APP_SECRET=sec2\nLONGBRIDGE_ACCESS_TOKEN=tok3", "longbridge");
    expect(lb).toEqual({ appKey: "k1", appSecret: "sec2", accessToken: "tok3" });
    const bare = parseCredBlob("short\nmedium-secret\nvery-long-access-token-here", "longbridge");
    expect(bare).toEqual({ appKey: "short", appSecret: "medium-secret", accessToken: "very-long-access-token-here" });
    const ib = parseCredBlob(JSON.stringify({ token: "t1", queryId: "q2" }), "ibkr");
    expect(ib).toEqual({ token: "t1", queryId: "q2" });
  });

  it("summarizes holdings, cash, valuation zones, and target drift", () => {
    const item = { symbol: "usAAPL", ticker: "AAPL", name: "Apple", fairLow: 100, fairHigh: 120, mos: 20, ext: 30 };
    expect(zoneFor(item, 70)).toBe(0); // strike zone
    expect(zoneFor(item, 180)).toBe(4); // bubble
    expect(zoneFor(null, 100)).toBe(-1);

    const s = summarizePortfolio({
      accounts: [{ id: 1, name: "Main" }],
      holdings: [{ accountId: 1, symbol: "usAAPL", name: "Apple", quantity: 10, costPrice: 60, currency: "USD", market: "US" }],
      cash: [{ accountId: 1, currency: "USD", amount: 300 }],
      quotes: { usAAPL: 70 },
      prevClose: { usAAPL: 68 },
      fx: { USD: 1 },
      items: [item],
      plan: { targets: { usAAPL: 50 }, cash: 20, band: 5, rel: 25 },
    }, { lang: "en" });

    expect(s.holdValue).toBe(700);
    expect(s.cashValue).toBe(300);
    expect(s.total).toBe(1000);
    expect(s.pnl).toBe(100);
    expect(s.day).toBe(20);
    expect(s.rows[0].zone).toBe(0);
    expect(s.plan.active).toBe(true);
    expect(s.plan.rows[0].status).toBe("over"); // 70% vs 50% target
  });
});
