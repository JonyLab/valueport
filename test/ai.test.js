import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { aiConfig, chatComplete, validateChat, buildSystemPrompt, parseSuggestion, validateMethodReq, parsePicks } from "../src/ai.js";

beforeAll(async () => {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
  ];
  for (const q of ddl) await env.DB.prepare(q).run();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const FIELDS = [
  { k: "n", label: "高增长年数", col: "single", unit: "", value: 10 },
  { k: "growth", label: "营收增速", col: "dual", unit: "%", value: { c: 10, o: 10 } },
  { k: "wacc", label: "WACC", col: "dual", unit: "%", value: { c: 9, o: 9 } },
];
const CONTEXT = { stock: { name: "小米集团", code: "01810", currency: "HKD", price: 26.66 }, method: { key: "fcff", label: "FCFF" }, fields: FIELDS, facts: { revenue: 3.6e11 } };

describe("parseSuggestion", () => {
  it("extracts the last json block, keeps only known fields, and strips it from the reply", () => {
    const text = '增速可以保守一点。\n```json\n{"params":{"growth":{"c":8,"o":15},"n":"7","bogus":3,"wacc":"9.5%"},"reasons":{"growth":"行业增速放缓","bogus":"x"}}\n```';
    const r = parseSuggestion(text, FIELDS);
    expect(r.reply).toBe("增速可以保守一点。");
    expect(r.params).toEqual({ growth: { c: 8, o: 15 }, n: 7, wacc: { c: 9.5, o: 9.5 } });
    expect(r.reasons).toEqual({ growth: "行业增速放缓" });
  });
  it("returns no params for plain answers or broken json", () => {
    expect(parseSuggestion("WACC 是加权平均资本成本。", FIELDS)).toEqual({ reply: "WACC 是加权平均资本成本。", params: null, reasons: null });
    expect(parseSuggestion("看这里 ```json\n{oops\n```", FIELDS).params).toBeNull();
  });
});

describe("validateChat / prompt / config", () => {
  it("rejects malformed bodies", () => {
    expect(validateChat(null)).toBeTruthy();
    expect(validateChat({ messages: [], context: CONTEXT })).toBeTruthy();
    expect(validateChat({ messages: [{ role: "system", content: "x" }], context: CONTEXT })).toBeTruthy();
    expect(validateChat({ messages: [{ role: "user", content: "x".repeat(4001) }], context: CONTEXT })).toBeTruthy();
    expect(validateChat({ messages: [{ role: "user", content: "hi" }], context: { fields: [] } })).toBeTruthy();
    expect(validateChat({ messages: [{ role: "user", content: "hi" }], context: CONTEXT })).toBeNull();
  });
  it("lists the fields and the json contract in the system prompt", () => {
    const p = buildSystemPrompt(CONTEXT, "zh");
    expect(p).toContain("小米集团");
    expect(p).toContain("growth｜营收增速｜保守/乐观两档");
    expect(p).toContain('"params"');
  });
  it("defaults to Workers AI and rejects unknown providers", () => {
    expect(aiConfig({}).provider).toBe("workers-ai");
    expect(() => aiConfig({ AI_PROVIDER: "nope" })).toThrow();
  });
  it("calls the Workers AI binding and the Anthropic protocol", async () => {
    const calls = [];
    const fakeAi = { run: async (model, input) => { calls.push({ model, input }); return { response: "ok" }; } };
    expect(await chatComplete({ AI: fakeAi }, "sys", [{ role: "user", content: "hi" }])).toBe("ok");
    expect(calls[0].input.messages[0]).toEqual({ role: "system", content: "sys" });
    const fetchImpl = async (url, init) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init.headers["x-api-key"]).toBe("k");
      expect(JSON.parse(init.body).system).toBe("sys");
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hello" }] }));
    };
    expect(await chatComplete({ AI_PROVIDER: "anthropic", AI_API_KEY: "k" }, "sys", [{ role: "user", content: "hi" }], fetchImpl)).toBe("hello");
    await expect(chatComplete({ AI_PROVIDER: "openai" }, "sys", [])).rejects.toThrow(/AI_API_KEY/);
  });
});

