import { describe, it, expect } from "vitest";
import { parseLongbridgePositions, parseLongbridgeBalances, fetchLongbridgeAssets } from "../src/brokers/longbridge-assets.js";
import { parseIbkrFlexStatement, fetchIbkrFlex } from "../src/brokers/ibkr-flex.js";
import { parseHoldingsCsv, normalizeSymbol } from "../src/brokers/csv.js";

/* ---------- Longbridge ---------- */
const LB_STOCK = {
  code: 0,
  data: {
    list: [
      {
        account_channel: "lb",
        stock_info: [
          { symbol: "700.HK", symbol_name: "腾讯控股", quantity: "100", available_quantity: "100", currency: "HKD", cost_price: "320.5", market: "HK" },
          { symbol: "AAPL.US", symbol_name: "Apple", quantity: "10", currency: "USD", cost_price: "150", market: "US" },
          { symbol: "600519.SH", symbol_name: "贵州茅台", quantity: "200", currency: "CNY", cost_price: "1700.25", market: "CN" },
          { symbol: "AAPL250117C150000.US", symbol_name: "AAPL Call", quantity: "1", currency: "USD", cost_price: "5", market: "US" },
          { symbol: "D05.SG", symbol_name: "DBS", quantity: "10", currency: "SGD", cost_price: "30", market: "SG" },
          { symbol: "BAD.HK", quantity: "x" },
        ],
      },
      { account_channel: "lb2", stock_info: [{ symbol: "AAPL.US", symbol_name: "Apple", quantity: "10", currency: "USD", cost_price: "170" }] },
    ],
  },
};

describe("longbridge parsers", () => {
  it("maps HK/US/A-share symbols, merges channels, skips options/SG", () => {
    const r = parseLongbridgePositions(LB_STOCK);
    const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
    expect(Object.keys(by).sort()).toEqual(["hk00700", "sh600519", "usAAPL"]);
    expect(by.hk00700).toMatchObject({ name: "腾讯控股", quantity: 100, costPrice: 320.5, currency: "HKD", market: "HK" });
    expect(by.sh600519).toMatchObject({ quantity: 200, costPrice: 1700.25, currency: "CNY", market: "CN" });
    expect(by.usAAPL.quantity).toBe(20);
    expect(by.usAAPL.costPrice).toBeCloseTo(160);
    expect(r.unsupported.map((u) => u.raw)).toEqual(["AAPL250117C150000.US", "D05.SG", "BAD.HK"]);
  });

  it("sums balances per currency (cash_infos detail, total_cash fallback)", () => {
    const cash = parseLongbridgeBalances({
      code: 0,
      data: {
        list: [
          { currency: "HKD", total_cash: "999", cash_infos: [
            { currency: "HKD", available_cash: "1000", withdraw_cash: "900", frozen_cash: "50", settling_cash: "-20" },
            { currency: "USD", available_cash: "200.5", frozen_cash: "0", settling_cash: "0" },
          ] },
          { currency: "USD", total_cash: "100", cash_infos: [] },
        ],
      },
    });
    expect(cash).toEqual([{ currency: "HKD", amount: 1030 }, { currency: "USD", amount: 300.5 }]);
  });

  it("throws on non-zero code", () => {
    expect(() => parseLongbridgePositions({ code: 401003, message: "token expired" })).toThrow(/code 401003 token expired/);
    expect(() => parseLongbridgeBalances(null)).toThrow(/invalid response/);
  });

  it("fetchLongbridgeAssets wires both endpoints with creds as env", async () => {
    const seen = [];
    const get = async (env, path) => {
      seen.push([env.LONGBRIDGE_APP_KEY, path]);
      return path === "/v1/asset/stock" ? LB_STOCK : { code: 0, data: { list: [{ currency: "HKD", total_cash: "5" }] } };
    };
    const r = await fetchLongbridgeAssets({ appKey: "k", appSecret: "s", accessToken: "t" }, get);
    expect(seen.map((x) => x[1]).sort()).toEqual(["/v1/asset/account", "/v1/asset/stock"]);
    expect(seen[0][0]).toBe("k");
    expect(r.positions).toHaveLength(3);
    expect(r.cash).toEqual([{ currency: "HKD", amount: 5 }]);
    await expect(fetchLongbridgeAssets({ appKey: "k", appSecret: "s", accessToken: "t" }, async () => ({ code: 403, message: "forbidden" })))
      .rejects.toThrow(/longbridge .*code 403/);
    await expect(fetchLongbridgeAssets({ appKey: "k" }, get)).rejects.toThrow(/missing credentials/);
  });
});

