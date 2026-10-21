import { readHoldings } from "../src/portfolio-storage.js";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import KEY from "./fixtures/tiger-key.json";
import {
  privateKeyToPkcs8, signContent, signParams, tigerTimestamp, tigerToTencent,
  parseTigerPositions, parseTigerPrimeAssets, parseTigerAssets, fetchTigerAssets, TIGER_GATEWAY,
} from "../src/brokers/tiger.js";

const GW = new URL(TIGER_GATEWAY);
const CREDS = { tigerId: "20150001", account: "20190001", privateKey: KEY.pkcs1Pem };

// 录制自官方 SDK 测试用例的响应形状（数值有改动）
const POSITIONS = {
  code: 0, message: "success", timestamp: 1755074116661,
  data: {
    items: [
      { symbol: "NVDA", market: "US", secType: "STK", account: "20190001", position: 773, positionScale: 5, positionQty: 0.00773, averageCost: 129.45, currency: "USD", latestPrice: 183.52, identifier: "NVDA" },
      { symbol: "AAPL", market: "US", secType: "STK", account: "20190001", position: 10, positionScale: 0, averageCost: 150, currency: "USD", name: "Apple" },
      { symbol: "00700", market: "HK", secType: "STK", account: "20190001", position: 200, positionScale: 0, positionQty: 200, averageCost: 320.5, currency: "HKD", name: "腾讯控股" },
      { symbol: "600519", market: "CN", secType: "STK", position: 100, positionQty: 100, averageCost: 1700.25, currency: "CNH" },
      { symbol: "000858", market: "CN", secType: "STK", position: 300, positionQty: 300, averageCost: 130, currency: "CNH" },
      { symbol: "AAPL", market: "US", secType: "OPT", position: 1, averageCost: 5, currency: "USD", expiry: "20261218", strike: "150", right: "CALL" },
      { symbol: "D05", market: "SG", secType: "STK", position: 10, averageCost: 30, currency: "SGD" },
      { symbol: "AAPL", market: "US", secType: "STK", position: 10, positionScale: 0, averageCost: 170, currency: "USD" },
    ],
  },
};
const PRIME_ASSETS = {
  code: 0, message: "success", timestamp: 1755078296228,
  data: {
    accountId: "20190001",
    segments: [
      { category: "S", currency: "USD", cashBalance: 7198.59, currencyAssets: [
        { currency: "USD", cashBalance: 6302.06, cashAvailableForTrade: 5320.17 },
        { currency: "HKD", cashBalance: 5800.29, cashAvailableForTrade: 5800.29 },
        { currency: "CNH", cashBalance: 1123.95, cashAvailableForTrade: 1123.95 },
      ] },
      { category: "C", currency: "USD", cashBalance: 100, currencyAssets: [{ currency: "USD", cashBalance: 100 }] },
    ],
  },
};

