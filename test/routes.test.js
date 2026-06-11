import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";

beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS items (
       id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
       symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL,
       mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`
  ).run();
});

const item = { ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 };

async function login() {
  const res = await SELF.fetch("https://x/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-pass" }),
  });
  return res.headers.get("set-cookie");
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
    expect(create.status).toBe(200);

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
