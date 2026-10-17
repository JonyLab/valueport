import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { encryptJson, decryptJson } from "../src/crypto.js";
import { validateCreds, validateSnapshot } from "../src/portfolio.js";

beforeAll(async () => {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL, mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, valuations TEXT NOT NULL DEFAULT '[]', selected_valuation_id TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS broker_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, broker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', cred_enc TEXT, last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', quantity REAL NOT NULL, cost_price REAL, currency TEXT NOT NULL, market TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS cash_balances (account_id INTEGER NOT NULL, currency TEXT NOT NULL, amount REAL NOT NULL, PRIMARY KEY (account_id, currency))`,
    `CREATE TABLE IF NOT EXISTS portfolio_snapshots (user_id INTEGER NOT NULL, day TEXT NOT NULL, account_id INTEGER NOT NULL, v_usd REAL NOT NULL, v_hkd REAL NOT NULL, v_cny REAL NOT NULL, PRIMARY KEY (user_id, day, account_id))`,
  ];
  for (const q of ddl) await env.DB.prepare(q).run();
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
    const rows = (await env.DB.prepare("SELECT symbol FROM holdings WHERE account_id=?").bind(id).all()).results.map((r) => r.symbol);
    expect(rows).toEqual(["sz000338"]); // 导入整体替换持仓
    const cash = (await env.DB.prepare("SELECT amount FROM cash_balances WHERE account_id=?").bind(id).all()).results;
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