const J = { "content-type": "application/json" };
async function userCookie(username) {
  const own = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: J, body: JSON.stringify({ password: "test-pass" }) });
  const ck = own.headers.get("set-cookie");
  const code = (await (await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify({ count: 1 }) })).json()).created[0];
  const r = await SELF.fetch("https://x/api/register", { method: "POST", headers: J, body: JSON.stringify({ username, password: "secret1", code }) });
  return r.headers.get("set-cookie");
}
const post = (cookie, body) => SELF.fetch("https://x/api/my/ai/valuation", { method: "POST", headers: { ...J, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

describe("POST /api/my/ai/valuation", () => {
  it("requires login and a valid body", async () => {
    expect((await post(null, { messages: [{ role: "user", content: "hi" }], context: CONTEXT })).status).toBe(401);
    const ck = await userCookie("aiuser1");
    expect((await post(ck, { messages: [] })).status).toBe(400);
  });
  it("relays the chat to the configured provider and returns parsed params", async () => {
    const ck = await userCookie("aiuser2");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { choices: [{ message: { content: '建议如下。\n```json\n{"params":{"wacc":{"c":10,"o":8.5}},"reasons":{"wacc":"港股风险溢价"}}\n```' } }] });
    const r = await post(ck, { lang: "zh", messages: [{ role: "user", content: "帮我设一下 WACC" }], context: CONTEXT });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ reply: "建议如下。", params: { wacc: { c: 10, o: 8.5 } }, reasons: { wacc: "港股风险溢价" } });
  });
  it("reports provider errors as 502 and enforces the daily limit", async () => {
    const ck = await userCookie("aiuser3");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(500, { error: { message: "boom" } });
    const r = await post(ck, { messages: [{ role: "user", content: "hi" }], context: CONTEXT });
    expect(r.status).toBe(502);
    expect((await r.json()).detail).toBe("boom");
    const uid = (await env.DB.prepare("SELECT id FROM users WHERE username='aiuser3'").first()).id;
    await env.DB.prepare("UPDATE settings SET value=? WHERE user_id=? AND key='_ai_usage'").bind(new Date().toISOString().slice(0, 10) + ":100", uid).run();
    expect((await post(ck, { messages: [{ role: "user", content: "hi" }], context: CONTEXT })).status).toBe(429);
  });
});

const METHODS = [{ key: "pb", title: "P/B" }, { key: "ddm", title: "DDM" }, { key: "fcf", title: "DCF" }, { key: "pe", title: "P/E" }];
describe("method recommendation", () => {
  it("keeps known keys only, first pick is primary, at most three", () => {
    const r = parsePicks('银行股看净资产。\n```json\n{"picks":[{"key":"nope"},{"key":"pb","role":"check","reason":"银行"},{"key":"ddm","role":"primary"},{"key":"pb"},{"key":"pe"},{"key":"fcf"}]}\n```', METHODS);
    expect(r.reply).toBe("银行股看净资产。");
    expect(r.picks).toEqual([{ key: "pb", role: "primary", reason: "银行" }, { key: "ddm", role: "check", reason: "" }, { key: "pe", role: "check", reason: "" }]);
    expect(parsePicks("没有代码块", METHODS).picks).toEqual([]);
  });
  it("validates the request", () => {
    expect(validateMethodReq({ stock: { name: "x" }, methods: [] })).toBeTruthy();
    expect(validateMethodReq({ methods: METHODS })).toBeTruthy();
    expect(validateMethodReq({ stock: { name: "招商银行" }, methods: METHODS })).toBeNull();
  });
  it("returns picks from the provider", async () => {
    const ck = await userCookie("aiuser4");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { choices: [{ message: { content: '银行。\n```json\n{"picks":[{"key":"pb","reason":"账面价值"}]}\n```' } }] });
    const r = await SELF.fetch("https://x/api/my/ai/method", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify({ lang: "zh", stock: { name: "招商银行", code: "600036" }, facts: { bps: 40 }, methods: METHODS }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ reply: "银行。", picks: [{ key: "pb", role: "primary", reason: "账面价值" }] });
  });
});
