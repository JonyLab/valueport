import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { Hono } from "hono";
import encryptionMigration from "../migrations/2026-10-20-portfolio-encryption.sql?raw";
import { encryptJson, decryptJson } from "../src/crypto.js";
import { readHoldings, readCash, readHistory, replaceSnapshot, historyStatement, migratePortfolioBatch, writePlan, readStoredPlan } from "../src/portfolio-storage.js";
import { validateCreds, validateSnapshot, validatePlan, registerPortfolio } from "../src/portfolio.js";

beforeAll(async () => {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL, mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, valuations TEXT NOT NULL DEFAULT '[]', selected_valuation_id TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS broker_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, broker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', cred_enc TEXT, last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', quantity REAL NOT NULL, cost_price REAL, currency TEXT NOT NULL, market TEXT NOT NULL DEFAULT '', data_enc TEXT)`,
    `CREATE TABLE IF NOT EXISTS cash_balances (account_id INTEGER NOT NULL, currency TEXT NOT NULL, amount REAL NOT NULL, data_enc TEXT, PRIMARY KEY (account_id, currency))`,
    `CREATE TABLE IF NOT EXISTS portfolio_plans (user_id INTEGER PRIMARY KEY, plan TEXT NOT NULL, updated_at TEXT NOT NULL, data_enc TEXT)`,
    `CREATE TABLE IF NOT EXISTS portfolio_snapshots (user_id INTEGER NOT NULL, day TEXT NOT NULL, account_id INTEGER NOT NULL, v_usd REAL NOT NULL, v_hkd REAL NOT NULL, v_cny REAL NOT NULL, data_enc TEXT, PRIMARY KEY (user_id, day, account_id))`,
  ];
  for (const q of ddl) await env.DB.prepare(q).run();
  // 不连真实券商：出站请求直接失败，同步错误照常记到账户上
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

const J = { "content-type": "application/json" };
async function userCookie(username) {
  const own = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: J, body: JSON.stringify({ password: "test-pass" }) });
  const ck = own.headers.get("set-cookie");
  const code = (await (await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify({ count: 1 }) })).json()).created[0];
  const r = await SELF.fetch("https://x/api/register", { method: "POST", headers: J, body: JSON.stringify({ username, password: "secret1", code }) });
  return r.headers.get("set-cookie");
}
const call = (cookie, path, method = "GET", body) => SELF.fetch("https://x" + path, { method, headers: { ...J, cookie }, body: body ? JSON.stringify(body) : undefined });

describe("crypto", () => {
  it("round-trips JSON and rejects a wrong key", async () => {
    const k1 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    const k2 = btoa("x".repeat(32));
    const blob = await encryptJson(k1, { appKey: "k", accessToken: "t" });
    expect(blob).not.toContain("appKey");
    expect(await decryptJson(k1, blob)).toEqual({ appKey: "k", accessToken: "t" });
    await expect(decryptJson(k2, blob)).rejects.toThrow();
    await expect(encryptJson("", {})).rejects.toThrow(/CREDENTIALS_KEY/);
  });
});

describe("encrypted financial storage", () => {
  async function fixture(name) {
    const cookie = await userCookie(name);
    const { id } = await (await call(cookie, "/api/my/portfolio/accounts", "POST", { broker: "manual" })).json();
    const { user_id: uid } = await env.DB.prepare("SELECT user_id FROM broker_accounts WHERE id=?").bind(id).first();
    return { cookie, id, uid };
  }
  const snap = { positions: [{ symbol: "usAAPL", name: "Apple", quantity: 123.45, costPrice: 178.9, currency: "USD" }], cash: [{ currency: "USD", amount: 9876.54 }] };
  it("adds encryption columns to the legacy schema without clearing existing data", async () => {
    const { uid, id } = await fixture("enc_schema");
    for (const table of ["holdings", "cash_balances", "portfolio_snapshots", "portfolio_plans"]) {
      await env.DB.prepare(`ALTER TABLE ${table} DROP COLUMN data_enc`).run();
    }
    await env.DB.prepare("INSERT INTO holdings (account_id,symbol,quantity,currency) VALUES (?,'usAAPL',12,'USD')").bind(id).run();
    for (const sql of encryptionMigration.replace(/--[^\n]*/g, "").split(";").filter((s) => s.trim())) await env.DB.prepare(sql).run();
    const row = await env.DB.prepare("SELECT symbol,quantity,data_enc FROM holdings WHERE account_id=?").bind(id).first();
    expect(row).toEqual({ symbol: "usAAPL", quantity: 12, data_enc: null });
    await migratePortfolioBatch(env);
    expect((await readHoldings(env, uid))[0]).toMatchObject({ symbol: "usAAPL", quantity: 12 });
  });
  it("stores no holding, cost, cash, history amounts or target weights in plaintext", async () => {
    const { uid, id } = await fixture("enc_storage");
    await replaceSnapshot(env, uid, id, snap);
    const h = await env.DB.prepare("SELECT * FROM holdings WHERE account_id=?").bind(id).first();
    const c = await env.DB.prepare("SELECT * FROM cash_balances WHERE account_id=?").bind(id).first();
    expect(h).toMatchObject({ symbol: "", name: "", quantity: 0, cost_price: null, currency: "", market: "" });
    expect(c.amount).toBe(0); expect(c.currency).toMatch(/^enc:/);
    expect(JSON.stringify([h, c])).not.toMatch(/Apple|usAAPL|123\.45|178\.9|9876\.54|USD/);
    expect((await readHoldings(env, uid, id))[0]).toMatchObject({ symbol: "usAAPL", quantity: 123.45, cost_price: 178.9 });
    expect((await readCash(env, uid, id))[0]).toMatchObject({ currency: "USD", amount: 9876.54 });
    const day = "2026-10-19", value = { USD: 1234, HKD: 9625, CNY: 8761 };
    await (await historyStatement(env, uid, day, id, value)).run();
    expect(await env.DB.prepare("SELECT v_usd,v_hkd,v_cny FROM portfolio_snapshots WHERE user_id=?").bind(uid).first()).toEqual({ v_usd: 0, v_hkd: 0, v_cny: 0 });
    expect(await readHistory(env, uid, "2026-01-01")).toEqual([{ day, accountId: id, ...value }]);
    await writePlan(env, uid, { targets: { usAAPL: 30 }, cash: 10 });
    expect((await env.DB.prepare("SELECT plan FROM portfolio_plans WHERE user_id=?").bind(uid).first()).plan).toBe("{}");
    expect(await readStoredPlan(env, uid)).toEqual({ targets: { usAAPL: 30 }, cash: 10 });
  });
  it("fails closed for missing/wrong keys or swapped ciphertext without deleting existing data", async () => {
    const a = await fixture("enc_owner"), b = await fixture("enc_other");
    await replaceSnapshot(env, a.uid, a.id, snap);
    const wrong = { ...env, CREDENTIALS_KEY: btoa("x".repeat(32)) };
    await expect(readHoldings(wrong, a.uid)).rejects.toThrow("portfolio_storage_unavailable");
    await expect(replaceSnapshot({ ...env, CREDENTIALS_KEY: "" }, a.uid, a.id, { positions: [], cash: [] })).rejects.toThrow("portfolio_storage_unavailable");
    expect((await readHoldings(env, a.uid))[0].quantity).toBe(123.45);
    const { data_enc } = await env.DB.prepare("SELECT data_enc FROM holdings WHERE account_id=?").bind(a.id).first();
    await env.DB.prepare("INSERT INTO holdings (account_id,symbol,quantity,currency,data_enc) VALUES (?,'',0,'',?)").bind(b.id, data_enc).run();
    expect(await readHoldings(env, a.uid, b.id)).toEqual([]);
    expect((await call(b.cookie, "/api/my/portfolio?base=USD")).status).toBe(503);
    await env.DB.prepare("UPDATE holdings SET data_enc='' WHERE account_id=?").bind(b.id).run();
    await expect(readHoldings(env, b.uid)).rejects.toThrow("portfolio_storage_unavailable");
  });
  it("backfills legacy data in bounded repeatable batches and preserves values", async () => {
    const { uid, id, cookie } = await fixture("enc_legacy");
    await env.DB.prepare("INSERT INTO holdings (account_id,symbol,name,quantity,cost_price,currency) VALUES (?,'hk00700','Tencent',200,300,'HKD')").bind(id).run();
    await env.DB.prepare("INSERT INTO cash_balances (account_id,currency,amount) VALUES (?,'HKD',4567)").bind(id).run();
    await env.DB.prepare("INSERT INTO portfolio_snapshots (user_id,day,account_id,v_usd,v_hkd,v_cny) VALUES (?,'2026-10-18',?,100,780,710)").bind(uid, id).run();
    await env.DB.prepare("INSERT INTO portfolio_plans (user_id,plan,updated_at) VALUES (?,'{\"targets\":{\"hk00700\":25}}','now')").bind(uid).run();
    expect((await call(cookie, "/api/owner/portfolio/encrypt", "POST", {})).status).toBe(401);
    await expect(migratePortfolioBatch({ ...env, CREDENTIALS_KEY: "" })).rejects.toThrow();
    expect((await env.DB.prepare("SELECT quantity FROM holdings WHERE account_id=?").bind(id).first()).quantity).toBe(200);
    let result, batches = 0;
    do { result = await migratePortfolioBatch(env, 1); expect(result.migrated).toBeLessThanOrEqual(1); batches++; } while (!result.done && batches < 30);
    expect(result.done).toBe(true);
    expect((await readHoldings(env, uid))[0]).toMatchObject({ symbol: "hk00700", quantity: 200, cost_price: 300 });
    expect((await readCash(env, uid))[0].amount).toBe(4567);
    expect((await readHistory(env, uid, "2026-01-01"))[0]).toMatchObject({ USD: 100, HKD: 780, CNY: 710 });
    expect(await readStoredPlan(env, uid)).toEqual({ targets: { hk00700: 25 } });
    expect(await migratePortfolioBatch(env)).toEqual({ migrated: 0, remaining: 0, done: true });
    expect((await env.DB.prepare("SELECT symbol,quantity,cost_price FROM holdings WHERE account_id=?").bind(id).first())).toEqual({ symbol: "", quantity: 0, cost_price: null });
  });
  it("records encrypted daily values and refuses to overwrite history when decryption fails", async () => {
    const { uid, id } = await fixture("enc_daily");
    await replaceSnapshot(env, uid, id, snap);
    fetchMock.get("https://api.frankfurter.app").intercept({ path: "/latest?from=USD&to=HKD%2CCNY" }).reply(200, { rates: { HKD: 7.8, CNY: 7.1 } });
    const service = registerPortfolio(new Hono(), { adapters: {}, getQuotes: async () => ({ quotes: { usAAPL: 200 } }) });
    await service.recordSnapshot(env, uid);
    const rows = (await env.DB.prepare("SELECT * FROM portfolio_snapshots WHERE user_id=?").bind(uid).all()).results;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ v_usd: 0, v_hkd: 0, v_cny: 0, data_enc: expect.stringMatching(/^v1:/) });
    const points = await readHistory(env, uid, "2000-01-01");
    expect(points.find((p) => p.accountId === 0).USD).toBeCloseTo(123.45 * 200 + 9876.54);
    await expect(service.recordSnapshot({ ...env, CREDENTIALS_KEY: btoa("z".repeat(32)) }, uid)).rejects.toThrow("portfolio_storage_unavailable");
    expect((await env.DB.prepare("SELECT * FROM portfolio_snapshots WHERE user_id=?").bind(uid).all()).results).toEqual(rows);
  });
});

describe("validators", () => {
  it("requires every credential field per broker", () => {
    expect(validateCreds("longbridge", { appKey: "a", appSecret: "b" }).ok).toBe(false);
    expect(validateCreds("ibkr", { token: " t ", queryId: "1" })).toEqual({ ok: true, value: { token: "t", queryId: "1" } });
    expect(validateCreds("manual", undefined)).toEqual({ ok: true, value: null });
  });
  it("cleans positions and reports bad rows", () => {
    const v = validateSnapshot({ positions: [{ symbol: "usAAPL", quantity: "10", costPrice: "", currency: "usd" }, { symbol: "AAPL", quantity: 1, currency: "USD" }, { symbol: "hk00700", quantity: 0, currency: "HKD" }], cash: [{ currency: "hkd", amount: "5" }] });
    expect(v.positions).toEqual([{ symbol: "usAAPL", name: "", quantity: 10, costPrice: null, currency: "USD", market: "" }]);
    expect(v.cash).toEqual([{ currency: "HKD", amount: 5 }]);
    expect(v.errors.length).toBe(2);
  });
});

describe("portfolio routes", () => {
  it("requires a session", async () => {
    expect((await SELF.fetch("https://x/api/my/portfolio")).status).toBe(401);
  });
  it("never returns stored credentials and keeps users isolated", async () => {
    const a = await userCookie("pf_alice"), b = await userCookie("pf_bob");
    // 长桥凭证随便填：创建会成功（加密入库），随后同步失败，错误记在账户上
    const r = await call(a, "/api/my/portfolio/accounts", "POST", { broker: "longbridge", name: "LB", creds: { appKey: "AKEY1234", appSecret: "S", accessToken: "T" } });
    expect(r.status).toBe(201);
    const { id } = await r.json();
    const list = await (await call(a, "/api/my/portfolio/accounts")).json();
    expect(JSON.stringify(list)).not.toMatch(/AKEY1234|"S"|"T"/);
    expect(list.accounts[0]).toMatchObject({ id, broker: "longbridge", hasCreds: true, credHint: "…1234" });
    const row = await env.DB.prepare("SELECT cred_enc FROM broker_accounts WHERE id=?").bind(id).first();
    expect(row.cred_enc).not.toContain("AKEY1234");
    // bob 看不到、改不了、删不掉 alice 的账户
    expect((await (await call(b, "/api/my/portfolio/accounts")).json()).accounts).toEqual([]);
    expect((await call(b, `/api/my/portfolio/accounts/${id}`, "DELETE")).status).toBe(404);
    expect((await call(b, `/api/my/portfolio/accounts/${id}/sync`, "POST")).status).toBe(404);
  });
  it("edits manual holdings and returns them in the summary", async () => {
    const c = await userCookie("pf_carol");
    const { id } = await (await call(c, "/api/my/portfolio/accounts", "POST", { broker: "manual", name: "A股" })).json();
    expect((await call(c, `/api/my/portfolio/accounts/${id}/holdings`, "PUT", { positions: [{ symbol: "AAPL", quantity: 1, currency: "USD" }] })).status).toBe(400);
    const ok = await call(c, `/api/my/portfolio/accounts/${id}/holdings`, "PUT", { positions: [{ symbol: "sh600519", name: "贵州茅台", quantity: 100, costPrice: 1500, currency: "CNY" }], cash: [{ currency: "CNY", amount: 1000 }, { currency: "CNY", amount: 500 }] });
    expect(ok.status).toBe(200);
    const imp = await call(c, `/api/my/portfolio/accounts/${id}/import`, "POST", { text: "证券代码,证券名称,股票余额,成本价\n000338,潍柴动力,3000,15.2\n" });
    expect((await imp.json()).imported).toBe(1);
    const uid = (await env.DB.prepare("SELECT user_id FROM broker_accounts WHERE id=?").bind(id).first()).user_id;
    const rows = (await readHoldings(env, uid, id)).map((r) => r.symbol);
    expect(rows).toEqual(["sz000338"]); // 导入整体替换持仓
    const cash = (await readCash(env, uid, id)).map(({ amount }) => ({ amount }));
    expect(cash).toEqual([{ amount: 1500 }]); // 同币种合并，且导入不动现金
    // 只有 manual 账户能手动改持仓
    const { id: lb } = await (await call(c, "/api/my/portfolio/accounts", "POST", { broker: "ibkr", creds: { token: "t", queryId: "q" } })).json();
    expect((await call(c, `/api/my/portfolio/accounts/${lb}/holdings`, "PUT", { positions: [] })).status).toBe(400);
  });
  it("rejects unknown brokers and missing credentials", async () => {
    const d = await userCookie("pf_dave");
    expect((await call(d, "/api/my/portfolio/accounts", "POST", { broker: "robinhood" })).status).toBe(400);
    expect((await call(d, "/api/my/portfolio/accounts", "POST", { broker: "longbridge", creds: { appKey: "x" } })).status).toBe(400);
  });
});

describe("portfolio history", () => {
  it("returns only the caller's snapshots, oldest first, within the window", async () => {
    const e = await userCookie("pf_erin"), f = await userCookie("pf_frank");
    const uid = async (ck) => (await (await call(ck, "/api/me")).json()).username === "pf_erin"
      ? (await env.DB.prepare("SELECT id FROM users WHERE username='pf_erin'").first()).id
      : (await env.DB.prepare("SELECT id FROM users WHERE username='pf_frank'").first()).id;
    const ue = await uid(e), uf = await uid(f);
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const ins = (u, d, a, v) => env.DB.prepare("INSERT INTO portfolio_snapshots (user_id,day,account_id,v_usd,v_hkd,v_cny) VALUES (?,?,?,?,?,?)").bind(u, d, a, v, v * 7.8, v * 7.1).run();
    await ins(ue, day(2), 0, 100); await ins(ue, day(1), 0, 110); await ins(ue, day(1), 5, 60); await ins(ue, day(400), 0, 50); await ins(uf, day(1), 0, 999);
    const pts = (await (await call(e, "/api/my/portfolio/history?days=30")).json()).points;
    expect(pts.map((p) => [p.day, p.accountId, p.USD])).toEqual([[day(2), 0, 100], [day(1), 0, 110], [day(1), 5, 60]]);
    expect(pts[1].HKD).toBeCloseTo(858);
    expect((await call(f, "/api/my/portfolio/history")).status).toBe(200);
    expect((await (await call(f, "/api/my/portfolio/history")).json()).points.map((p) => p.USD)).toEqual([999]);
  });
});

describe("target allocation plan", () => {
  it("validates targets, cash and tolerance bands", () => {
    expect(validatePlan({ targets: { usAAPL: 20, hk00700: "15.5", sh600519: 0 }, cash: 10 }).plan)
      .toEqual({ targets: { usAAPL: 20, hk00700: 15.5 }, cash: 10, band: 5, rel: 25 });
    expect(validatePlan({ targets: { AAPL: 10 } }).error).toMatch(/symbol/);
    expect(validatePlan({ targets: { usAAPL: 70, usMSFT: 40 } }).error).toMatch(/100/);
    expect(validatePlan({ targets: { usAAPL: 95 }, cash: 10 }).error).toMatch(/100/);
    expect(validatePlan({ targets: {}, band: 0 }).error).toMatch(/band/);
    expect(validatePlan({ targets: [] }).error).toBeTruthy();
  });
  it("saves per user and comes back with the portfolio summary", async () => {
    const a = await userCookie("plan_alice"), b = await userCookie("plan_bob");
    expect((await (await call(a, "/api/my/portfolio/plan")).json()).plan).toEqual({ targets: {}, cash: null, band: 5, rel: 25 });
    expect((await call(a, "/api/my/portfolio/plan", "PUT", { targets: { usAAPL: 120 } })).status).toBe(400);
    const r = await call(a, "/api/my/portfolio/plan", "PUT", { targets: { usAAPL: 30 }, cash: 15, band: 4, rel: 20 });
    expect(r.status).toBe(200);
    expect((await (await call(a, "/api/my/portfolio/plan")).json()).plan).toEqual({ targets: { usAAPL: 30 }, cash: 15, band: 4, rel: 20 });
    expect((await (await call(b, "/api/my/portfolio/plan")).json()).plan.targets).toEqual({});
    await call(a, "/api/my/portfolio/accounts", "POST", { broker: "manual", name: "M" });
    const sum = await (await call(a, "/api/my/portfolio?base=USD")).json();
    expect(sum.plan).toEqual({ targets: { usAAPL: 30 }, cash: 15, band: 4, rel: 20 });
  });
});

describe("user settings", () => {
  it("keeps only the valuation defaults, validated", async () => {
    const ck = await userCookie("set_amy");
    const put = (body) => call(ck, "/api/my/settings", "PUT", body);
    const r = await put({ default_mos: "30", default_ext: 60, eyebrow: "hello", color_deep: "#000000" });
    expect(r.status).toBe(200);
    expect((await r.json()).settings).toEqual({ default_mos: "30", default_ext: "60" }); // 文案 / 配色不再保存
    expect((await put({ default_mos: 120 })).status).toBe(400);
    expect((await put({ default_ext: "abc" })).status).toBe(400);
    expect((await (await put({ default_mos: "" })).json()).settings).toEqual({ default_ext: "60" }); // 清空 = 恢复默认
  });
});

describe("held stocks join the watchlist", () => {
  it("adds missing holdings to the user's items once, with their defaults", async () => {
    const ck = await userCookie("board_ann"), other = await userCookie("board_ben");
    await call(ck, "/api/my/settings", "PUT", { default_mos: 30, default_ext: 60 });
    await call(ck, "/api/my/items", "POST", { ticker: "00700", name: "腾讯", symbol: "hk00700", fairLow: 400, fairHigh: 500, mos: 50, ext: 40 });
    const { id } = await (await call(ck, "/api/my/portfolio/accounts", "POST", { broker: "manual", name: "M" })).json();
    const r = await call(ck, `/api/my/portfolio/accounts/${id}/holdings`, "PUT", { positions: [
      { symbol: "hk00700", name: "腾讯控股", quantity: 100, currency: "HKD" },
      { symbol: "sh600519", name: "贵州茅台", quantity: 10, currency: "CNY" },
    ], cash: [] });
    expect(r.status).toBe(200);
    const items = (await (await call(ck, "/api/my/items")).json()).items;
    expect(items.map((i) => i.symbol).sort()).toEqual(["hk00700", "sh600519"]);
    expect(items.find((i) => i.symbol === "sh600519")).toMatchObject({ ticker: "600519", name: "贵州茅台", fairLow: 0, mos: 30, ext: 60 });
    await call(ck, "/api/my/portfolio?base=USD"); // 再读一次不会重复添加
    expect((await (await call(ck, "/api/my/items")).json()).items.length).toBe(2);
    expect((await (await call(other, "/api/my/items")).json()).items).toEqual([]);
  });
});
