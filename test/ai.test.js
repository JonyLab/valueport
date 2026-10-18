import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { validateModel, aiConfig, chatComplete, validateChat, buildSystemPrompt, parseSuggestion, validateMethodReq, parsePicks } from "../src/ai.js";

beforeAll(async () => {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS ai_models (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '', key_enc TEXT NOT NULL, created_at TEXT NOT NULL)`,
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

describe("verified facts in prompts", () => {
  const V = ["自由现金流 2018–2025：2021、2022 年为负。判断：现金流不稳定，不能说「现金流稳定」", "没有查到现金分红记录：视为不分红"];
  it("puts verified facts and the grounding rule into both prompts", async () => {
    const { buildMethodPrompt } = await import("../src/ai.js");
    const mp = buildMethodPrompt({ stock: { name: "小米集团" }, methods: METHODS, verified: V }, "zh");
    expect(mp).toContain("已核实的事实");
    expect(mp).toContain("2021、2022 年为负");
    expect(mp).toContain("不要编造");
    const sp = buildSystemPrompt({ ...CONTEXT, verified: V }, "zh");
    expect(sp).toContain("没有查到现金分红记录");
  });
  it("rejects malformed verified facts", () => {
    expect(validateMethodReq({ stock: { name: "x" }, methods: METHODS, verified: "nope" })).toBeTruthy();
    expect(validateMethodReq({ stock: { name: "x" }, methods: METHODS, verified: ["x".repeat(301)] })).toBeTruthy();
    expect(validateChat({ messages: [{ role: "user", content: "hi" }], context: { ...CONTEXT, verified: [1] } })).toBeTruthy();
    expect(validateMethodReq({ stock: { name: "x" }, methods: METHODS, verified: V })).toBeNull();
  });
});

describe("AI review", () => {
  const FIELDS2 = [{ k: "growth", label: "营收增速", col: "dual", unit: "%", value: { c: 8, o: 15 } }, { k: "targetPE", label: "目标 PE", col: "dual", unit: "", value: { c: 18, o: 25 } }];
  const BODY = { lang: "zh", stock: { name: "腾讯控股", code: "00700" }, method: { key: "pe", label: "P/E" }, valuedAt: "2025-03-01", fields: FIELDS2, result: { low: 400, high: 560, price: 417.8 },
    verified: ["自由现金流 2016–2025：各年均为正"], metrics: ["营收增速：最新年同比 +7.0%，近三年复合 +6.1%"] };
  it("builds a grounded prompt and parses only known keys and statuses", async () => {
    const { buildReviewPrompt, parseReview, validateReviewReq } = await import("../src/ai.js");
    const p = buildReviewPrompt(BODY, "zh");
    expect(p).toContain("growth｜营收增速｜百分数｜当初填的：保守 8 / 乐观 15");
    expect(p).toContain("最新实际数据");
    expect(p).toContain("近三年复合 +6.1%");
    expect(p).toContain("不给买卖建议");
    const p2 = buildReviewPrompt({ ...BODY, comparisons: ["targetPE（目标 PE）：当初 保守 18 / 乐观 25；当前倍数 20.0 → 落在两档之间"] }, "zh");
    expect(p2).toContain("假设对照");
    expect(p2).toContain("落在两档之间");
    const r = parseReview('```json\n{"overall":"watch","summary":"增速跌到保守假设以下","checks":[{"k":"growth","status":"broken","reason":"近三年复合 6.1% 低于保守 8%"},{"k":"nope","status":"ok"},{"k":"targetPE","status":"great"}]}\n```', FIELDS2);
    expect(r).toEqual({ overall: "watch", summary: "增速跌到保守假设以下", checks: [{ k: "growth", status: "broken", reason: "近三年复合 6.1% 低于保守 8%" }] });
    expect(parseReview('```json\n{"overall":"fine"}\n```', FIELDS2)).toBeNull();
    expect(parseReview("没有代码块", FIELDS2)).toBeNull();
    expect(validateReviewReq({ ...BODY, result: {} })).toBeTruthy();
    expect(validateReviewReq({ ...BODY, metrics: "x" })).toBeTruthy();
    expect(validateReviewReq(BODY)).toBeNull();
  });
  it("returns the review from the provider with a timestamp", async () => {
    const ck = await userCookie("aiuser5");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { choices: [{ message: { content: '```json\n{"overall":"hold","summary":"假设仍成立","checks":[{"k":"growth","status":"ok","reason":"增速落在区间内"}]}\n```' } }] });
    const r = await SELF.fetch("https://x/api/my/ai/review", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(BODY) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.review).toMatchObject({ overall: "hold", summary: "假设仍成立", checks: [{ k: "growth", status: "ok", reason: "增速落在区间内" }] });
    expect(typeof j.review.at).toBe("string");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { choices: [{ message: { content: "随便聊聊" } }] });
    expect((await SELF.fetch("https://x/api/my/ai/review", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(BODY) })).status).toBe(502);
  });
});

describe("per-user AI models", () => {
  const R = (ck, method, path, body) => SELF.fetch("https://x" + path, { method, headers: { ...J, cookie: ck }, body: body ? JSON.stringify(body) : undefined });
  it("validates provider, model, https base URL and key", () => {
    expect(validateModel({ provider: "workers-ai", model: "x" }).error).toBeTruthy();
    expect(validateModel({ provider: "openai", model: "gpt-x", baseUrl: "http://insecure.test/v1", apiKey: "k" }).error).toMatch(/https/);
    expect(validateModel({ provider: "openai", model: "gpt-x", baseUrl: "https://u:p@x.test/v1", apiKey: "k" }).error).toMatch(/https/);
    expect(validateModel({ provider: "anthropic", model: "", apiKey: "k" }).error).toMatch(/model/);
    expect(validateModel({ provider: "anthropic", model: "claude-x", apiKey: "a b" }).error).toMatch(/key/);
    expect(validateModel({ provider: "openai", name: " DeepSeek ", model: "m", baseUrl: "https://x.test/v1/", apiKey: " sk-1 " }).value)
      .toEqual({ provider: "openai", name: "DeepSeek", model: "m", baseUrl: "https://x.test/v1", apiKey: "sk-1" });
  });
  it("lists built-in options, saves custom models encrypted, switches the active one and skips the site quota on own keys", async () => {
    const ck = await userCookie("aimod1");
    let list = await (await R(ck, "GET", "/api/my/ai/models")).json();
    expect(list.active).toBe("default");
    expect(list.workers.map((w) => w.id)).toContain("wa:@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(list.custom).toEqual([]);
    expect((await R(ck, "POST", "/api/my/ai/models", { provider: "openai", model: "m", baseUrl: "https://user-llm.test/v1" })).status).toBe(400); // 没 Key
    const created = await (await R(ck, "POST", "/api/my/ai/models", { provider: "openai", name: "我的模型", model: "my-model", baseUrl: "https://user-llm.test/v1", apiKey: "sk-user-9876" })).json();
    expect(created.id).toMatch(/^m:\d+$/);
    list = await (await R(ck, "GET", "/api/my/ai/models")).json();
    expect(JSON.stringify(list)).not.toContain("sk-user-9876");
    expect(list.custom[0]).toMatchObject({ id: created.id, kind: "openai", name: "我的模型", model: "my-model", keyHint: "…9876" });
    const uid = (await env.DB.prepare("SELECT id FROM users WHERE username='aimod1'").first()).id;
    expect((await env.DB.prepare("SELECT key_enc FROM ai_models WHERE user_id=?").bind(uid).first()).key_enc).not.toContain("9876");
    // 改模型名不重填 Key
    const rowId = created.id.slice(2);
    expect((await R(ck, "PUT", "/api/my/ai/models/" + rowId, { provider: "openai", name: "我的模型", model: "my-model-2", baseUrl: "https://user-llm.test/v1" })).status).toBe(200);
    // 切换：只能切到存在的选项
    expect((await R(ck, "PUT", "/api/my/ai/active", { id: "m:99999" })).status).toBe(400);
    expect((await R(ck, "PUT", "/api/my/ai/active", { id: created.id })).status).toBe(200);
    expect((await (await R(ck, "GET", "/api/my/ai/models")).json()).active).toBe(created.id);
    // 站点额度用完也不影响自己的 Key
    await env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?, '_ai_usage', ?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").bind(uid, new Date().toISOString().slice(0, 10) + ":100").run();
    let sent = null;
    fetchMock.get("https://user-llm.test").intercept({ path: "/v1/chat/completions", method: "POST", body: (b) => { sent = JSON.parse(b); return true; } })
      .reply(200, { choices: [{ message: { content: "<think>hmm</think>好的。" } }] });
    const r = await post(ck, { messages: [{ role: "user", content: "hi" }], context: CONTEXT });
    expect(r.status).toBe(200);
    expect((await r.json()).reply).toBe("好的。"); // 去掉推理模型的 <think>
    expect(sent.model).toBe("my-model-2");
    // 别人看不到、改不了、删不掉
    const other = await userCookie("aimod2");
    expect((await (await R(other, "GET", "/api/my/ai/models")).json()).custom).toEqual([]);
    expect((await R(other, "DELETE", "/api/my/ai/models/" + rowId)).status).toBe(404);
    expect((await R(other, "PUT", "/api/my/ai/active", { id: created.id })).status).toBe(400);
    // 删掉正在用的：回到站点默认（额度已用完 → 429）
    expect((await R(ck, "DELETE", "/api/my/ai/models/" + rowId)).status).toBe(200);
    expect((await (await R(ck, "GET", "/api/my/ai/models")).json()).active).toBe("default");
    expect((await post(ck, { messages: [{ role: "user", content: "hi" }], context: CONTEXT })).status).toBe(429);
  });
  it("tests a connection without saving it", async () => {
    const ck = await userCookie("aimod3");
    fetchMock.get("https://try-llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { choices: [{ message: { content: "OK" } }] });
    const ok = await (await R(ck, "POST", "/api/my/ai/models/test", { provider: "openai", model: "m1", baseUrl: "https://try-llm.test/v1", apiKey: "sk-t" })).json();
    expect(ok).toMatchObject({ ok: true, reply: "OK", model: "m1" });
    fetchMock.get("https://try-llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(401, { error: { message: "invalid api key" } });
    const bad = await (await R(ck, "POST", "/api/my/ai/models/test", { provider: "openai", model: "m1", baseUrl: "https://try-llm.test/v1", apiKey: "sk-t" })).json();
    expect(bad).toEqual({ ok: false, error: "invalid api key" });
    expect((await (await R(ck, "GET", "/api/my/ai/models")).json()).custom).toEqual([]); // 测试不会保存
  });
});

describe("market research and master lenses in prompts", () => {
  it("adds both blocks and the synthesis rule, and strips markdown from replies", async () => {
    const { buildMethodPrompt, buildReviewPrompt, parsePicks, plain } = await import("../src/ai.js");
    const market = ["分析师评级（46 家）：看多 25"], lenses = ["按林奇的方法：PEG = 1.63"];
    const mp = buildMethodPrompt({ stock: { name: "苹果" }, methods: METHODS, market, lenses }, "zh");
    expect(mp).toContain("市场投研（来自长桥");
    expect(mp).toContain("大师方法视角");
    expect(mp).toContain("不要声称某位大师本人");
    const rp = buildReviewPrompt({ stock: { name: "苹果" }, method: { key: "pe" }, fields: [{ k: "g", col: "single", value: 1 }], result: { low: 1, high: 2 }, market, lenses }, "zh");
    expect(rp).toContain("分析师评级（46 家）");
    expect(plain("用 **DCF** 做主方法，`pe` 交叉验证")).toBe("用 DCF 做主方法，pe 交叉验证");
    expect(parsePicks('首选 **fcf**。\n```json\n{"picks":[{"key":"pb","reason":"**账面**"}]}\n```', METHODS)).toEqual({ reply: "首选 fcf。", picks: [{ key: "pb", role: "primary", reason: "账面" }] });
  });
});

describe("AI note draft", () => {
  const BODY = { lang: "zh", context: { ...CONTEXT, verified: ["最近三年均盈利"] }, messages: [{ role: "user", content: "我觉得增速 10% 偏乐观" }, { role: "assistant", content: "可以下调\n```json\n{\"params\":{}}\n```" }], note: "IoT 是关键" };
  it("builds a grounded prompt with the conversation and existing note", async () => {
    const { buildNotePrompt, parseNote, validateNoteReq } = await import("../src/ai.js");
    const p = buildNotePrompt(BODY, "zh");
    expect(p).toContain("营收增速｜百分数｜保守 10 / 乐观 10");
    expect(p).toContain("已核实的事实");
    expect(p).toContain("用户：我觉得增速 10% 偏乐观");
    expect(p).toContain("（参数建议）"); // 对话里的参数代码块不原样塞进去
    expect(p).toContain("IoT 是关键");
    expect(p).toContain("不给买卖建议");
    expect(parseNote("**小米**是一家硬件公司。\n\n\n\n关键假设：增速 8%")).toBe("小米是一家硬件公司。\n\n关键假设：增速 8%");
    expect(parseNote("```json\n{}\n```")).toBeNull();
    expect(validateNoteReq(BODY)).toBeNull();
    expect(validateNoteReq({ ...BODY, note: "x".repeat(2001) })).toBeTruthy();
    expect(validateNoteReq({ ...BODY, messages: [{ role: "system", content: "x" }] })).toBeTruthy();
    expect(validateNoteReq({ context: { fields: [] } })).toBeTruthy();
  });
  it("returns the drafted note", async () => {
    const ck = await userCookie("aiuser-note");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { choices: [{ message: { content: "小米靠手机和 IoT 赚钱，用 P/E 估。\n关键假设：增速保守 8%。" } }] });
    const r = await SELF.fetch("https://x/api/my/ai/note", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(BODY) });
    expect(r.status).toBe(200);
    expect((await r.json()).note).toBe("小米靠手机和 IoT 赚钱，用 P/E 估。\n关键假设：增速保守 8%。");
    expect((await SELF.fetch("https://x/api/my/ai/note", { method: "POST", headers: J, body: JSON.stringify(BODY) })).status).toBe(401);
  });
});

