import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";

beforeAll(async () => {
  for (const q of [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
    "CREATE TABLE IF NOT EXISTS macro_series (series TEXT NOT NULL, date TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (series, date))",
    "CREATE TABLE IF NOT EXISTS macro_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ]) await env.DB.prepare(q).run();
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO macro_series VALUES ('US_CAPE','2026-09',38),('US_CAPE','2026-10',40),('US_REAL10Y','2026-09',2),('US_REAL10Y','2026-10',2),('US_10Y','2026-09',4.1),('US_10Y','2026-10',4.2)"),
    env.DB.prepare("INSERT OR REPLACE INTO macro_meta VALUES ('fetched_at', ?)").bind(new Date().toISOString()),
  ]);
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function userCookie(username) {
  const own = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-pass" }) });
  const codes = await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { "content-type": "application/json", cookie: own.headers.get("set-cookie") }, body: JSON.stringify({ count: 1 }) });
  const code = (await codes.json()).created[0];
  const r = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "secret1", code }) });
  return r.headers.get("set-cookie");
}

describe("GET /api/macro?markets=", () => {
  it("returns only the requested markets, plus rates", async () => {
    const j = await (await SELF.fetch("https://x/api/macro?markets=us")).json();
    expect(j.markets.map((m) => m.key)).toEqual(["us"]);
    expect(Object.keys(j.gravity)).toEqual(["us"]);
    expect(j.rates.find((r) => r.key === "us10y")).toMatchObject({ value: 4.2, chg1m: 0.1 });
    const none = await (await SELF.fetch("https://x/api/macro?markets=")).json();
    expect(none.markets).toEqual([]);
    expect(none.rates.length).toBeGreaterThan(0);
  });
});

describe("GET /api/macro/pulse", () => {
  it("fetches only the visible market's indices", async () => {
    const f = Array(40).fill("0"); f[3] = "23651.87"; f[4] = "23867.74"; f[30] = "2026/10/21 18:31:19"; f[31] = "-215.87"; f[32] = "-0.90";
    let qtPath = "";
    fetchMock.get("https://qt.gtimg.cn").intercept({ path: (p) => { qtPath = p; return p.startsWith("/q="); } }).reply(200, `v_hkHSI="${f.join("~")}";`);
    const klines = [];
    fetchMock.get("https://web.ifzq.gtimg.cn").intercept({ path: (p) => { klines.push(p); return p.startsWith("/appstock/app/fqkline/get"); } })
      .reply(200, JSON.stringify({ data: { hkHSI: { day: [["2025-10-21", "0", "25000"], ["2026-10-20", "0", "23867.74"]] } } })).times(3);
    const r = await SELF.fetch("https://x/api/macro/pulse?markets=hk&cross=0");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(decodeURIComponent(qtPath)).toBe("/q=hkHSI,hkHSTECH,hkHSCEI");
    expect(klines.every((p) => /hk(HSI|HSTECH|HSCEI)/.test(decodeURIComponent(p)))).toBe(true);
    expect(Object.keys(j.markets)).toEqual(["hk"]);
    expect(j.markets.hk[0]).toMatchObject({ key: "hsi", price: 23651.87, pct: -0.9, chg1y: -5.4 });
    expect(j.cross).toBeUndefined();
  });
  it("makes no upstream requests when nothing is visible", async () => {
    const j = await (await SELF.fetch("https://x/api/macro/pulse?markets=&cross=0")).json();
    expect(j.markets).toEqual({});
  });
});

describe("/api/my/macro-prefs", () => {
  it("requires sign-in", async () => {
    expect((await SELF.fetch("https://x/api/my/macro-prefs")).status).toBe(401);
  });
  it("stores normalized prefs per user without leaking into board settings", async () => {
    const cookie = await userCookie("macro_pref_user");
    expect((await (await SELF.fetch("https://x/api/my/macro-prefs", { headers: { cookie } })).json()).prefs).toBe(null);
    const put = await SELF.fetch("https://x/api/my/macro-prefs", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ prefs: { order: ["cn", "us", "bogus"], hidden: ["cn"], cross: false, at: 123 } }) });
    expect(put.status).toBe(200);
    const got = (await (await SELF.fetch("https://x/api/my/macro-prefs", { headers: { cookie } })).json()).prefs;
    expect(got).toEqual({ order: ["cn", "us", "hk"], hidden: ["cn"], cross: false, at: 123 });
    const settings = (await (await SELF.fetch("https://x/api/my/settings", { headers: { cookie } })).json()).settings;
    expect(settings.macro_prefs).toBeUndefined();
    const bad = await SELF.fetch("https://x/api/my/macro-prefs", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
  });
});