/* ---------- IBKR Flex ---------- */
const FLEX = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="pos" type="AF">
<FlexStatements count="2">
<FlexStatement accountId="U111" fromDate="20261016" toDate="20261016">
<OpenPositions>
<OpenPosition accountId="U111" currency="USD" assetCategory="STK" symbol="AAPL" description="APPLE INC" listingExchange="NASDAQ" position="10" costBasisPrice="150.2" levelOfDetail="SUMMARY" />
<OpenPosition accountId="U111" currency="USD" assetCategory="STK" symbol="BRK B" description="BERKSHIRE HATHAWAY INC-CL B" listingExchange="NYSE" position="5" costBasisPrice="400" />
<OpenPosition accountId="U111" currency="HKD" assetCategory="STK" symbol="700" description="TENCENT" listingExchange="SEHK" position="200" costBasisPrice="310.4"/>
<OpenPosition accountId="U111" currency="CNH" assetCategory="STK" symbol="600519" description="KWEICHOW MOUTAI-A" listingExchange="SEHKNTL" position="100" costBasisPrice="1650"/>
<OpenPosition accountId="U111" currency="USD" assetCategory="OPT" symbol="AAPL  261120C00200000" description="AAPL 20NOV26 200 C" listingExchange="CBOE" position="1" costBasisPrice="3.1"/>
<OpenPosition accountId="U111" currency="USD" assetCategory="STK" symbol="AAPL" listingExchange="NASDAQ" position="10" costBasisPrice="150.2" levelOfDetail="LOT" />
</OpenPositions>
<CashReport>
<CashReportCurrency accountId="U111" currency="BASE_SUMMARY" endingCash="99999" />
<CashReportCurrency accountId="U111" currency="USD" endingCash="1234.5" />
<CashReportCurrency accountId="U111" currency="HKD" endingCash="800" />
</CashReport>
</FlexStatement>
<FlexStatement accountId="U222" fromDate="20261016" toDate="20261016">
<OpenPositions>
<OpenPosition accountId="U222" currency="USD" assetCategory="STK" symbol="AAPL" description="APPLE INC" listingExchange="NASDAQ" position="30" costBasisPrice="170.2"/>
<OpenPosition accountId="U222" currency="HKD" assetCategory="STK" symbol="338" description="ZhongShan &amp; Co" listingExchange="SEHKSZSE" position="10" costBasisPrice="1"/>
</OpenPositions>
<CashReport>
<CashReportCurrency accountId="U222" currency="USD" endingCash="65.5" />
</CashReport>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

describe("ibkr flex statement parser", () => {
  const r = parseIbkrFlexStatement(FLEX);
  const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
  it("maps NASDAQ / NYSE (BRK B) / SEHK / SEHKNTL / SEHKSZSE", () => {
    expect(Object.keys(by).sort()).toEqual(["hk00700", "sh600519", "sz000338", "usAAPL", "usBRK.B"]);
    expect(by.hk00700).toMatchObject({ quantity: 200, costPrice: 310.4, currency: "HKD", market: "HK", name: "TENCENT" });
    expect(by.sh600519).toMatchObject({ market: "CN", currency: "CNY", costPrice: 1650 });
    expect(by["usBRK.B"]).toMatchObject({ market: "US", quantity: 5 });
    expect(by.sz000338.name).toBe("ZhongShan & Co");
  });
  it("merges multiple FlexStatement blocks and ignores LOT rows", () => {
    expect(by.usAAPL.quantity).toBe(40);
    expect(by.usAAPL.costPrice).toBeCloseTo((150.2 * 10 + 170.2 * 30) / 40);
  });
  it("skips OPT into unsupported", () => {
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0].reason).toMatch(/OPT/);
  });
  it("collects cash, skipping BASE_SUMMARY", () => {
    expect(r.cash).toEqual([{ currency: "USD", amount: 1300 }, { currency: "HKD", amount: 800 }]);
  });
});

describe("fetchIbkrFlex two-step flow", () => {
  const ok = (body) => ({ ok: true, status: 200, text: async () => body });
  const SEND_OK = `<FlexStatementResponse timestamp="x"><Status>Success</Status><ReferenceCode>REF123</ReferenceCode><Url>https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement</Url></FlexStatementResponse>`;
  const PENDING = `<FlexStatementResponse timestamp="x"><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage></FlexStatementResponse>`;

  it("retries while in progress, then parses", async () => {
    const urls = [];
    let n = 0;
    const fake = async (url) => {
      urls.push(url);
      if (url.includes("SendRequest")) return ok(SEND_OK);
      return ok(n++ === 0 ? PENDING : FLEX);
    };
    const r = await fetchIbkrFlex({ token: "TOK", queryId: "999" }, fake, { delayMs: 0 });
    expect(urls[0]).toBe("https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=TOK&q=999&v=3");
    expect(urls[1]).toBe("https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService.GetStatement?t=TOK&q=REF123&v=3");
    expect(urls).toHaveLength(3);
    expect(r.positions).toHaveLength(5);
    expect(r.cash.length).toBe(2);
  });

  it("throws with IBKR error on Fail status", async () => {
    const fake = async () => ok(`<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>`);
    await expect(fetchIbkrFlex({ token: "T", queryId: "1" }, fake, { delayMs: 0 })).rejects.toThrow(/SendRequest failed \(1012\): Token has expired/);
  });

  it("gives up after max tries and surfaces HTTP errors", async () => {
    const pending = async (url) => ok(url.includes("SendRequest") ? SEND_OK : PENDING);
    await expect(fetchIbkrFlex({ token: "T", queryId: "1" }, pending, { delayMs: 0, tries: 3 })).rejects.toThrow(/not ready after 3 tries/);
    const http = async () => ({ ok: false, status: 503, text: async () => "" });
    await expect(fetchIbkrFlex({ token: "T", queryId: "1" }, http, { delayMs: 0 })).rejects.toThrow(/HTTP 503/);
  });
});

