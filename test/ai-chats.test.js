import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { validateChatSave, MAX_PER_SYMBOL } from "../src/ai-chats.js";

beforeAll(async () => {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS ai_chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, symbol TEXT NOT NULL, method TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', messages TEXT NOT NULL, updated_at TEXT NOT NULL)`,
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
const R = (cookie, method, path, body) => SELF.fetch("https://x" + path, { method, headers: { ...J, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const MSGS = [
  { role: "user", content: "增速给多少合适？" },
  { role: "assistant", content: "保守 8%、乐观 12%。", view: { reply: "保守 8%、乐观 12%。", params: { growth: { c: 8, o: 12 } }, widgets: [] } },
];

describe("validateChatSave", () => {
  it("checks symbol, roles, sizes and views", () => {
    expect(validateChatSave({ symbol: "usAAPL", messages: MSGS })).toBeNull();
    expect(validateChatSave({ symbol: "AAPL!", messages: MSGS })).toBeTruthy();
    expect(validateChatSave({ symbol: "usAAPL", messages: [] })).toBeTruthy();
    expect(validateChatSave({ symbol: "usAAPL", messages: [{ role: "system", content: "x" }] })).toBeTruthy();
    expect(validateChatSave({ symbol: "usAAPL", messages: [{ role: "assistant", content: "x", view: "nope" }] })).toBeTruthy();
    expect(validateChatSave({ symbol: "usAAPL", id: "1", messages: MSGS })).toBeTruthy();
  });
});

describe("AI chat history", () => {
  it("saves, lists, updates, reads and deletes a user's chats per symbol", async () => {
    expect((await R(null, "GET", "/api/my/ai/chats?symbol=usAAPL")).status).toBe(401);
    const ck = await userCookie("chatuser1");
    const created = await (await R(ck, "PUT", "/api/my/ai/chats", { symbol: "usAAPL", method: "fcff", messages: MSGS })).json();
    expect(created.id).toBeTruthy();
    // 同一条继续聊：带 id 覆盖
    const more = [...MSGS, { role: "user", content: "折现率呢？" }, { role: "assistant", content: "9%", view: { reply: "9%" } }];
    expect((await (await R(ck, "PUT", "/api/my/ai/chats", { id: created.id, symbol: "usAAPL", method: "fcff", messages: more })).json()).id).toBe(created.id);
    await R(ck, "PUT", "/api/my/ai/chats", { symbol: "hk00700", messages: MSGS }); // 别的标的不混进来
    const list = (await (await R(ck, "GET", "/api/my/ai/chats?symbol=usAAPL")).json()).chats;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, method: "fcff", title: "增速给多少合适？", count: 4 });
    const chat = (await (await R(ck, "GET", "/api/my/ai/chats/" + created.id)).json()).chat;
    expect(chat.messages[1].view.params).toEqual({ growth: { c: 8, o: 12 } });
    expect(chat.messages).toHaveLength(4);
    // 别人看不到、删不掉
    const other = await userCookie("chatuser2");
    expect((await R(other, "GET", "/api/my/ai/chats/" + created.id)).status).toBe(404);
    expect((await R(other, "DELETE", "/api/my/ai/chats/" + created.id)).status).toBe(404);
    expect((await (await R(other, "GET", "/api/my/ai/chats?symbol=usAAPL")).json()).chats).toHaveLength(0);
    // 带别人的 id 保存 → 新建一条自己的，不会改到别人的
    const hijack = await (await R(other, "PUT", "/api/my/ai/chats", { id: created.id, symbol: "usAAPL", messages: MSGS })).json();
    expect(hijack.id).not.toBe(created.id);
    expect((await R(ck, "DELETE", "/api/my/ai/chats/" + created.id)).status).toBe(200);
    expect((await (await R(ck, "GET", "/api/my/ai/chats?symbol=usAAPL")).json()).chats).toHaveLength(0);
  });
  it("keeps at most MAX_PER_SYMBOL chats per symbol, dropping the oldest", async () => {
    const ck = await userCookie("chatuser3");
    for (let i = 0; i < MAX_PER_SYMBOL + 2; i++) await R(ck, "PUT", "/api/my/ai/chats", { symbol: "sh600519", messages: [{ role: "user", content: "q" + i }] });
    const list = (await (await R(ck, "GET", "/api/my/ai/chats?symbol=sh600519")).json()).chats;
    expect(list).toHaveLength(MAX_PER_SYMBOL);
    expect(list.some((c) => c.title === "q0")).toBe(false);
  });
});
