import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { schwabAuthorizeUrl, schwabExchangeCode, parseSchwabAccounts, fetchSchwabAssets } from "../src/brokers/schwab.js";
import { oauthHeader, oauthBaseString, etradeStart, etradeFinish, parseEtradePortfolio, parseEtradeBalance, fetchEtradeAssets } from "../src/brokers/etrade.js";
import { webullHeaders, webullToTencent, parseWebullPositions, parseWebullBalance, parseWebullAccountIds, fetchWebullAssets } from "../src/brokers/webull.js";

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

/* ---------- 录制样例（按各家文档的响应结构，数值有改动） ---------- */
const SCHWAB_ACCOUNTS = [{
  securitiesAccount: {
    type: "MARGIN", accountNumber: "12345678",
    positions: [
      { shortQuantity: 0, averagePrice: 150.25, longQuantity: 10, marketValue: 2300, instrument: { assetType: "EQUITY", cusip: "037833100", symbol: "AAPL", description: "APPLE INC" } },
      { shortQuantity: 0, averagePrice: 400, longQuantity: 5, marketValue: 2600, instrument: { assetType: "COLLECTIVE_INVESTMENT", symbol: "SPY", description: "SPDR S&P 500" } },
      { shortQuantity: 0, averagePrice: 300, longQuantity: 2, marketValue: 900, instrument: { assetType: "EQUITY", symbol: "BRK/B", description: "BERKSHIRE HATHAWAY B" } },
      { shortQuantity: 0, averagePrice: 1, longQuantity: 500, marketValue: 500, instrument: { assetType: "CASH_EQUIVALENT", symbol: "SWVXX" } },
      { shortQuantity: 0, averagePrice: 3.2, longQuantity: 1, marketValue: 250, instrument: { assetType: "OPTION", symbol: "AAPL  261218C00150000" } },
    ],
    currentBalances: { cashBalance: 1234.5, liquidationValue: 9000, longMarketValue: 6000 },
  },
}, {
  securitiesAccount: { type: "CASH", accountNumber: "87654321", positions: [{ longQuantity: 5, shortQuantity: 0, averagePrice: 170, instrument: { assetType: "EQUITY", symbol: "AAPL" } }], currentBalances: { totalCash: 100 } },
}];

const ETRADE_LIST = { AccountListResponse: { Accounts: { Account: [
  { accountId: "84010429", accountIdKey: "JIdOIAcSpwR1Jva7RQBraQ", accountMode: "MARGIN", accountType: "INDIVIDUAL", institutionType: "BROKERAGE", accountStatus: "ACTIVE" },
  { accountId: "84010430", accountIdKey: "closedKey", institutionType: "BROKERAGE", accountStatus: "CLOSED" },
] } } };
const ETRADE_PORTFOLIO = { PortfolioResponse: { AccountPortfolio: [{ accountId: "84010429", totalPages: 1, Position: [
  { positionId: 1, symbolDescription: "MICROSOFT CORP COM", quantity: 10, positionType: "LONG", costPerShare: 300.5, pricePaid: 300.5, marketValue: 4200, Product: { symbol: "MSFT", securityType: "EQ" } },
  { positionId: 2, symbolDescription: "SPDR S&P 500", quantity: 3, positionType: "LONG", costPerShare: 0, pricePaid: 410, Product: { symbol: "SPY", securityType: "EQ" } },
  { positionId: 3, symbolDescription: "MSFT Jan 17 '27 $400 Call", quantity: 1, positionType: "LONG", Product: { symbol: "MSFT", securityType: "OPTN" } },
] }] } };
const ETRADE_BALANCE = { BalanceResponse: { accountId: "84010429", accountType: "MARGIN", Computed: { cashAvailableForInvestment: 900, cashBalance: 1500.75, RealTimeValues: { totalAccountValue: 6000 } } } };

