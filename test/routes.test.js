import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL, mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, valuations TEXT NOT NULL DEFAULT '[]', selected_valuation_id TEXT, updated_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`).run();
});

async function ownerCookie() {
  const r = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-pass" }) });
  const ck = r.headers.get("set-cookie"); if (!ck) throw new Error("owner login failed"); return ck;
}
async function mintCode() {
  const r = await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { "content-type": "application/json", cookie: await ownerCookie() }, body: JSON.stringify({ count: 1 }) });
  return (await r.json()).created[0];
}
async function register(username) {
  const code = await mintCode();
  const r = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "secret1", code }) });
  return { res: r, cookie: r.headers.get("set-cookie") };
}

describe("owner", () => {
  it("rejects wrong owner password", async () => {
    const r = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "no" }) });
    expect(r.status).toBe(401);
  });
  it("gates code listing without owner session", async () => {
    expect((await SELF.fetch("https://x/api/owner/codes")).status).toBe(401);
  });
  it("mints activation codes", async () => {
    const r = await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { "content-type": "application/json", cookie: await ownerCookie() }, body: JSON.stringify({ count: 3 }) });
    expect(r.status).toBe(200); expect((await r.json()).created.length).toBe(3);
  });
});

describe("register + login", () => {
  it("registers with a valid code and rejects reuse", async () => {
    const code = await mintCode();
    const ok = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password: "secret1", code }) });
    expect(ok.status).toBe(200);
    const reuse = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice2", password: "secret1", code }) });
    expect(reuse.status).toBe(400);
  });
  it("rejects an invalid code", async () => {
    const r = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bob", password: "secret1", code: "NOPE-NOPE-NOPE" }) });
    expect(r.status).toBe(400);
  });
  it("logs in and reaches /api/me", async () => {
    const { cookie } = await register("carol");
    const me = await SELF.fetch("https://x/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).username).toBe("carol");
  });
  it("POST /api/login: correct password 200 + cookie, wrong 401", async () => {
    await register("frank");
    const ok = await SELF.fetch("https://x/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "frank", password: "secret1" }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toBeTruthy();
    const bad = await SELF.fetch("https://x/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "frank", password: "WRONG" }) });
    expect(bad.status).toBe(401);
  });
});

describe("per-user isolation", () => {
  it("a user only sees their own items; public board shows them", async () => {
    const a = await register("dave"); const b = await register("erin");
    await SELF.fetch("https://x/api/my/items", { method: "POST", headers: { "content-type": "application/json", cookie: a.cookie }, body: JSON.stringify({ ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 }) });
    const aItems = await (await SELF.fetch("https://x/api/my/items", { headers: { cookie: a.cookie } })).json();
    const bItems = await (await SELF.fetch("https://x/api/my/items", { headers: { cookie: b.cookie } })).json();
    expect(aItems.items.length).toBe(1);
    expect(bItems.items.length).toBe(0);
    const pub = await (await SELF.fetch("https://x/api/config?slug=dave")).json();
    expect(pub.items.some((i) => i.symbol === "usAAPL")).toBe(true);
  });
  it("blocks my/items without session", async () => {
    expect((await SELF.fetch("https://x/api/my/items")).status).toBe(401);
  });
  it("404s an unknown public board slug", async () => {
    expect((await SELF.fetch("https://x/api/config?slug=nobody")).status).toBe(404);
  });
});

describe("/app legacy redirect", () => {
  it("redirects anonymous visitors to /login", async () => {
    const r = await SELF.fetch("https://x/app", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/login");
  });
  it("redirects a logged-in user to their board", async () => {
    const { cookie } = await register("gina");
    const r = await SELF.fetch("https://x/app", { headers: { cookie }, redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/b/gina");
  });
});

describe("financials", () => {
  it("returns {financials:null} for an unconvertible symbol", async () => {
    const r = await SELF.fetch("https://x/api/financials?symbol=INVALID_SYMBOL");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty("financials");
    expect(j.financials).toBe(null);
  });
  it("returns {financials:null} for a missing symbol", async () => {
    const r = await SELF.fetch("https://x/api/financials");
    expect(r.status).toBe(200);
    expect((await r.json()).financials).toBe(null);
  });
});