describe("AI fundamentals brief", () => {
  const BODY = { lang: "zh", stock: { name: "腾讯控股", code: "00700", currency: "HKD" }, verified: ["自由现金流 2016–2025：各年均为正"], metrics: ["营收增速：最新年同比 +7.0%"] };
  it("builds a grounded prompt and parses points and risks", async () => {
    const { buildBriefPrompt, parseBrief, validateBriefReq } = await import("../src/ai.js");
    const p = buildBriefPrompt(BODY, "zh");
    expect(p).toContain("自由现金流 2016–2025：各年均为正");
    expect(p).toContain("最新年同比 +7.0%");
    expect(p).toContain("不估值、不给买卖建议");
    expect(parseBrief('```json\n{"points":["**a**","b","c","d"],"risks":["r1","r2","r3"]}\n```')).toEqual({ points: ["a", "b", "c"], risks: ["r1", "r2"] });
    expect(parseBrief('```json\n{"points":[],"risks":["r"]}\n```')).toBeNull();
    expect(parseBrief("随便聊聊")).toBeNull();
    expect(validateBriefReq(BODY)).toBeNull();
    expect(validateBriefReq({ stock: { name: "x" } })).toBeTruthy(); // 没有任何事实就不调用
  });
  it("returns the brief from the provider", async () => {
    const ck = await userCookie("aiuser-brief");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { choices: [{ message: { content: '```json\n{"points":["现金流十年为正","增速放缓到 7%","净现金"],"risks":["增速放缓"]}\n```' } }] });
    const r = await SELF.fetch("https://x/api/my/ai/brief", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(BODY) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.brief).toMatchObject({ points: ["现金流十年为正", "增速放缓到 7%", "净现金"], risks: ["增速放缓"] });
    expect(typeof j.brief.at).toBe("string");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { choices: [{ message: { content: "随便聊聊" } }] });
    expect((await SELF.fetch("https://x/api/my/ai/brief", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(BODY) })).status).toBe(502);
  });
});