function b64ToBytes(b64) { const s = atob(b64); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
async function verify(content, sigB64) {
  const pub = await crypto.subtle.importKey("spki", b64ToBytes(KEY.spkiBase64), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, b64ToBytes(sigB64), new TextEncoder().encode(content));
}

describe("tiger signing", () => {
  it("wraps PKCS#1 into the same PKCS#8 openssl produces, and leaves PKCS#8 alone", () => {
    const fromPk1 = privateKeyToPkcs8(KEY.pkcs1Pem);
    expect(btoa(String.fromCharCode(...fromPk1))).toBe(KEY.pkcs8Base64);
    expect(btoa(String.fromCharCode(...privateKeyToPkcs8(KEY.pkcs8Base64)))).toBe(KEY.pkcs8Base64);
    // 裸 base64（没有 PEM 头尾、换行被拼掉）也行
    const bare = KEY.pkcs1Pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
    expect(btoa(String.fromCharCode(...privateKeyToPkcs8(bare)))).toBe(KEY.pkcs8Base64);
    expect(() => privateKeyToPkcs8("")).toThrow(/empty private key/);
    expect(() => privateKeyToPkcs8("aGVsbG8gd29ybGQ=")).toThrow(/unrecognised/);
  });

  it("builds the sorted sign string and matches an openssl SHA1withRSA signature", async () => {
    const params = {
      tiger_id: "20150001", method: "positions", charset: "UTF-8", sign_type: "RSA", timestamp: "2026-10-18 21:30:00", version: "2.0",
      biz_content: '{"account":"20190001","currency":"ALL","market":"ALL","sec_type":"STK"}',
    };
    expect(signContent(params)).toBe(KEY.signContent);
    expect(await signParams(params, KEY.pkcs1Pem)).toBe(KEY.opensslSignature);
    expect(await signParams(params, KEY.pkcs8Base64)).toBe(KEY.opensslSignature);
  });

  it("formats the timestamp in UTC+8", () => {
    expect(tigerTimestamp(Date.UTC(2026, 9, 18, 13, 30, 0))).toBe("2026-10-18 21:30:00");
  });
});

describe("tiger parsers", () => {
  it("maps symbols to tencent format", () => {
    expect(tigerToTencent("BRK B", "US")).toEqual({ symbol: "usBRK.B", market: "US" });
    expect(tigerToTencent("700", "HK")).toEqual({ symbol: "hk00700", market: "HK" });
    expect(tigerToTencent("510300", "CN")).toEqual({ symbol: "sh510300", market: "CN" });
    expect(tigerToTencent("300750", "CN")).toEqual({ symbol: "sz300750", market: "CN" });
    expect(tigerToTencent("830799", "CN").reason).toMatch(/board/);
    expect(tigerToTencent("D05", "SG").reason).toMatch(/unsupported market/);
  });

  it("parses positions: fractional qty, merge, CNH→CNY, skips options and SG", () => {
    const r = parseTigerPositions(POSITIONS.data);
    const by = Object.fromEntries(r.positions.map((p) => [p.symbol, p]));
    expect(Object.keys(by).sort()).toEqual(["hk00700", "sh600519", "sz000858", "usAAPL", "usNVDA"]);
    expect(by.usNVDA).toMatchObject({ quantity: 0.00773, costPrice: 129.45, currency: "USD", market: "US" });
    expect(by.usAAPL.quantity).toBe(20);
    expect(by.usAAPL.costPrice).toBeCloseTo(160);
    expect(by.usAAPL.name).toBe("Apple");
    expect(by.hk00700).toMatchObject({ name: "腾讯控股", quantity: 200, costPrice: 320.5, currency: "HKD", market: "HK" });
    expect(by.sh600519).toMatchObject({ quantity: 100, currency: "CNY", market: "CN" });
    expect(r.unsupported.map((u) => u.raw)).toEqual(["AAPL@US(OPT)", "D05@SG(STK)"]);
  });

  it("falls back to position / 10^positionScale when positionQty is missing", () => {
    const r = parseTigerPositions({ items: [{ symbol: "TSLA", market: "US", secType: "STK", position: 1500, positionScale: 3, averageCost: 200, currency: "USD" }] });
    expect(r.positions[0].quantity).toBe(1.5);
  });

  it("sums cash per currency from prime_assets and legacy assets", () => {
    expect(parseTigerPrimeAssets(PRIME_ASSETS.data)).toEqual([
      { currency: "USD", amount: 6402.06 }, { currency: "HKD", amount: 5800.29 }, { currency: "CNY", amount: 1123.95 },
    ]);
    expect(parseTigerPrimeAssets({ segments: [{ category: "S", currency: "HKD", cashBalance: 12 }] })).toEqual([{ currency: "HKD", amount: 12 }]);
    expect(parseTigerAssets({ items: [{ account: "U1", currency: "USD", cashValue: 9, marketValues: [{ currency: "USD", cashBalance: 5 }, { currency: "HKD", cashBalance: 7 }] }] }))
      .toEqual([{ currency: "USD", amount: 5 }, { currency: "HKD", amount: 7 }]);
    expect(parseTigerAssets({ items: [{ account: "U1", currency: "USD", cashValue: 9 }] })).toEqual([{ currency: "USD", amount: 9 }]);
  });
});

describe("fetchTigerAssets", () => {
  beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  // 拦截网关请求：按 method 回包，并校验签名
  function mockGateway(replies, seen) {
    for (let i = 0; i < Object.keys(replies).length; i++) {
      fetchMock.get(GW.origin).intercept({ path: GW.pathname, method: "POST" }).reply(200, async (opts) => {
        const body = JSON.parse(opts.body);
        const { sign, ...rest } = body;
        seen.push({ body, headers: opts.headers, valid: await verify(signContent(rest), sign) });
        return replies[body.method];
      });
    }
  }

  it("signs positions + prime_assets and returns the snapshot", async () => {
    const seen = [];
    mockGateway({ positions: POSITIONS, prime_assets: PRIME_ASSETS }, seen);
    const r = await fetchTigerAssets(CREDS, { now: Date.UTC(2026, 9, 18, 13, 30, 0) });
    expect(seen.map((s) => s.body.method).sort()).toEqual(["positions", "prime_assets"]);
    for (const s of seen) {
      expect(s.valid).toBe(true);
      expect(s.body).toMatchObject({ tiger_id: "20150001", charset: "UTF-8", sign_type: "RSA", version: "2.0", timestamp: "2026-10-18 21:30:00" });
      expect(JSON.stringify(s.body)).not.toContain("PRIVATE KEY");
    }
    expect(JSON.parse(seen.find((s) => s.body.method === "positions").body.biz_content)).toEqual({ account: "20190001", currency: "ALL", market: "ALL", sec_type: "STK" });
    expect(r.positions).toHaveLength(5);
    expect(r.cash).toHaveLength(3);
    expect(r.unsupported).toHaveLength(2);
  });

  it("falls back to legacy assets when prime_assets is rejected, and sends the optional token", async () => {
    const seen = [];
    mockGateway({
      positions: { code: 0, data: JSON.stringify({ items: [] }) }, // data 也可能是字符串
      prime_assets: { code: 1010, message: "not a prime account" },
      assets: { code: 0, data: { items: [{ account: "U1", currency: "USD", marketValues: [{ currency: "USD", cashBalance: 42 }] }] } },
    }, seen);
    const r = await fetchTigerAssets({ ...CREDS, token: "tok" });
    expect(r).toEqual({ positions: [], cash: [{ currency: "USD", amount: 42 }], unsupported: [] });
    expect(seen.every((s) => s.headers.authorization === "tok" || s.headers.Authorization === "tok")).toBe(true);
  });

  it("surfaces gateway errors and missing credentials", async () => {
    mockGateway({
      positions: { code: 40001, message: "sign check failed" },
      prime_assets: { code: 0, data: { segments: [] } },
    }, []);
    await expect(fetchTigerAssets(CREDS)).rejects.toThrow(/tiger positions: code 40001 sign check failed/);
    await expect(fetchTigerAssets({ tigerId: "1", account: "2" })).rejects.toThrow(/missing credentials/);
    await expect(fetchTigerAssets({ ...CREDS, privateKey: "bm90IGEga2V5" })).rejects.toThrow(/tiger: unrecognised private key format/);
  });
});

describe("tiger account route", () => {
  it("validates tiger creds, stores them encrypted and syncs through the gateway", async () => {
    const ddl = [
      `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL, mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, valuations TEXT NOT NULL DEFAULT '[]', selected_valuation_id TEXT, updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
      `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS broker_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, broker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', cred_enc TEXT, last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', quantity REAL NOT NULL, cost_price REAL, currency TEXT NOT NULL, market TEXT NOT NULL DEFAULT '', data_enc TEXT)`,
      `CREATE TABLE IF NOT EXISTS cash_balances (account_id INTEGER NOT NULL, currency TEXT NOT NULL, amount REAL NOT NULL, data_enc TEXT, PRIMARY KEY (account_id, currency))`,
    ];
    for (const q of ddl) await env.DB.prepare(q).run();
    const J = { "content-type": "application/json" };
    const own = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: J, body: JSON.stringify({ password: "test-pass" }) });
    const code = (await (await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { ...J, cookie: own.headers.get("set-cookie") }, body: JSON.stringify({ count: 1 }) })).json()).created[0];
    const reg = await SELF.fetch("https://x/api/register", { method: "POST", headers: J, body: JSON.stringify({ username: "tigeruser", password: "secret1", code }) });
    const cookie = reg.headers.get("set-cookie");
    const call = (path, method = "GET", body) => SELF.fetch("https://x" + path, { method, headers: { ...J, cookie }, body: body ? JSON.stringify(body) : undefined });

    expect((await call("/api/my/portfolio/accounts", "POST", { broker: "tiger", creds: { tigerId: "1", account: "2" } })).status).toBe(400);

    for (const reply of [POSITIONS, PRIME_ASSETS]) {
      fetchMock.get(GW.origin).intercept({ path: GW.pathname, method: "POST" }).reply(200, (opts) => JSON.parse(opts.body).method === "positions" ? POSITIONS : PRIME_ASSETS);
    }
    const r = await call("/api/my/portfolio/accounts", "POST", { broker: "tiger", creds: CREDS });
    expect(r.status).toBe(201);
    const { id, sync } = await r.json();
    expect(sync).toMatchObject({ ok: true, positions: 5, cash: 3, unsupported: 2 });

    const row = await env.DB.prepare("SELECT name, cred_enc FROM broker_accounts WHERE id=?").bind(id).first();
    expect(row.name).toBe("Tiger");
    expect(row.cred_enc).not.toContain("PRIVATE");
    const list = await (await call("/api/my/portfolio/accounts")).json();
    expect(list.accounts.find((a) => a.id === id)).toMatchObject({ broker: "tiger", hasCreds: true, credHint: "…0001" });
    const uid = (await env.DB.prepare("SELECT user_id FROM broker_accounts WHERE id=?").bind(id).first()).user_id;
    const results = (await readHoldings(env, uid, id)).sort((a, b) => a.symbol.localeCompare(b.symbol));
    expect(results.map((h) => h.symbol)).toEqual(["hk00700", "sh600519", "sz000858", "usAAPL", "usNVDA"]);
  });
});
