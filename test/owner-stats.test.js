import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";

const J = { "content-type": "application/json" };
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL, mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, valuations TEXT NOT NULL DEFAULT '[]', selected_valuation_id TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
  `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS broker_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, broker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', cred_enc TEXT, last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', quantity REAL NOT NULL, cost_price REAL, currency TEXT NOT NULL, market TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS ai_models (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '', key_enc TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ai_chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, symbol TEXT NOT NULL, method TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', messages TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage_daily (day TEXT NOT NULL, user_id INTEGER NOT NULL, ai INTEGER NOT NULL DEFAULT 0, ai_own INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, user_id))`,
];

beforeAll(async () => {
  for (const t of TABLES) await env.DB.prepare(t).run();
  const ins = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const now = new Date().toISOString();
  await env.DB.batch([
    ins("INSERT INTO users (id,username,pass_hash,pass_salt,board_slug,created_at) VALUES (1,'ann','HASH-SECRET','SALT-SECRET','ann',?)", day(40) + "T08:00:00.000Z"),
    ins("INSERT INTO users (id,username,pass_hash,pass_salt,board_slug,created_at) VALUES (2,'ben','HASH-SECRET','SALT-SECRET','ben',?)", day(3) + "T08:00:00.000Z"),
    ins("INSERT INTO users (id,username,pass_hash,pass_salt,board_slug,created_at) VALUES (3,'cat','HASH-SECRET','SALT-SECRET','cat',?)", now),
    ins("INSERT INTO items (user_id,ticker,symbol,fair_low,fair_high,mos,ext,valuations,updated_at) VALUES (1,'AAPL','usAAPL',1,2,30,60,?,?)", JSON.stringify([{ id: "a" }, { id: "b" }]), day(1) + "T00:00:00.000Z"),
    ins("INSERT INTO items (user_id,ticker,symbol,fair_low,fair_high,mos,ext,valuations,updated_at) VALUES (1,'00700','hk00700',1,2,30,60,'[]',?)", day(20) + "T00:00:00.000Z"),
    ins("INSERT INTO items (user_id,ticker,symbol,fair_low,fair_high,mos,ext,valuations,updated_at) VALUES (2,'AAPL','usAAPL',1,2,30,60,?,?)", JSON.stringify([{ id: "c" }]), day(3) + "T00:00:00.000Z"),
    ins("INSERT INTO activation_codes (code,used_by,created_at) VALUES ('A',1,?),('B',2,?),('C',3,?),('D',NULL,?)", now, now, now, now),
    ins("INSERT INTO broker_accounts (id,user_id,broker,cred_enc,created_at) VALUES (1,1,'longbridge','ENC-SECRET',?)", now),
    ins("INSERT INTO holdings (account_id,symbol,quantity,currency) VALUES (1,'usAAPL',10,'USD'),(1,'hk00700',100,'HKD')"),
    ins("INSERT INTO ai_models (user_id,provider,model,key_enc,created_at) VALUES (2,'openai','gpt','KEY-SECRET',?)", now),
    ins("INSERT INTO ai_chats (user_id,symbol,messages,updated_at) VALUES (1,'usAAPL','[]',?),(1,'hk00700','[]',?)", now, now),
    ins("INSERT INTO settings (user_id,key,value) VALUES (1,'_ai_usage',?),(2,'_ai_usage',?)", day(0) + ":4", day(1) + ":9"),
    ins("INSERT INTO usage_daily (day,user_id,ai,ai_own) VALUES (?,1,3,0),(?,2,5,5)", day(0), day(2)),
  ]);
});

async function ownerCookie() {
  const r = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: J, body: JSON.stringify({ password: "test-pass" }) });
  return r.headers.get("set-cookie");
}

describe("GET /api/owner/stats", () => {
  it("requires the owner session", async () => {
    expect((await SELF.fetch("https://x/api/owner/stats")).status).toBe(401);
  });

  it("aggregates users, content, AI usage and top symbols", async () => {
    const r = await SELF.fetch("https://x/api/owner/stats", { headers: { cookie: await ownerCookie() } });
    expect(r.status).toBe(200);
    const text = await r.text();
    for (const s of ["HASH-SECRET", "SALT-SECRET", "ENC-SECRET", "KEY-SECRET"]) expect(text).not.toContain(s);
    const s = JSON.parse(text);

    expect(s.users).toMatchObject({ total: 3, today: 1, week: 2, month: 2 });
    expect(s.codes).toEqual({ issued: 4, used: 3 });
    expect(s.content).toEqual({ items: 3, valuations: 3, brokerUsers: 1, accounts: 1 });
    // 今天：ann 的 usage_daily 3 次 vs _ai_usage 4 次 → 取大 4；ben 的 _ai_usage 是昨天的，不算今天
    expect(s.ai).toEqual({ today: 4, week: 9, ownModelUsers: 1, chats: 2, chatUsers: 1 });
    expect(s.topSymbols[0]).toEqual({ symbol: "usAAPL", ticker: "AAPL", name: "", users: 2 });
    expect(s.topSymbols).toHaveLength(2);

    expect(s.series).toHaveLength(30);
    expect(s.series.at(-1)).toMatchObject({ day: day(0), newUsers: 1, ai: 4 });
    expect(s.series.at(-3)).toMatchObject({ day: day(2), ai: 5, aiOwn: 5, active: 1 });

    const ann = s.list.find((u) => u.username === "ann"), ben = s.list.find((u) => u.username === "ben");
    expect(ann).toMatchObject({ items: 2, valuations: 2, accounts: 1, holdings: 2, models: 0, chats: 2, aiToday: 4, ai7d: 4 });
    expect(ann.lastActive.slice(0, 10)).toBe(day(0));
    expect(ben).toMatchObject({ items: 1, valuations: 1, accounts: 0, models: 1, aiToday: 0, ai7d: 5 });
    expect(ben.lastActive).toBe(day(2));
    expect(Object.keys(ann)).not.toContain("pass_hash");
  });

  it("/api/me records last-seen and a daily-active row", async () => {
    const own = await ownerCookie();
    const code = (await (await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { ...J, cookie: own }, body: JSON.stringify({ count: 1 }) })).json()).created[0];
    const reg = await SELF.fetch("https://x/api/register", { method: "POST", headers: J, body: JSON.stringify({ username: "dan", password: "secret1", code }) });
    const ck = reg.headers.get("set-cookie");
    expect((await SELF.fetch("https://x/api/me", { headers: { cookie: ck } })).status).toBe(200);
    const uid = (await env.DB.prepare("SELECT id FROM users WHERE username='dan'").first()).id;
    const seen = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key='_last_seen'").bind(uid).first();
    expect(seen.value.slice(0, 10)).toBe(day(0));
    expect(await env.DB.prepare("SELECT ai FROM usage_daily WHERE user_id=? AND day=?").bind(uid, day(0)).first()).toEqual({ ai: 0 });
    // 内部键不会出现在公开看板的 settings 里
    const cfg = await (await SELF.fetch("https://x/api/config?slug=dan")).json();
    expect(Object.keys(cfg.settings)).not.toContain("_last_seen");
  });
});
