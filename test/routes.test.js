import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";

beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS items (
       id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
       symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL,
       mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  ).run();
});

const item = { ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 };

async function login() {
  const res = await SELF.fetch("https://x/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-pass" }),
  });
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("login failed — check ADMIN_PASSWORD binding");
  return cookie;
}

describe("auth gating", () => {
  it("blocks admin CRUD without a session", async () => {
    const res = await SELF.fetch("https://x/api/admin/items");
    expect(res.status).toBe(401);
  });
  it("rejects wrong password", async () => {
    const res = await SELF.fetch("https://x/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("crud + public read", () => {
  it("creates an item and exposes it on /api/config", async () => {
    const cookie = await login();
    const create = await SELF.fetch("https://x/api/admin/items", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(item),
    });
    expect(create.status).toBe(201);

    const pub = await SELF.fetch("https://x/api/config");
    const body = await pub.json();
    expect(body.items.some((i) => i.symbol === "usAAPL")).toBe(true);
  });

  it("rejects invalid payloads with 400", async () => {
    const cookie = await login();
    const res = await SELF.fetch("https://x/api/admin/items", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...item, fairHigh: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("update / delete / misc routes", () => {
  it("updates an item via PUT and reflects it on /api/config", async () => {
    const cookie = await login();
    const create = await SELF.fetch("https://x/api/admin/items", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...item, symbol: "usPUTX", ticker: "PUTX" }),
    });
    const { id } = await create.json();
    const upd = await SELF.fetch(`https://x/api/admin/items/${id}`, {
      method: "PUT", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...item, symbol: "usPUTX", ticker: "PUTX", fairHigh: 999 }),
    });
    expect(upd.status).toBe(200);
    const cfg = await (await SELF.fetch("https://x/api/config")).json();
    const row = cfg.items.find((i) => i.symbol === "usPUTX");
    expect(row.fairHigh).toBe(999);
  });

  it("deletes an item and 404s on re-delete", async () => {
    const cookie = await login();
    const create = await SELF.fetch("https://x/api/admin/items", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...item, symbol: "usDELX", ticker: "DELX" }),
    });
    const { id } = await create.json();
    const del1 = await SELF.fetch(`https://x/api/admin/items/${id}`, { method: "DELETE", headers: { cookie } });
    expect(del1.status).toBe(200);
    const del2 = await SELF.fetch(`https://x/api/admin/items/${id}`, { method: "DELETE", headers: { cookie } });
    expect(del2.status).toBe(404);
  });

  it("persists and returns sortOrder (snake_case round-trip)", async () => {
    const cookie = await login();
    await SELF.fetch("https://x/api/admin/items", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...item, symbol: "usSORTX", ticker: "SORTX", sortOrder: 7 }),
    });
    const cfg = await (await SELF.fetch("https://x/api/config")).json();
    const row = cfg.items.find((i) => i.symbol === "usSORTX");
    expect(row.sortOrder).toBe(7);
  });

  it("logout returns ok", async () => {
    const cookie = await login();
    const res = await SELF.fetch("https://x/api/logout", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("/api/quotes with no symbols returns empty quotes without hitting upstream", async () => {
    const res = await SELF.fetch("https://x/api/quotes");
    expect(res.status).toBe(200);
    expect((await res.json()).quotes).toEqual({});
  });

  it("returns JSON 404 for an unknown /api path", async () => {
    const res = await SELF.fetch("https://x/api/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("page text settings", () => {
  it("blocks settings writes without a session", async () => {
    const res = await SELF.fetch("https://x/api/admin/settings", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("saves settings and exposes them on /api/config", async () => {
    const cookie = await login();
    const put = await SELF.fetch("https://x/api/admin/settings", {
      method: "PUT", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ eyebrow: "我的小标题", title: "我的看板", subtitle: "我的说明" }),
    });
    expect(put.status).toBe(200);
    const cfg = await (await SELF.fetch("https://x/api/config")).json();
    expect(cfg.settings).toMatchObject({ eyebrow: "我的小标题", title: "我的看板", subtitle: "我的说明" });
  });

  it("clearing a value resets it to default (key removed)", async () => {
    const cookie = await login();
    await SELF.fetch("https://x/api/admin/settings", {
      method: "PUT", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "临时标题" }),
    });
    await SELF.fetch("https://x/api/admin/settings", {
      method: "PUT", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "   " }), // 清空（trim 后为空）→ 删除该键
    });
    const cfg = await (await SELF.fetch("https://x/api/config")).json();
    expect("title" in cfg.settings).toBe(false);
  });

  it("ignores keys outside the allowed set", async () => {
    const cookie = await login();
    await SELF.fetch("https://x/api/admin/settings", {
      method: "PUT", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ evil: "nope" }),
    });
    const cfg = await (await SELF.fetch("https://x/api/config")).json();
    expect("evil" in cfg.settings).toBe(false);
  });
});