/* ---------- CSV ---------- */
describe("csv symbol normalisation", () => {
  const sym = (s, h) => normalizeSymbol(s, h).symbol || null;
  it("accepts tencent / longbridge / yahoo / bare forms", () => {
    expect(sym("usAAPL")).toBe("usAAPL");
    expect(sym("hk00700")).toBe("hk00700");
    expect(sym("sh600519")).toBe("sh600519");
    expect(sym("AAPL.US")).toBe("usAAPL");
    expect(sym("700.HK")).toBe("hk00700");
    expect(sym("0700.HK")).toBe("hk00700");
    expect(sym("600519.SH")).toBe("sh600519");
    expect(sym("600519.SS")).toBe("sh600519");
    expect(sym("000338.SZ")).toBe("sz000338");
    expect(sym("600519")).toBe("sh600519");
    expect(sym("510300")).toBe("sh510300");
    expect(sym("300750")).toBe("sz300750");
    expect(sym("000338")).toBe("sz000338");
    expect(sym("430047")).toBe(null);           // 北交所
    expect(sym("1810", { market: "HK" })).toBe("hk01810");
    expect(sym("1810")).toBe(null);             // 无市场提示 → 歧义
    expect(sym("338", { market: "CN" })).toBe("sz000338");
    expect(sym("TSLA")).toBe("usTSLA");
    expect(sym("BRK B")).toBe("usBRK.B");
    expect(sym("USB")).toBe("usUSB");           // 不误认为腾讯 us 前缀
  });
});

describe("parseHoldingsCsv", () => {
  it("parses an English comma CSV with quoted thousands separators", () => {
    const csv = [
      "Symbol,Name,Quantity,Avg Cost,Currency",
      'AAPL,"Apple, Inc.","1,200",150.5,USD',
      "700.HK,Tencent,300,320,",
      "0700.HK,Tencent,100,340,HKD",
      "SPY 251219C00600000,Option,1,2,USD",
      "MSFT,Microsoft,abc,300,USD",
      ",NoSymbol,5,1,USD",
      "",
    ].join("\n");
    const r = parseHoldingsCsv(csv);
    const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
    expect(by.usAAPL).toMatchObject({ name: "Apple, Inc.", quantity: 1200, costPrice: 150.5, currency: "USD", market: "US" });
    expect(by.hk00700).toMatchObject({ quantity: 400, currency: "HKD", market: "HK" });
    expect(by.hk00700.costPrice).toBeCloseTo(325);
    expect(r.unsupported.map((u) => u.raw)).toEqual(["SPY 251219C00600000"]);
    expect(r.errors).toEqual([
      { line: 6, message: expect.stringMatching(/invalid quantity/) },
      { line: 7, message: "missing symbol" },
    ]);
    expect(r.cash).toEqual([]);
  });

  it("parses a Chinese broker export with BOM + tab delimiter + preamble", () => {
    const tsv = "\uFEFF资金账号:12345\n" + [
      "证券代码\t证券名称\t股票余额\t参考成本价\t币种\t交易市场",
      "600519\t贵州茅台\t200\t1,700.50\t人民币\t沪A",
      "000338\t潍柴动力\t1000\t12.3\t人民币\t深A",
      "1\t平安银行\t500\t10\t人民币\t深A",
      "01810\t小米集团-W\t2000\t15.2\t港币\t港股通",
      "合计\t\t\t\t\t",
    ].join("\r\n");
    const r = parseHoldingsCsv(tsv);
    const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
    expect(Object.keys(by).sort()).toEqual(["hk01810", "sh600519", "sz000001", "sz000338"]);
    expect(by.sh600519).toMatchObject({ name: "贵州茅台", quantity: 200, costPrice: 1700.5, currency: "CNY", market: "CN" });
    expect(by.hk01810).toMatchObject({ currency: "HKD", market: "HK" });
    expect(r.errors).toEqual([]);
  });

  it("detects semicolon delimiter, defaults currency from market, keeps NaN cost", () => {
    const r = parseHoldingsCsv("ticker;qty;market\nusMSFT;3;US\n00005;400;HK\n");
    expect(r.positions[0]).toMatchObject({ symbol: "usMSFT", quantity: 3, currency: "USD" });
    expect(Number.isNaN(r.positions[0].costPrice)).toBe(true);
    expect(r.positions[1]).toMatchObject({ symbol: "hk00005", currency: "HKD", market: "HK" });
  });

  it("reports missing header columns instead of throwing", () => {
    const r = parseHoldingsCsv("foo,bar\n1,2");
    expect(r.positions).toEqual([]);
    expect(r.errors[0].message).toMatch(/header/);
  });
});