describe("Workers AI quota errors", () => {
  it("recognises the free-allocation and capacity errors only", async () => {
    const { isWorkersQuotaError } = await import("../src/ai.js");
    expect(isWorkersQuotaError(new Error("4006: you have used up your daily free allocation of 10,000 neurons, please upgrade"))).toBe(true);
    expect(isWorkersQuotaError(new Error("AiError: 3040: Out of capacity"))).toBe(true);
    expect(isWorkersQuotaError(new Error("InferenceUpstreamError: 429 Too Many Requests"))).toBe(true);
    expect(isWorkersQuotaError(new Error("empty AI response"))).toBe(false);
    expect(isWorkersQuotaError(new Error("Workers AI binding (AI) is not configured"))).toBe(false);
  });
  it("tells the settings page the per-person daily limit", async () => {
    const ck = await userCookie("aiuser-limit");
    const j = await (await SELF.fetch("https://x/api/my/ai/models", { headers: { cookie: ck } })).json();
    expect(j.dailyLimit).toBe(100);
  });
});

describe("business-first method recommendation", () => {
  const M = ["fcff", "fcf", "ddm", "navsotp", "pe", "peg", "pb", "ps", "evebitda"].map((key) => ({ key, title: key }));
  it("asks for a business profile and type before methods", async () => {
    const { buildMethodPrompt } = await import("../src/ai.js");
    const p = buildMethodPrompt({ stock: { name: "紫金矿业" }, methods: M, business: ["收入构成（2026.H1，按业务）：矿产品 33.7%"] }, "zh");
    expect(p).toContain("先弄懂这门生意");
    expect(p).toContain("生意本身（来自长桥");
    expect(p).toContain("cyclical｜资源与周期");
    expect(p).toContain("利润增速高不等于高速成长");
    expect(p).toContain('"business": {"type"');
  });
  it("drops methods that don't fit the business type and keeps the profile", async () => {
    const { parsePicks } = await import("../src/ai.js");
    const text = '金价驱动。\n```json\n{"business":{"type":"cyclical","model":"开采并冶炼金铜","drivers":"金价、铜价与产量","implication":"利润随金属价格波动，不能外推增速"},"picks":[{"key":"peg","reason":"增速高"},{"key":"navsotp","reason":"储量资产"},{"key":"evebitda","reason":"中周期"}]}\n```';
    const r = parsePicks(text, M);
    expect(r.business).toEqual({ type: "cyclical", model: "开采并冶炼金铜", drivers: "金价、铜价与产量", implication: "利润随金属价格波动，不能外推增速" });
    expect(r.picks).toEqual([{ key: "navsotp", role: "primary", reason: "储量资产" }, { key: "evebitda", role: "check", reason: "中周期" }]);
    const fin = parsePicks('```json\n{"business":{"type":"financial"},"picks":[{"key":"fcf"},{"key":"pb"}]}\n```', M);
    expect(fin.picks.map((p) => p.key)).toEqual(["pb"]);
    const unknown = parsePicks('```json\n{"business":{"type":"alien"},"picks":[{"key":"peg"}]}\n```', M);
    expect(unknown.business).toBeNull();
    expect(unknown.picks.map((p) => p.key)).toEqual(["peg"]);
  });
});

describe("short method summaries", () => {
  it("prefers the JSON summary and otherwise keeps only the first real paragraph of long prose", async () => {
    const { parsePicks } = await import("../src/ai.js");
    const M = [{ key: "navsotp", title: "NAV" }, { key: "pb", title: "P/B" }];
    expect(parsePicks('长篇\n```json\n{"summary":"金属价格决定利润，按资源储量估最稳。","picks":[{"key":"navsotp"}]}\n```', M).reply).toBe("金属价格决定利润，按资源储量估最稳。");
    const long = "估值方法选择\n\n紫金矿业主要从事矿产资源勘查、金矿采选与铜冶炼，属于资源与周期型。\n\n1. 首选方法：NAV\n\nJSON 代码块\n```json\n{\"picks\":[{\"key\":\"navsotp\"}]}\n```";
    expect(parsePicks(long, M).reply).toBe("紫金矿业主要从事矿产资源勘查、金矿采选与铜冶炼，属于资源与周期型。");
    expect(parsePicks('银行股看净资产。\n```json\n{"picks":[{"key":"pb"}]}\n```', M).reply).toBe("银行股看净资产。");
  });
});