const WEBULL_SUBS = [{ subscription_id: "1", user_id: "u1", account_id: "ACC123", account_number: "5MV00001" }];
const WEBULL_POSITIONS = { holdings: [
  { id: "1", instrument_id: "913256135", symbol: "AAPL", instrument_type: "US_STOCK", short_name: "Apple", currency: "USD", unit_cost: "101.0775", qty: 20, total_cost: "2021.55", last_price: "230", market_value: "4600" },
  { id: "2", instrument_id: "913255891", symbol: "00700", instrument_type: "HK_STOCK", short_name: "腾讯控股", currency: "HKD", unit_cost: "320.5", qty: 100 },
  { id: "3", instrument_id: "999", symbol: "AAPL261218C00150000", instrument_type: "US_OPTION", currency: "USD", unit_cost: "3", qty: 1 },
] };
const WEBULL_BALANCE = { account_id: "ACC123", total_asset_currency: "USD", account_currency_assets: [
  { currency: "USD", total_cash: "1500.5", settled_cash: "1400", unsettled_cash: "100.5", positions_market_value: "4600" },
  { currency: "HKD", cash_balance: "800" },
] };

/* ---------- Schwab ---------- */
describe("schwab", () => {
  it("builds the authorize URL", () => {
    const u = new URL(schwabAuthorizeUrl("KEY", "https://vp.test/api/my/portfolio/oauth/callback", "s1"));
    expect(u.origin + u.pathname).toBe("https://api.schwabapi.com/v1/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: "code", client_id: "KEY", redirect_uri: "https://vp.test/api/my/portfolio/oauth/callback", state: "s1" });
  });

  it("parses equities/ETFs, merges accounts, sweeps cash equivalents into cash, skips options", () => {
    const r = parseSchwabAccounts(SCHWAB_ACCOUNTS);
    const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
    expect(Object.keys(by).sort()).toEqual(["usAAPL", "usBRK.B", "usSPY"]);
    expect(by.usAAPL.quantity).toBe(15);
    expect(by.usAAPL.costPrice).toBeCloseTo((150.25 * 10 + 170 * 5) / 15);
    expect(by.usSPY).toMatchObject({ name: "SPDR S&P 500", currency: "USD", market: "US" });
    expect(r.cash).toEqual([{ currency: "USD", amount: 500 + 1234.5 + 100 }]);
    expect(r.unsupported.map((u) => u.reason)).toEqual(["asset type OPTION"]);
  });

  it("exchanges the code with Basic auth, refreshes an expired access token and returns new creds", async () => {
    const t0 = Date.UTC(2026, 9, 18);
    let seen;
    fetchMock.get("https://api.schwabapi.com").intercept({ path: "/v1/oauth/token", method: "POST" }).reply(200, (o) => {
      seen = { auth: o.headers.authorization || o.headers.Authorization, body: Object.fromEntries(new URLSearchParams(o.body)) };
      return { access_token: "AT1", refresh_token: "RT1", expires_in: 1800, token_type: "Bearer" };
    });
    const creds = await schwabExchangeCode({ appKey: "K", appSecret: "S" }, "C0.b@AA", "https://vp.test/cb", { now: t0 });
    expect(seen.auth).toBe("Basic " + btoa("K:S"));
    expect(seen.body).toEqual({ grant_type: "authorization_code", code: "C0.b@AA", redirect_uri: "https://vp.test/cb" });
    expect(creds).toMatchObject({ accessToken: "AT1", refreshToken: "RT1", accessExpiresAt: t0 + 1800e3, refreshExpiresAt: t0 + 7 * 86400e3 });

    fetchMock.get("https://api.schwabapi.com").intercept({ path: "/v1/oauth/token", method: "POST" }).reply(200, (o) => {
      seen = Object.fromEntries(new URLSearchParams(o.body));
      return { access_token: "AT2", expires_in: 1800 };
    });
    fetchMock.get("https://api.schwabapi.com").intercept({ path: "/trader/v1/accounts?fields=positions", method: "GET" }).reply(200, (o) => {
      expect(o.headers.authorization || o.headers.Authorization).toBe("Bearer AT2");
      return SCHWAB_ACCOUNTS;
    });
    const r = await fetchSchwabAssets(creds, { now: t0 + 3600e3 });
    expect(seen).toEqual({ grant_type: "refresh_token", refresh_token: "RT1" });
    expect(r.positions).toHaveLength(3);
    expect(r.creds).toMatchObject({ accessToken: "AT2", refreshToken: "RT1" });
  });

  it("asks to reconnect when not authorized or the 7-day refresh token is gone", async () => {
    await expect(fetchSchwabAssets({ appKey: "K", appSecret: "S" })).rejects.toThrow(/not authorized yet/);
    await expect(fetchSchwabAssets({ appKey: "K", appSecret: "S", refreshToken: "R", refreshExpiresAt: 1 }, { now: 2 })).rejects.toThrow(/every 7 days/);
    fetchMock.get("https://api.schwabapi.com").intercept({ path: "/v1/oauth/token", method: "POST" }).reply(400, { error: "invalid_grant", error_description: "refresh token expired" });
    await expect(fetchSchwabAssets({ appKey: "K", appSecret: "S", refreshToken: "R" })).rejects.toThrow(/authorization rejected: refresh token expired/);
  });
});

/* ---------- E*TRADE ---------- */
describe("etrade", () => {
  it("signs OAuth 1.0a exactly like the reference example (RFC 5849 / Twitter docs)", async () => {
    const h = await oauthHeader("POST", "https://api.twitter.com/1.1/statuses/update.json",
      { include_entities: "true", status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      { consumerKey: "xvz1evFS4wEEPTGEFPHBog", consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: 1318622958 });
    expect(h).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(oauthBaseString("GET", "https://a.test/x", { b: "2", a: "1 2" })).toBe("GET&https%3A%2F%2Fa.test%2Fx&a%3D1%25202%26b%3D2");
  });

  it("runs the oob flow: request token → authorize URL → verifier → access token", async () => {
    fetchMock.get("https://api.etrade.com").intercept({ path: "/oauth/request_token", method: "GET" }).reply(200, (o) => {
      expect(o.headers.authorization || o.headers.Authorization).toMatch(/oauth_callback="oob"/);
      return "oauth_token=REQ%2Btok&oauth_token_secret=REQSEC&oauth_callback_confirmed=true";
    });
    const s = await etradeStart({ consumerKey: "CK", consumerSecret: "CS" });
    expect(s).toEqual({ url: "https://us.etrade.com/e/t/etws/authorize?key=CK&token=REQ%2Btok", requestToken: "REQ+tok", requestSecret: "REQSEC" });
    fetchMock.get("https://api.etrade.com").intercept({ path: "/oauth/access_token", method: "GET" }).reply(200, (o) => {
      const h = o.headers.authorization || o.headers.Authorization;
      expect(h).toMatch(/oauth_verifier="AB12C"/);
      expect(h).toMatch(/oauth_token="REQ%2Btok"/);
      return "oauth_token=ACC&oauth_token_secret=ACCSEC";
    });
    const c = await etradeFinish({ consumerKey: "CK", consumerSecret: "CS", ...s }, " AB12C ", { now: 5 });
    expect(c).toEqual({ consumerKey: "CK", consumerSecret: "CS", accessToken: "ACC", accessSecret: "ACCSEC", authorizedAt: 5 });
  });

  it("parses portfolio and balance", () => {
    const r = parseEtradePortfolio(ETRADE_PORTFOLIO);
    expect(r.rows).toEqual([
      { symbol: "usMSFT", name: "MICROSOFT CORP COM", quantity: 10, costPrice: 300.5, currency: "USD", market: "US" },
      { symbol: "usSPY", name: "SPDR S&P 500", quantity: 3, costPrice: 410, currency: "USD", market: "US" },
    ]);
    expect(r.unsupported).toEqual([{ raw: "MSFT(OPTN)", reason: "security type OPTN" }]);
    expect(parseEtradeBalance(ETRADE_BALANCE)).toBe(1500.75);
  });

  it("renews, lists active brokerage accounts and pulls portfolio + balance", async () => {
    const api = fetchMock.get("https://api.etrade.com");
    api.intercept({ path: "/oauth/renew_access_token", method: "GET" }).reply(200, "Access Token has been renewed");
    api.intercept({ path: "/v1/accounts/list.json", method: "GET" }).reply(200, ETRADE_LIST);
    api.intercept({ path: (p) => p.startsWith("/v1/accounts/JIdOIAcSpwR1Jva7RQBraQ/portfolio.json?"), method: "GET" }).reply(200, ETRADE_PORTFOLIO);
    api.intercept({ path: "/v1/accounts/JIdOIAcSpwR1Jva7RQBraQ/balance.json?instType=BROKERAGE&realTimeNAV=true", method: "GET" }).reply(200, ETRADE_BALANCE);
    const r = await fetchEtradeAssets({ consumerKey: "CK", consumerSecret: "CS", accessToken: "A", accessSecret: "B" });
    expect(r.positions.map((p) => p.symbol)).toEqual(["usMSFT", "usSPY"]);
    expect(r.cash).toEqual([{ currency: "USD", amount: 1500.75 }]);
  });

  it("asks to reconnect when the token has expired", async () => {
    await expect(fetchEtradeAssets({ consumerKey: "CK", consumerSecret: "CS" })).rejects.toThrow(/not authorized yet/);
    fetchMock.get("https://api.etrade.com").intercept({ path: "/oauth/renew_access_token", method: "GET" }).reply(401, "");
    await expect(fetchEtradeAssets({ consumerKey: "CK", consumerSecret: "CS", accessToken: "A", accessSecret: "B" })).rejects.toThrow(/midnight US Eastern/);
  });
});

/* ---------- Webull ---------- */
describe("webull", () => {
  it("signs like the official SDK (HMAC-SHA1 over the quoted sign string)", async () => {
    const h = await webullHeaders({ appKey: "wb-app-key", appSecret: "wb-secret" }, "api.webull.com", "/account/positions", { account_id: "ACC123", page_size: "100" },
      { now: Date.UTC(2026, 9, 18, 13, 30, 0), nonce: "11111111-2222-3333-4444-555555555555" });
    // 期望值用 webullsdkcore 的 _build_sign_string + sha_hmac1 同样输入算出
    expect(h["x-signature"]).toBe("nSXqDpFWKb+nGaxYNI3SAsy0KG4=");
    expect(h).toMatchObject({ "x-app-key": "wb-app-key", "x-timestamp": "2026-10-18T13:30:00Z", "x-signature-algorithm": "HMAC-SHA1", "x-signature-version": "1.0", "x-version": "v1" });
    expect(h.host).toBeUndefined();
  });

  it("maps instrument types and parses holdings / balances / account ids", () => {
    expect(webullToTencent("BRK B", "US_STOCK")).toEqual({ symbol: "usBRK.B", market: "US" });
    expect(webullToTencent("700", "HK_STOCK")).toEqual({ symbol: "hk00700", market: "HK" });
    expect(webullToTencent("600519", "CN_STOCK")).toEqual({ symbol: "sh600519", market: "CN" });
    expect(webullToTencent("AAPL", "EQUITY", "USD")).toEqual({ symbol: "usAAPL", market: "US" });
    const r = parseWebullPositions(WEBULL_POSITIONS);
    expect(r.rows).toEqual([
      { symbol: "usAAPL", name: "Apple", quantity: 20, costPrice: 101.0775, currency: "USD", market: "US" },
      { symbol: "hk00700", name: "腾讯控股", quantity: 100, costPrice: 320.5, currency: "HKD", market: "HK" },
    ]);
    expect(r.unsupported[0].reason).toMatch(/US_OPTION/);
    expect(parseWebullBalance(WEBULL_BALANCE)).toEqual([["USD", 1500.5], ["HKD", 800]]);
    expect(parseWebullAccountIds(WEBULL_SUBS)).toEqual(["ACC123"]);
    expect(parseWebullAccountIds({ subscriptions: [{ account_id: 7 }] })).toEqual(["7"]);
  });

  it("finds the account, pulls positions + balance from the region host", async () => {
    const api = fetchMock.get("https://api.webull.hk");
    api.intercept({ path: "/app/subscriptions/list", method: "GET" }).reply(200, (o) => {
      const h = o.headers;
      expect(h["x-app-key"]).toBe("K");
      expect(h["x-signature"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
      return WEBULL_SUBS;
    });
    api.intercept({ path: "/account/positions?account_id=ACC123&page_size=100", method: "GET" }).reply(200, WEBULL_POSITIONS);
    api.intercept({ path: "/account/balance?account_id=ACC123", method: "GET" }).reply(200, WEBULL_BALANCE);
    const r = await fetchWebullAssets({ appKey: "K", appSecret: "S", region: "hk" });
    expect(r.positions).toHaveLength(2);
    expect(r.cash).toEqual([{ currency: "USD", amount: 1500.5 }, { currency: "HKD", amount: 800 }]);

    fetchMock.get("https://api.webull.com").intercept({ path: "/account/positions?account_id=X&page_size=100", method: "GET" }).reply(401, { error_code: "INVALID_SIGNATURE", message: "signature mismatch" });
    await expect(fetchWebullAssets({ appKey: "K", appSecret: "S", accountId: "X" })).rejects.toThrow(/webull \/account\/positions: HTTP 401: INVALID_SIGNATURE signature mismatch/);
  });
});

/* ---------- 路由：授权流程 ---------- */
describe("oauth routes", () => {
  let call;
  beforeAll(async () => {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL, mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, valuations TEXT NOT NULL DEFAULT '[]', selected_valuation_id TEXT, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
      `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS broker_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, broker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', cred_enc TEXT, last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', quantity REAL NOT NULL, cost_price REAL, currency TEXT NOT NULL, market TEXT NOT NULL DEFAULT '')`,
      `CREATE TABLE IF NOT EXISTS cash_balances (account_id INTEGER NOT NULL, currency TEXT NOT NULL, amount REAL NOT NULL, PRIMARY KEY (account_id, currency))`,
    ];
    for (const q of ddl) await env.DB.prepare(q).run();
    const J = { "content-type": "application/json" };
    const own = await SELF.fetch("https://vp.test/api/owner/login", { method: "POST", headers: J, body: JSON.stringify({ password: "test-pass" }) });
    const code = (await (await SELF.fetch("https://vp.test/api/owner/codes", { method: "POST", headers: { ...J, cookie: own.headers.get("set-cookie") }, body: JSON.stringify({ count: 1 }) })).json()).created[0];
    const reg = await SELF.fetch("https://vp.test/api/register", { method: "POST", headers: J, body: JSON.stringify({ username: "usbroker", password: "secret1", code }) });
    const cookie = reg.headers.get("set-cookie");
    call = (path, method = "GET", body) => SELF.fetch("https://vp.test" + path, { method, headers: { ...J, cookie }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  });

  it("schwab: create → start returns the authorize URL → callback exchanges the code and syncs", async () => {
    const r = await call("/api/my/portfolio/accounts", "POST", { broker: "schwab", creds: { appKey: "SKEY1234", appSecret: "SSEC" } });
    expect(r.status).toBe(201);
    const { id, sync, needsAuth } = await r.json();
    expect(sync).toBeNull();
    expect(needsAuth).toBe(true);

    const s = await (await call(`/api/my/portfolio/accounts/${id}/oauth/start`, "POST")).json();
    expect(s.verifier).toBe(false);
    expect(s.redirectUri).toBe("https://vp.test/api/my/portfolio/oauth/callback");
    const state = new URL(s.url).searchParams.get("state");
    expect(state).toMatch(/^[0-9a-f]{32}$/);

    const api = fetchMock.get("https://api.schwabapi.com");
    api.intercept({ path: "/v1/oauth/token", method: "POST" }).reply(200, (o) => {
      expect(new URLSearchParams(o.body).get("code")).toBe("C0.x@y");
      return { access_token: "AT", refresh_token: "RT", expires_in: 1800 };
    });
    api.intercept({ path: "/trader/v1/accounts?fields=positions", method: "GET" }).reply(200, SCHWAB_ACCOUNTS);
    const cb = await call(`/api/my/portfolio/oauth/callback?code=${encodeURIComponent("C0.x@y")}&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(`/portfolio?connected=${id}`);
    const { results } = await env.DB.prepare("SELECT symbol FROM holdings WHERE account_id=? ORDER BY symbol").bind(id).all();
    expect(results.map((x) => x.symbol)).toEqual(["usAAPL", "usBRK.B", "usSPY"]);
    const row = await env.DB.prepare("SELECT cred_enc, last_error FROM broker_accounts WHERE id=?").bind(id).first();
    expect(row.last_error).toBeNull();

    const bad = await call(`/api/my/portfolio/oauth/callback?code=x&state=${"0".repeat(32)}`);
    expect(bad.headers.get("location")).toMatch(/oauth_error=/);
  });

  it("etrade: start returns a verifier step, finish exchanges the code and syncs", async () => {
    const { id } = await (await call("/api/my/portfolio/accounts", "POST", { broker: "etrade", name: "ET", creds: { consumerKey: "CK", consumerSecret: "CS" } })).json();
    const api = fetchMock.get("https://api.etrade.com");
    api.intercept({ path: "/oauth/request_token", method: "GET" }).reply(200, "oauth_token=RT&oauth_token_secret=RS&oauth_callback_confirmed=true");
    const s = await (await call(`/api/my/portfolio/accounts/${id}/oauth/start`, "POST")).json();
    expect(s).toMatchObject({ ok: true, verifier: true, url: "https://us.etrade.com/e/t/etws/authorize?key=CK&token=RT" });

    api.intercept({ path: "/oauth/access_token", method: "GET" }).reply(200, "oauth_token=AT&oauth_token_secret=AS");
    api.intercept({ path: "/oauth/renew_access_token", method: "GET" }).reply(200, "ok");
    api.intercept({ path: "/v1/accounts/list.json", method: "GET" }).reply(200, ETRADE_LIST);
    api.intercept({ path: (p) => p.startsWith("/v1/accounts/JIdOIAcSpwR1Jva7RQBraQ/portfolio.json?"), method: "GET" }).reply(200, ETRADE_PORTFOLIO);
    api.intercept({ path: (p) => p.startsWith("/v1/accounts/JIdOIAcSpwR1Jva7RQBraQ/balance.json?"), method: "GET" }).reply(200, ETRADE_BALANCE);
    const f = await (await call(`/api/my/portfolio/accounts/${id}/oauth/finish`, "POST", { verifier: "AB12C" })).json();
    expect(f.sync).toMatchObject({ ok: true, positions: 2, cash: 1, unsupported: 1 });
    expect((await call(`/api/my/portfolio/accounts/${id}/oauth/finish`, "POST", {})).status).toBe(400);
  });

  it("webull: validates the optional region and syncs right away", async () => {
    expect((await call("/api/my/portfolio/accounts", "POST", { broker: "webull", creds: { appKey: "K", appSecret: "S", region: "jp" } })).status).toBe(400);
    const api = fetchMock.get("https://api.webull.com");
    api.intercept({ path: "/account/positions?account_id=ACC9&page_size=100", method: "GET" }).reply(200, WEBULL_POSITIONS);
    api.intercept({ path: "/account/balance?account_id=ACC9", method: "GET" }).reply(200, WEBULL_BALANCE);
    const r = await (await call("/api/my/portfolio/accounts", "POST", { broker: "webull", creds: { appKey: "WKEY5678", appSecret: "S", accountId: "ACC9", region: "US" } })).json();
    expect(r.sync).toMatchObject({ ok: true, positions: 2, cash: 2 });
    const list = await (await call("/api/my/portfolio/accounts")).json();
    expect(list.accounts.find((a) => a.id === r.id)).toMatchObject({ broker: "webull", name: "Webull", credHint: "…5678" });
    expect((await call(`/api/my/portfolio/accounts/${r.id}/oauth/start`, "POST")).status).toBe(400);
  });
});

describe("broker logo proxy", () => {
  it("serves whitelisted broker icons and 404s others", async () => {
    fetchMock.get("https://www.google.com").intercept({ path: "/s2/favicons?domain=schwab.com&sz=128", method: "GET" })
      .reply(200, "PNGDATA", { headers: { "content-type": "image/png" } });
    const r = await SELF.fetch("https://vp.test/api/broker-logo/schwab");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(await r.text()).toBe("PNGDATA");
    expect((await SELF.fetch("https://vp.test/api/broker-logo/evil.com")).status).toBe(404);
  });
});
