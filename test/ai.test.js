import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, SELF, fetchMock } from "cloudflare:test";
import { validateModel, aiConfig, chatComplete, validateChat, buildSystemPrompt, parseSuggestion, parseWidgets, validateMethodReq, parsePicks } from "../src/ai.js";

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

describe("parseWidgets", () => {
  it("keeps catalog widgets, drops unknown types and fields, caps at 2", () => {
    const text = '看两种情形。\n```json\n{"widgets":[{"type":"chart","x":1},{"type":"sensitivity","field":"bogus"},{"type":"sensitivity","field":"wacc","steps":[1,-1,"2",-2]},{"type":"peers","multiple":"PE"},{"type":"set","field":"n","value":7}]}\n```';
    const r = parseSuggestion(text, FIELDS);
    expect(r.reply).toBe("看两种情形。");
    expect(r.params).toBeNull();
    expect(r.widgets).toEqual([
      { type: "sensitivity", field: "wacc", steps: [-2, -1, 0, 1, 2] },
      { type: "peers", multiple: "pe" },
    ]);
  });
  it("normalizes set values to the field shape and rejects bad ones", () => {
    expect(parseWidgets([
      { type: "set", field: "growth", value: 12, label: "  稍微保守  " },
      { type: "set", field: "n", value: { c: 8, o: 9 } },
    ], FIELDS)).toEqual([
      { type: "set", field: "growth", value: { c: 12, o: 12 }, label: "稍微保守" },
      { type: "set", field: "n", value: 8 },
    ]);
    expect(parseWidgets([{ type: "set", field: "wacc", value: { c: "x", o: 9 } }, { type: "set", field: "nope", value: 1 }, { type: "peers", multiple: "evebitda" }], FIELDS)).toBeNull();
    expect(parseWidgets("nope", FIELDS)).toBeNull();
  });
  it("falls back to default steps when steps are missing or out of range", () => {
    expect(parseWidgets([{ type: "sensitivity", field: "growth" }], FIELDS)[0].steps).toEqual([-2, -1, 0, 1, 2]);
    expect(parseWidgets([{ type: "sensitivity", field: "growth", steps: [500, 1] }], FIELDS)[0].steps).toEqual([-2, -1, 0, 1, 2]);
    expect(parseWidgets([{ type: "sensitivity", field: "growth", steps: [-3, 3, 0, 1.5] }], FIELDS)[0].steps).toEqual([-3, 0, 1.5, 3]);
  });
  it("leaves the widgets key off when there are none", () => {
    expect("widgets" in parseSuggestion('```json\n{"params":{"n":5}}\n```', FIELDS)).toBe(false);
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
    expect(p).toContain('"type":"sensitivity"');
    expect(p).toContain('"type":"peers"');
    expect(p).toContain('"type":"set"');
    expect(p).toContain("最多 2 个");
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

describe("valuation web search", () => {
  const searchBody = { messages: [{ role: "user", content: "给出假设；我持有 SECRET_HOLDING" }], context: CONTEXT, webSearch: true };
  it("adds public search excerpts to the model and returns separate bounded source metadata", async () => {
    const ck = await userCookie("search_success");
    fetchMock.get("https://api.tavily.com").intercept({ path: "/search", method: "POST" }).reply(200, (opts) => {
      expect(opts.headers.authorization).toBe("Bearer test-tavily-key");
      expect(opts.body).toContain("小米集团"); expect(opts.body).not.toContain("SECRET_HOLDING");
      return { results: [{ title: "Issuer report", url: "https://issuer.example/report", content: "REPORT_EXCERPT", published_date: "2026-03-20" }] };
    });
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
      const system = JSON.parse(opts.body).messages[0].content;
      expect(system).toContain("REPORT_EXCERPT"); expect(system).toContain("不可信数据");
      return { choices: [{ message: { content: "参考报告 [1]，仍需核对口径。" } }] };
    });
    const res = await post(ck, searchBody), j = await res.json();
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
    expect(j.research).toMatchObject({ status: "ok", sources: [{ id: 1, url: "https://issuer.example/report", publishedAt: "2026-03-20" }] });
    expect(j.research.sources[0]).not.toHaveProperty("excerpt");
  });
  it("reports search failure without pretending to have searched or calling the model", async () => {
    const ck = await userCookie("search_failure");
    fetchMock.get("https://api.tavily.com").intercept({ path: "/search", method: "POST" }).reply(429, { error: "do not echo upstream details" });
    const res = await post(ck, searchBody);
    expect(res.status).toBe(502); expect(await res.json()).toEqual({ error: "search_failed" });
  });
  it("records empty searches honestly and does not search before login/quota checks", async () => {
    expect((await post(null, searchBody)).status).toBe(401);
    const ck = await userCookie("search_empty");
    fetchMock.get("https://api.tavily.com").intercept({ path: "/search", method: "POST" }).reply(200, { results: [] });
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { choices: [{ message: { content: "未检索到相关资料。" } }] });
    expect((await (await post(ck, searchBody)).json()).research).toMatchObject({ status: "empty", sources: [] });
    const { id: uid } = await env.DB.prepare("SELECT id FROM users WHERE username='search_empty'").first();
    await env.DB.prepare("UPDATE settings SET value=? WHERE user_id=? AND key='_ai_usage'").bind(new Date().toISOString().slice(0, 10) + ":100", uid).run();
    expect((await post(ck, searchBody)).status).toBe(429);
    expect(validateChat({ ...searchBody, webSearch: "true" })).toBe("bad webSearch");
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
    expect(await r.json()).toEqual({ reply: "银行。", business: null, picks: [{ key: "pb", role: "primary", reason: "账面价值" }] });
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
    const withStory = buildMethodPrompt({ stock: { name: "小米集团" }, methods: METHODS, verified: V, thesis: { o: { story: "汽车业务带动利润率改善" } } }, "zh");
    expect(withStory).toContain("用户已写的场景叙事"); expect(withStory).toContain("汽车业务带动利润率改善");
    expect(mp).not.toContain("用户已写的场景叙事");
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
    expect(p).toContain("SOTP 分部结构由用户在参数页添加");
    const optionReview = buildReviewPrompt({...BODY, method: {key: 'options'}}, 'zh');
    expect(optionReview).toContain("欧式 Black–Scholes");
    expect(optionReview).toContain("不再扣债务");
    const p2 = buildReviewPrompt({ ...BODY, comparisons: ["targetPE（目标 PE）：当初 保守 18 / 乐观 25；当前倍数 20.0 → 落在两档之间"] }, "zh");
    expect(p2).toContain("假设对照");
    expect(p2).toContain("落在两档之间");
    expect(p).toContain("revenue（营收）");
    expect(p).toContain('"metric": "revenue"');
    const r = parseReview('```json\n{"overall":"watch","summary":"增速跌到保守假设以下","checks":[{"k":"growth","status":"broken","reason":"近三年复合 6.1% 低于保守 8%","metric":"revenue"},{"k":"nope","status":"ok"},{"k":"targetPE","status":"great"}]}\n```', FIELDS2);
    expect(r).toEqual({ overall: "watch", summary: "增速跌到保守假设以下", checks: [{ k: "growth", status: "broken", reason: "近三年复合 6.1% 低于保守 8%", metric: "revenue" }] });
    // 白名单以外的 metric（含原型链上的名字）丢掉，只留文字
    const r2 = parseReview('```json\n{"overall":"hold","checks":[{"k":"growth","status":"ok","reason":"a","metric":"peRatio"},{"k":"targetPE","status":"ok","reason":"b","metric":"constructor"}]}\n```', FIELDS2);
    expect(r2.checks).toEqual([{ k: "growth", status: "ok", reason: "a" }, { k: "targetPE", status: "ok", reason: "b" }]);
    expect(parseReview('```json\n{"overall":"fine"}\n```', FIELDS2)).toBeNull();
    expect(parseReview("没有代码块", FIELDS2)).toBeNull();
    expect(validateReviewReq({ ...BODY, result: {} })).toBeTruthy();
    expect(validateReviewReq({ ...BODY, metrics: "x" })).toBeTruthy();
    expect(validateReviewReq(BODY)).toBeNull();
  });
  it("scopes single-case reviews on the server and retains comparable evidence", async () => {
    const { buildReviewEvidence } = await import("../public/shared/valuation/review.js");
    const { buildReviewPrompt, validateReviewReq } = await import("../src/ai.js");
    const fields = [{ k: "margin", label: "净利率", meta: "netMargin", col: "dual", unit: "%", value: { c: 6.88, o: 999 } }];
    const evidence = buildReviewEvidence({ fields, scenarioMode: "single", financialsSource: "longbridge", financials: { IS: [{ field: "OperatingRevenue", values: [{ year: 2025, value: 100 }] }, { field: "NetProfit", values: [{ year: 2025, value: 6.878 }] }] } });
    const body = { ...BODY, fields, scenarioMode: "single", evidence, thesis: { c: { story: "当前主情景观点" }, o: { story: "OTHER_SCENARIO_SECRET" } }, result: { low: 130.72, high: 130.72 } };
    expect(validateReviewReq(body)).toBeNull();
    expect(validateReviewReq({ ...body, result: { low: 1, high: 2 } })).toBe("single value required");
    expect(validateReviewReq({ ...body, evidence: [{ ...evidence[0], k: "unknown" }] })).toBe("bad review evidence");
    const prompt = buildReviewPrompt(body, "zh");
    expect(prompt).not.toContain("OTHER_SCENARIO_SECRET");expect(prompt).not.toContain("999");
    expect(prompt).toContain("主情景 ·"); expect(prompt).toContain("按相同显示精度基本一致");
    expect(prompt).not.toContain("130.72 ~ 130.72");
    const ck = await userCookie("single_review_v2");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
      expect(JSON.parse(opts.body).messages[0].content).not.toContain("OTHER_SCENARIO_SECRET");
      return { choices: [{ message: { content: JSON.stringify({ overall: "broken", summary: "利润率失效", checks: [{ k: "margin", status: "broken", reason: "尾数低于假设", condition: "跟踪后续完整年度利润率" }] }) } }] };
    });
    const r = await SELF.fetch("https://x/api/my/ai/review", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    const result = (await r.json()).review;
    expect(result).toMatchObject({ version: 2, scenarioMode: "single", valuedAt: body.valuedAt, overall: "watch", evidence, checks: [{ k: "margin", status: "watch", condition: "跟踪后续完整年度利润率" }] });
  });
  it("returns the review from the provider with a timestamp", async () => {
    const ck = await userCookie("aiuser5");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { choices: [{ message: { content: '```json\n{"overall":"hold","summary":"假设仍成立","checks":[{"k":"growth","status":"ok","reason":"增速落在区间内"}]}\n```' } }] });
    const r = await SELF.fetch("https://x/api/my/ai/review", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(BODY) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.review).toMatchObject({ version: 2, scenarioMode: "range", overall: "watch", checks: [{ k: "growth", status: "watch" }] });
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
    expect(parsePicks('首选 **fcf**。\n```json\n{"picks":[{"key":"pb","reason":"**账面**"}]}\n```', METHODS)).toEqual({ reply: "首选 fcf。", business: null, picks: [{ key: "pb", role: "primary", reason: "账面" }] });
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
  it("drafts structured thesis fields and rejects incomplete model output", async () => {
    const { buildNotePrompt, parseThesis, validateNoteReq, buildReviewPrompt } = await import("../src/ai.js");
    const thesis = { c: { story: "海外业务增长", assessment: "需求待核实", drivers: "营收增长保守 10%", signals: "跟踪海外收入，数据不足时待验证" } };
    const body = { ...BODY, format: "thesis", scenario: "c", thesis };
    expect(validateNoteReq(body)).toBeNull();
    expect(validateNoteReq({ ...body, thesis: { story: 123 } })).toBe("bad thesis");
    expect(validateNoteReq({ ...body, thesis: { story: "x".repeat(801) } })).toBe("bad thesis");
    expect(validateNoteReq({ ...body, scenario: "both" })).toBe("scenario required");
    expect(buildNotePrompt(body, "zh")).toContain("用户已写的投资逻辑（保留观点）：保守场景 · 核心判断：海外业务增长");
    expect(parseThesis("```json\n" + JSON.stringify(thesis) + "\n```", "c")).toEqual(thesis);
    expect(parseThesis(JSON.stringify(thesis), "o")).toBeNull();
    expect(parseThesis('{"c":{"story":"partial"}}', "c")).toBeNull();
    expect(parseThesis("not JSON", "c")).toBeNull();
    const reviewPrompt = buildReviewPrompt({ stock: { name: "测试" }, method: { key: "pe" }, fields: CONTEXT.fields, result: { low: 1, high: 2 }, thesis }, "zh");
    expect(reviewPrompt).toContain("验证条件：跟踪海外收入");
    expect(reviewPrompt).toContain("待验证 / 数据不足");
    const ck = await userCookie("aiuser-thesis");
    for (const content of [JSON.stringify(thesis), '{"story":"partial"}']) {
      fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
        .reply(200, { choices: [{ message: { content } }] });
      const r = await SELF.fetch("https://x/api/my/ai/note", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(body) });
      expect(r.status).toBe(content.includes("partial") ? 502 : 200);
      if (r.ok) expect(await r.json()).toEqual({ thesis });
    }
  });
  it("allows story-first drafting without a model and isolates the selected case's inputs", async () => {
    const { buildNotePrompt, validateNoteReq, parseThesis, buildSystemPrompt } = await import("../src/ai.js");
    const first = { ...BODY, format: "thesis", scenario: "o", context: { ...CONTEXT, method: {}, fields: [] } };
    expect(validateNoteReq(first)).toBeNull();
    const prompt = buildNotePrompt(first, "zh");
    expect(prompt).toContain("先研究生意并形成定性叙事");
    expect(prompt).toContain("不能先看估值结果或现价再倒编叙事");
    const cases = { c: { story: "竞争激烈" }, o: { story: "新品放量" } };
    const translated = buildNotePrompt({ ...first, thesis: cases, context: { ...CONTEXT, fields: [{ k: "growth", col: "dual", value: { c: 7, o: 19 } }] } }, "zh");
    expect(translated).toContain("growth｜数字｜19");
    expect(translated).not.toContain("竞争激烈");
    expect(translated).toContain("新品放量");
    expect(buildSystemPrompt({ ...CONTEXT, thesis: cases }, "zh")).toContain("把每个叙事分别翻译成该场景");
    const complete = { story: "a", assessment: "b", drivers: "c", signals: "d" };
    expect(parseThesis(JSON.stringify({ c: complete, o: complete }), "c")).toEqual({ c: complete });
    expect(validateNoteReq({ ...first, thesis: { o: { story: 123 } } })).toBe("bad thesis");
    const ck = await userCookie("aiuser-story-first");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { choices: [{ message: { content: JSON.stringify({ o: complete }) } }] });
    const r = await SELF.fetch("https://x/api/my/ai/note", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(first) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ thesis: { o: complete } });
  });
  it("keeps evidence and causal impacts in guided drafts and rejects malformed mappings", async () => {
    const { buildNotePrompt, validateNoteReq, parseThesis, buildSystemPrompt } = await import("../src/ai.js");
    const thesis = { o: { story: "新品带动海外销售", evidence: "暂时没有依据", uncertainties: "复购情况待验证", impacts: [{ key: "growth", direction: "unknown", reason: "新品是否带来更多收入尚待验证" }], signals: "跟踪复购订单" } };
    const body = { ...BODY, format: "thesis", scenario: "o", thesis };
    expect(validateNoteReq(body)).toBeNull();
    expect(parseThesis(JSON.stringify(thesis), "o")).toEqual(thesis);
    expect(buildNotePrompt(body, "zh")).toContain("不能把叙事里的预期当成已验证的证据");
    expect(buildSystemPrompt({ ...CONTEXT, thesis }, "zh")).toContain("复购情况待验证");
    for (const impacts of ["not array", [{ key: "fake", direction: "up", reason: "x" }], [{ key: "growth", direction: "sure", reason: "x" }]]) {
      const bad = { o: { ...thesis.o, impacts } };
      expect(validateNoteReq({ ...body, thesis: bad })).toBe("bad thesis");
      expect(parseThesis(JSON.stringify(bad), "o")).toBeNull();
    }
    const ck = await userCookie("aiuser-guided-story");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, { choices: [{ message: { content: JSON.stringify(thesis) } }] });
    const response = await SELF.fetch("https://x/api/my/ai/note", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thesis });
  });
});

describe("optional company-specific thesis guide", () => {
  it("requests bounded JSON on Zhipu guides without changing other provider requests", async () => {
    for (const [baseUrl, structuredGuide] of [["https://open.bigmodel.cn/api/paas/v4", true], ["https://open.bigmodel.cn/api/paas/v4", false], ["https://other.test/v1", true]]) {
      const fakeFetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        if (baseUrl.includes("bigmodel.cn") && structuredGuide) {
          expect(body.response_format).toEqual({ type: "json_object" });
          expect(body.temperature).toBe(0.2);
        } else {
          expect(body.response_format).toBeUndefined();
          expect(body.temperature).toBeUndefined();
        }
        return Response.json({ choices: [{ message: { content: "{}" } }] });
      };
      expect(await chatComplete({}, "Return JSON", [{ role: "user", content: "Test" }], fakeFetch, { provider: "openai", baseUrl, model: "test", apiKey: "fixture", structuredGuide })).toBe("{}");
    }
  });
  const context = { stock: { name: "示例芯片公司", code: "DEMO" }, fields: [], business: ["业务描述：设计工业芯片，海外渠道仍在建设中。"], verified: ["2025 年海外收入占比 20%，来自测试财报。"] };
  const question = { type: "question", context: "公司正在建设海外芯片渠道，收入持续性仍需验证。", question: "你怎么看工业芯片海外渠道的发展？", selection: "single", options: [{ id: "a", label: "如果客户认可产品，海外收入会增长", detail: "场景假设，待验证" }, { id: "b", label: "渠道建设慢，增长有限" }] };
  const draft = { story: "海外工业芯片收入增长", evidence: "测试财报显示 2025 年海外收入占比 20%", uncertainties: "客户复购与投入效率待验证", impacts: [{ key: "growth", direction: "up", reason: "海外渠道可能增加销售" }, { key: "reinvestment", direction: "unknown", reason: "渠道投入效率未确定" }], signals: "建议跟踪复购和渠道费用，不设未确认的阈值" };
  const request = (cookie, body) => SELF.fetch("https://x/api/my/ai/thesis-guide", { method: "POST", headers: { ...J, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const body = { lang: "zh", scenario: "o", context, turns: [], thesis: { c: { story: "另一个场景的私有判断" } } };
  it("validates bounded turns, isolates the case and includes available company evidence", async () => {
    const { validateThesisGuide, buildThesisGuidePrompt, parseThesisGuide } = await import("../src/ai.js");
    expect(validateThesisGuide(body)).toBeNull();
    expect(validateThesisGuide({ ...body, scenario: "all" })).toBe("scenario required");
    expect(validateThesisGuide({ ...body, scenario: "both" })).toBeNull(); // 整条流程：两个场景一起问
    expect(validateThesisGuide({ ...body, turns: Array(4).fill({ question: "q", answer: "a" }) })).toBe("bad turns");
    expect(validateThesisGuide({ ...body, turns: [{ question: "q", answer: "" }] })).toBe("bad turns");
    expect(validateThesisGuide({ ...body, context: { fields: [] } })).toBe("stock required");
    const prompt = buildThesisGuidePrompt(body, "zh");
    expect(prompt).toContain("工业芯片"); expect(prompt).toContain("2025 年海外收入占比"); expect(prompt).toContain("乐观场景");
    expect(prompt).not.toContain("另一个场景的私有判断"); expect(prompt).toContain("不是你声称已经发生的事实");
    expect(buildThesisGuidePrompt({ ...body, context: { stock: context.stock } }, "en")).toContain("Insufficient company information");
    expect(buildThesisGuidePrompt(body, "en")).toContain("in English");
    expect(parseThesisGuide(JSON.stringify(question), 2).selection).toBe("multiple");
    expect(prompt).toContain("所有选项都必须是有利的方向");
    const conservative = buildThesisGuidePrompt({ ...body, scenario: "c" }, "zh");
    expect(conservative).toContain("所有选项都必须是不利或不及预期的方向"); expect(conservative).not.toContain("所有选项都必须是有利的方向");
    const summary = buildThesisGuidePrompt({ ...body, scenario: "c", turns: Array(3).fill({ question: "q", answer: "a" }) }, "zh");
    expect(summary).toContain("conflict"); expect(summary).toContain("与保守场景相反");
    expect(summary).toContain("conflict 必须是空字符串"); expect(summary).toContain("写进 uncertainties");
    const evidence = buildThesisGuidePrompt({ ...body, turns: [{ question: "q", answer: "a" }] }, "zh");
    expect(evidence).toContain("引用公司资料编号"); expect(evidence).toContain("反面证据");
  });
  it("runs the shared five-round flow and returns drafts for both cases", async () => {
    const { validateThesisGuide, buildThesisGuidePrompt, parseThesisGuide } = await import("../src/ai.js");
    const flow = { ...body, scenario: "both" };
    expect(validateThesisGuide({ ...flow, turns: Array(5).fill({ question: "q", answer: "a" }) })).toBeNull();
    expect(validateThesisGuide({ ...flow, turns: Array(6).fill({ question: "q", answer: "a" }) })).toBe("bad turns");
    const first = buildThesisGuidePrompt(flow, "zh");
    expect(first).toContain("没有提供数据，不等于数据为零或不存在");
    expect(buildThesisGuidePrompt(flow, "en")).toContain("FINAL OUTPUT REQUIREMENT");
    expect(first).toContain("两个场景共用的出发点"); expect(first).toContain("第 1/5 轮"); expect(first).toContain("另一个场景的私有判断"); // 两个场景的已有研究都要看到
    expect(buildThesisGuidePrompt({ ...flow, turns: [{ question: "q", answer: "a" }] }, "zh")).toContain("所有选项都必须是不利或不及预期的方向");
    expect(buildThesisGuidePrompt({ ...flow, turns: Array(2).fill({ question: "q", answer: "a" }) }, "zh")).toContain("所有选项都必须是有利的方向");
    const summary = buildThesisGuidePrompt({ ...flow, turns: Array(5).fill({ question: "q", answer: "a" }) }, "zh");
    expect(summary).toContain('"drafts"'); expect(summary).toContain("conflict");
    expect(parseThesisGuide(JSON.stringify(question), 2, true)).toMatchObject({ type: "question", question: question.question, selection: "single" });
    const both = parseThesisGuide(JSON.stringify({ type: "summary", drafts: { c: draft, o: draft, conflict: "保守那一轮偏乐观" } }), 5, true);
    expect(both.drafts.c.story).toBe(draft.story); expect(both.drafts.conflict).toBe("保守那一轮偏乐观");
    const noConflict = parseThesisGuide(JSON.stringify({ type: "summary", drafts: { c: draft, o: draft, conflict: "两轮回答没有明显冲突。" } }), 5, true);
    expect(noConflict.drafts).not.toHaveProperty("conflict"); expect(noConflict.drafts.c.story).toBe(draft.story);
    expect(parseThesisGuide(JSON.stringify({ type: "summary", drafts: { c: draft } }), 5, true)).toBeNull(); // 两份都要有
    expect(parseThesisGuide(JSON.stringify({ type: "summary", draft }), 5, true)).toBeNull();
  });
  it("drops conflict text that says there is no conflict and keeps the caveat as an uncertainty", async () => {
    const { parseThesisGuide, clearNoConflict } = await import("../src/ai.js");
    const base = { story: "iPhone 销量稳定", evidence: "暂无依据", uncertainties: "服务收入待验证", signals: "建议跟踪", impacts: [] };
    const parsed = parseThesisGuide(JSON.stringify({ type: "summary", draft: { ...base, conflict: "三项判断没有明显冲突。但 iPhone 销量稳定不等于全公司收入稳定。" } }), 3);
    expect(parsed.draft).not.toHaveProperty("conflict");
    expect(parsed.draft.uncertainties).toBe("服务收入待验证\niPhone 销量稳定不等于全公司收入稳定。");
    for (const text of ["无明显冲突", "未发现冲突。", "回答之间不存在矛盾", "No obvious conflict.", "There is no contradiction between the answers."]) expect(clearNoConflict({ ...base, conflict: text })).toEqual(base);
    for (const text of ["保守场景却判断增长加快", "回答偏乐观，与保守方向不一致", "Optimistic answers conflict with the conservative case"]) expect(clearNoConflict({ ...base, conflict: text }).conflict).toBe(text);
    expect(clearNoConflict({ ...base, uncertainties: "x".repeat(795), conflict: "没有冲突，但需要更多资料" })).toEqual({ ...base, uncertainties: "x".repeat(795) });
    expect(clearNoConflict(base)).toBe(base);
  });
  it("completes three contextual question rounds, accepts typed uncertainty and previews a bounded summary", async () => {
    const cookie = await userCookie("guided_three_rounds"); const turns = [];
    const answers = ["我更看好海外芯片渠道", "目前只有测试财报，还不清楚复购", "可能影响收入增长和渠道投入，方向还不确定"];
    for (let i = 0; i < 4; i++) {
      fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (options) => {
        const prompt = JSON.parse(options.body).messages[0].content;
        expect(prompt).toContain("示例芯片公司"); if (i) expect(prompt).toContain(answers[i - 1]);
        return { choices: [{ message: { content: JSON.stringify(i === 3 ? { type: "summary", draft: { ...draft, params: { growth: 100 } } } : { ...question, selection: i === 2 ? "multiple" : "single" }) } }] };
      });
      const response = await request(cookie, { ...body, turns }); const result = await response.json();
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(result.step).toBe(i); expect(result.references).toEqual([...context.business, ...context.verified]);
      if (i < 3) { expect(result.type).toBe("question"); turns.push({ question: result.question, answer: answers[i] }); }
      else { expect(result.type).toBe("summary"); expect(result.draft).toEqual(draft); expect(result.draft.params).toBeUndefined(); }
    }
  });
  it("rejects early summaries, incomplete UI and auth/quota failures without a pretend fallback", async () => {
    expect((await request(null, body)).status).toBe(401);
    const cookie = await userCookie("guided_recovery");
    expect((await request(cookie, { ...body, turns: "bad" })).status).toBe(400);
    for (const content of [{ type: "summary", draft }, { type: "html", html: "<script>bad</script>" }, { ...question, options: [] }]) {
      fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { choices: [{ message: { content: JSON.stringify(content) } }] });
      const response = await request(cookie, body); expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "bad_ai_output" });
    }
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(503, { error: { message: "temporary failure" } });
    expect((await request(cookie, body)).status).toBe(502);
    const { id } = await env.DB.prepare("SELECT id FROM users WHERE username='guided_recovery'").first();
    await env.DB.prepare("INSERT OR REPLACE INTO settings(user_id,key,value) VALUES(?,?,?)").bind(id, "_ai_usage", new Date().toISOString().slice(0, 10) + ":100").run();
    expect((await request(cookie, body)).status).toBe(429);
  });
});

describe("Jev guide evidence checks", () => {
  const context = { stock: { name: "Example", code: "EX" }, business: ["2025 net debt increased."], fields: [] };
  const question = { type: "question", context: "[1] Net debt increased.", question: "What changes?", selection: "single", options: [
    { id: "a", label: "If production grows, profits may rise." }, { id: "b", label: "[9] Cash flow is stable." },
  ] };
  const choice = (options, selected, p = 0.96) => ({ type: "choice", choice: selected, confidence: (p - 1 / options.length) / (1 - 1 / options.length), probabilities: Object.fromEntries(options.map((key) => [key, key === selected ? p : (1 - p) / (options.length - 1)])) });
  const answers = () => ({ kind_0: choice(["fact", "assumption", "mixed", "other"], "fact"), support_0: choice(["supported", "partial", "unsupported", "contradicted", "uncertain"], "partial"),
    kind_1: choice(["fact", "assumption", "mixed", "other"], "other"), kind_2: choice(["fact", "assumption", "mixed", "other"], "assumption"), kind_3: choice(["fact", "assumption", "mixed", "other"], "fact") });
  const request = (ck, turns = [], scenario = "both") => SELF.fetch("https://x/api/my/ai/thesis-guide", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify({ lang: "en", scenario, turns, context }) });
  async function configured(name) {
    const ck = await userCookie(name);
    await SELF.fetch("https://x/api/my/ai/jev", { method: "PUT", headers: { ...J, cookie: ck }, body: JSON.stringify({ apiKey: "fake-jev-guide-key" }) });
    return ck;
  }
  const llm = () => fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, { choices: [{ message: { content: JSON.stringify(question) } }] });

  it("checks numbered evidence separately from assumptions and never asks Jev to invent missing sources", async () => {
    const ck = await configured("jev-guide-evidence"); llm();
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(200, (opts) => {
      const body = JSON.parse(opts.body);
      expect(Object.keys(body.questions)).toHaveLength(5);
      expect(body.questions.support_3).toBeUndefined();
      expect(body.questions.support_0.instructions).toContain("years, units, scope");
      expect(body.state.supplied_sources).toEqual({ 1: context.business[0] });
      expect(body.state.passages.passage_3.citations).toEqual([9]);
      expect(opts.body).not.toContain("fake-jev-guide-key");
      return { answers: answers() };
    });
    const res = await request(ck); expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.context).toBe(question.context);
    expect(result.audit).toMatchObject({ status: "used", items: [
      { path: "context", kind: "fact", support: "partial" }, { path: "question", kind: "other", support: "not_applicable" },
      { path: "options.0.label", kind: "assumption", support: "not_applicable" }, { path: "options.1.label", support: "missing_source" },
    ] });
  });
  it("routes low confidence to uncertainty rather than claiming support", async () => {
    const ck = await configured("jev-guide-uncertain"); llm();
    const a = answers(); a.support_0 = choice(["supported", "partial", "unsupported", "contradicted", "uncertain"], "supported", 0.25);
    a.kind_0 = choice(["fact", "assumption", "mixed", "other"], "fact", 0.3);
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(200, { answers: a });
    expect((await (await request(ck)).json()).audit.items[0]).toMatchObject({ kind: "uncertain", support: "uncertain" });
  });
  it("preserves usable guide content on provider errors and malformed distributions", async () => {
    const ck = await configured("jev-guide-failure");
    for (const [status, response] of [[401, { error: "fake-jev-guide-key" }], [200, { answers: { ...answers(), support_0: { type: "choice", choice: "supported", confidence: 1, probabilities: { supported: 1 } } } }]]) {
      llm();
      fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(status, response);
      const res = await request(ck); expect(res.status).toBe(200);
      const result = await res.json();
      expect(result.options).toEqual(question.options.map((option) => ({ ...option, detail: "" })));
      expect(result.audit.status).toBe("unavailable");
      expect(result.audit.items[0].support).toBe("unchecked");
      expect(result.audit.items[3].support).toBe("missing_source");
      expect(JSON.stringify(result)).not.toContain("fake-jev-guide-key");
    }
  });
  it("checks missing citation numbers without a key or external Jev call", async () => {
    const ck = await userCookie("jev-guide-no-key"); llm();
    const result = await (await request(ck)).json();
    expect(result.audit.status).toBe("not_configured");
    expect(result.audit.items[3].support).toBe("missing_source");
  });
  it("shares the audit request with coverage routing and identifies the exact prior answer", async () => {
    const ck = await configured("jev-guide-reuse"); llm();
    const turns = [{ question: "What if debt costs rise?", answer: "In the conservative case, higher interest costs could offset production growth. I accept this financing risk." }];
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(200, (opts) => {
      const body = JSON.parse(opts.body);
      expect(Object.keys(body.questions)).toHaveLength(7);
      expect(body.state.guide_routing.current).toBe("downside");
      expect(body.state.guide_routing.previous[0].answer).toBe(turns[0].answer);
      expect(body.questions.answer_coverage.instructions).toContain("unselected options are NOT answers");
      return { answers: { ...answers(), answer_coverage: choice(Object.keys(body.questions.answer_coverage.criteria), "covered_turn_0"), followup_need: choice(Object.keys(body.questions.followup_need.criteria), "accepted_risk") } };
    });
    const res = await request(ck, turns); expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.audit.routing).toMatchObject({ status: "used", coverage: "covered", matchedTurn: 0, followup: "accepted_risk", snapshot: { turns, scenario: "both" } });
    expect(result.audit.status).toBe("used");
    expect(result.options.map((o) => o.id)).toEqual(["a", "b"]);
  });
  it("preserves citation checks if routing is malformed, and ordinary answering if no key exists", async () => {
    const turns = [{ question: "What changes?", answer: "Production might grow; costs remain unknown." }];
    const ck = await configured("jev-routing-bad"); llm();
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(200, { answers: { ...answers(), answer_coverage: { type: "choice", choice: "covered_turn_99", confidence: 1, probabilities: {} } } });
    const result = await (await request(ck, turns)).json();
    expect(result.audit).toMatchObject({ status: "used", routing: { status: "unavailable", matchedTurn: null } });
    expect(result.audit.items[0].support).toBe("partial");
    const unconfigured = await userCookie("jev-routing-no-key"); llm();
    expect((await (await request(unconfigured, turns)).json()).audit.routing).toMatchObject({ status: "not_configured", matchedTurn: null });
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
    expect(p).toContain("netDebt（净负债）");
    expect(p).toContain("不要为了配图硬选");
    // 老格式：纯字符串照收，统一成 {text}
    expect(parseBrief('```json\n{"points":["**a**","b","c","d"],"risks":["r1","r2","r3"]}\n```')).toEqual({ points: [{ text: "a" }, { text: "b" }, { text: "c" }], risks: [{ text: "r1" }, { text: "r2" }] });
    // 新格式：带白名单 metric；未知 / 非字符串 metric 丢掉；空文字整条丢掉
    expect(parseBrief('```json\n{"points":[{"text":"ROE 稳定在 20% 左右","metric":"roe"},{"text":"营收复合 8%","metric":"pe"},"现金充裕",{"text":"  ","metric":"fcf"}],"risks":[{"text":"净负债上升","metric":"netDebt"},{"text":"x","metric":["roe"]}]}\n```'))
      .toEqual({ points: [{ text: "ROE 稳定在 20% 左右", metric: "roe" }, { text: "营收复合 8%" }, { text: "现金充裕" }], risks: [{ text: "净负债上升", metric: "netDebt" }, { text: "x" }] });
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
    expect(j.brief).toMatchObject({ points: [{ text: "现金流十年为正" }, { text: "增速放缓到 7%" }, { text: "净现金" }], risks: [{ text: "增速放缓" }] });
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
    expect(p).toContain("不能把资源股 NAV 当作通用 SOTP");
    expect(p).toContain("未开发储量 Black–Scholes 组件");
    expect(p).toContain("PEG = PE ÷ 预期盈利增速百分数");
    expect(p).toContain("P/S 与 P/GMV 直接得到股权价值");
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

describe("site-key free models (Zhipu GLM-4.7-Flash)", () => {
  it("lists GLM only when the site has a key and turns off Zhipu's thinking mode", async () => {
    const { siteKeyModels, SITE_KEY_MODELS, chatComplete } = await import("../src/ai.js");
    expect(siteKeyModels({})).toEqual([]);
    expect(siteKeyModels({ ZHIPU_API_KEY: "k" }).map((m) => m.model)).toEqual(["glm-4.7-flash"]);
    let sent = null;
    const fetchImpl = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: "好的" } }] })); };
    await chatComplete({}, "sys", [{ role: "user", content: "hi" }], fetchImpl, { provider: "openai", model: "glm-4.7-flash", baseUrl: SITE_KEY_MODELS[0].baseUrl, apiKey: "zk" });
    expect(sent.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(sent.body.thinking).toEqual({ type: "disabled" });
    await chatComplete({}, "sys", [{ role: "user", content: "hi" }], fetchImpl, { provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" });
    expect(sent.body.thinking).toBeUndefined();
  });
  it("retries Zhipu's busy responses", async () => {
    const { SITE_KEY_MODELS, chatComplete } = await import("../src/ai.js");
    let n = 0;
    const fetchImpl = async () => (++n < 3 ? new Response(JSON.stringify({ error: { code: "1305", message: "该模型当前访问量过大，请您稍后再试" } }), { status: 429 })
      : new Response(JSON.stringify({ choices: [{ message: { content: "好的" } }] })));
    expect(await chatComplete({}, "sys", [{ role: "user", content: "hi" }], fetchImpl, { provider: "openai", model: "glm-4.7-flash", baseUrl: SITE_KEY_MODELS[0].baseUrl, apiKey: "zk" })).toBe("好的");
    expect(n).toBe(3);
  }, 15000);
});

describe("scenario analysis in the chat", () => {
  const F = [{ k: "growth", label: "营收增速", col: "dual", unit: "%", value: { c: 10, o: 10 }, isDefault: true }, { k: "n", label: "年数", col: "single", value: 10 }];
  it("asks for per-scenario analysis anchored to actuals and flags method defaults", async () => {
    const { buildSystemPrompt } = await import("../src/ai.js");
    const p = buildSystemPrompt({ stock: { name: "腾讯" }, method: { key: "fcff" }, fields: F, metrics: ["营收增速：近三年复合 +8.6%"], business: ["所属行业：互联网"] }, "zh");
    expect(p).toContain('"scenarios": {"c": {"story"');
    expect(p).toContain("（方法默认值，还没按这家公司调整）");
    expect(p).toContain("最新实际数据与历史区间");
    expect(p).toContain("生意本身（公司简介与收入构成）");
    expect(p).toContain("scenarios 里提到的每个假设值必须和 params 里的完全一致");
  });
  it("parses scenarios, salvages truncated JSON and puts misplaced fields back", async () => {
    const { parseSuggestion } = await import("../src/ai.js");
    const t = '结论一句。\n\n``json\n{"params": {"n": 10, "growth": {"c": 8, "o": 12}}, "scenarios": {"c": {"story": "稳住", "drivers": ["增速 8%"]}, "o": {"story": "AI 驱动", "drivers": ["增速 12%"]}, "breaks": "宏观不好", "signals": "广告增速"}}, "widgets":';
    const r = parseSuggestion(t, F);
    expect(r.reply).toBe("结论一句。");
    expect(r.params).toEqual({ n: 10, growth: { c: 8, o: 12 } });
    expect(r.scenarios).toEqual({ c: { story: "稳住", drivers: ["增速 8%"], breaks: "", signals: "" }, o: { story: "AI 驱动", drivers: ["增速 12%"], breaks: "宏观不好", signals: "广告增速" } });
    expect(parseSuggestion('```json\n{"params": {"growth": {"c": 8, "o": 12}}, "scenarios": {"c": {"story": "稳住", "drivers": ["增速 8%", "利润率 2', F).scenarios.c.drivers).toEqual(["增速 8%"]);
    expect(parseSuggestion("只是聊聊", F).params).toBeNull();
  });
});

describe("Jev credentials", () => {
  const request = (cookie, method = "GET", body) => SELF.fetch("https://x/api/my/ai/jev", {
    method, headers: { ...J, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  it("requires login and keeps encrypted keys private and isolated by user", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) expect((await request(null, method, method === "PUT" ? { apiKey: "fake-key" } : undefined)).status).toBe(401);
    const ck = await userCookie("jev-owner"), other = await userCookie("jev-other");
    expect(await (await request(ck)).json()).toEqual({ configured: false });
    for (const apiKey of ["", "a b", "x".repeat(501), 123, "a\u0000b"]) expect((await request(ck, "PUT", { apiKey })).status).toBe(400);
    const key = "fake-jev-key-12345";
    const saved = await request(ck, "PUT", { apiKey: key });
    expect(saved.status).toBe(200); expect(await saved.text()).not.toContain(key);
    const uid = (await env.DB.prepare("SELECT id FROM users WHERE username=?").bind("jev-owner").first()).id;
    const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key='_jev_key'").bind(uid).first();
    expect(row.value).not.toContain(key);
    const { readJevKey } = await import("../src/jev.js");
    expect(await readJevKey(env, uid)).toBe(key);
    const status = await request(ck);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({ configured: true });
    for (const url of ["/api/my/settings", "/api/my/ai/models"]) {
      const response = await SELF.fetch("https://x" + url, { headers: { cookie: ck } });
      const text = await response.text(); expect(text).not.toContain(key); expect(text).not.toContain(row.value);
    }
    expect(await (await request(other)).json()).toEqual({ configured: false });
    await request(other, "DELETE");
    expect(await (await request(ck)).json()).toEqual({ configured: true });
    await request(ck, "PUT", { apiKey: "replacement-key" });
    expect(await readJevKey(env, uid)).toBe("replacement-key");
    await request(ck, "DELETE");
    expect(await readJevKey(env, uid)).toBeNull();
  });
});

describe("Jev method decisions", () => {
  const FIT = ["suitable", "uncertain", "unsuitable"];
  const TYPES = ["cyclical", "financial", "utility", "stalwart", "fast_grower", "unprofitable", "asset_play", "platform", "unknown"];
  const choice = (options, selected, p = 0.95) => ({ type: "choice", choice: selected, confidence: (p - 1 / options.length) / (1 - 1 / options.length), probabilities: Object.fromEntries(options.map((key) => [key, key === selected ? p : (1 - p) / (options.length - 1)])) });
  const body = { lang: "zh", stock: { name: "Example", code: "EX" }, methods: [{ key: "fcff", title: "FCFF" }, { key: "pe", title: "P/E" }], facts: { sharesOutstanding: 100 }, thesis: { c: { story: "产量增长但商品价格下跌" }, o: { story: "产量增长带动营收和利润" } } };
  const answers = () => ({ business_type: choice(TYPES, "cyclical"), fcff_business: choice(FIT, "suitable"), fcff_story: choice(FIT, "suitable"), pe_business: choice(FIT, "suitable", 0.8), pe_story: choice(FIT, "uncertain", 0.8) });
  const request = (ck, value = body) => SELF.fetch("https://x/api/my/ai/method", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(value) });
  async function configured(name) {
    const ck = await userCookie(name);
    await SELF.fetch("https://x/api/my/ai/jev", { method: "PUT", headers: { ...J, cookie: ck }, body: JSON.stringify({ apiKey: "fake-jev-decision-key" }) });
    return ck;
  }
  const mockJev = (a, check = () => true) => fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST", body: check })
    .reply(200, { model: "jev-1.14.0", answers: a });
  const mockLlm = (picks = [{ key: "fcff", reason: "现金流驱动" }, { key: "pe", reason: "正常化盈利交叉验证" }]) => fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: '```json\n' + JSON.stringify({ summary: "按业务与叙事选方法。", picks }) + '\n```' } }] });

  it("ranks on fit, keeps a first choice with missing data, and sends only named closed questions", async () => {
    const ck = await configured("jev-ranking");
    mockJev(answers(), (raw) => {
      const j = JSON.parse(raw);
      expect(j.model).toBe("jev-1.14.0");
      expect(Object.keys(j.questions)).toHaveLength(5);
      expect(j.questions.fcff_business.instructions).toContain("Missing numerical inputs do NOT");
      expect(j.state.user_assumptions.c.story).toContain("商品价格");
      expect(raw).not.toContain("fake-jev-decision-key");
      return true;
    });
    mockLlm();
    const r = await request(ck); expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.decision).toMatchObject({ engine: "jev", status: "used", classification: { type: "cyclical", needsReview: false } });
    expect(j.picks[0]).toMatchObject({ key: "fcff", role: "primary", readiness: { status: "needs_data" } });
    expect(j.picks[0].readiness.missingInputs.map((x) => x.key)).toContain("revenue");
    expect(j.picks[1].suitability).toBe("needs_review");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("does not let the explanation model reorder Jev's choices", async () => {
    const ck = await configured("jev-explanation"); mockJev(answers()); mockLlm([{ key: "pe", reason: "改选PE" }]);
    const j = await (await request(ck)).json();
    expect(j.picks.map((p) => p.key)).toEqual(["fcff", "pe"]);
    expect(j.picks[0].reason).not.toContain("改选");
  });
  it("uses structured explanations when the text model is unavailable", async () => {
    const ck = await configured("jev-text-failure"); mockJev(answers());
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(503, { error: "busy" });
    const r = await request(ck); expect(r.status).toBe(200);
    expect((await r.json()).decision.engine).toBe("jev");
  });
  it("falls back honestly on invalid credentials or malformed answers without exposing upstream text", async () => {
    const ck = await configured("jev-fallback");
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(401, { error: "fake-jev-decision-key" });
    mockLlm();
    const first = await (await request(ck)).json();
    expect(first.decision).toEqual({ engine: "llm", status: "fallback", reason: "invalid_credentials" });
    expect(JSON.stringify(first)).not.toContain("fake-jev-decision-key");
    const a = answers(); a.fcff_business.probabilities.suitable = 7;
    mockJev(a); mockLlm();
    expect((await (await request(ck)).json()).decision.reason).toBe("invalid_response");
  });
  it("marks uncertain classification for review and excludes a confidently unsuitable method", async () => {
    const ck = await configured("jev-uncertain");
    const a = answers(); a.business_type = choice(TYPES, "unknown", 0.5); a.fcff_business = choice(FIT, "unsuitable");
    mockJev(a); mockLlm([{ key: "pe", reason: "有条件使用" }]);
    const j = await (await request(ck)).json();
    expect(j.decision.classification).toMatchObject({ type: null, needsReview: true });
    expect(j.picks.map((p) => p.key)).toEqual(["pe"]);
  });
  it("applies business constraints even if a method-fit answer ranks a conflicting method highly", async () => {
    const ck = await configured("jev-bank-guard");
    const a = answers(); a.business_type = choice(TYPES, "financial");
    mockJev(a); mockLlm([{ key: "pe", reason: "盈利交叉验证" }]);
    const j = await (await request(ck)).json();
    expect(j.picks.map((p) => p.key)).toEqual(["pe"]); // FCFF is not an appropriate bank valuation method
  });
  it("keeps the original recommendation usable when Jev has a connection failure", async () => {
    const ck = await configured("jev-network-fallback");
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).replyWithError(new Error("connection unavailable"));
    mockLlm();
    const r = await request(ck); expect(r.status).toBe(200);
    expect((await r.json()).decision).toEqual({ engine: "llm", status: "fallback", reason: "unavailable" });
  });
  it("tests the saved key using a fixed public example, without model chat or company data", async () => {
    const ck = await configured("jev-connection");
    mockJev({ sector: choice(["financial", "other"], "financial") }, (raw) => { expect(JSON.parse(raw).state.company).toBe("Example"); return true; });
    const r = await SELF.fetch("https://x/api/my/ai/jev/test", { method: "POST", headers: { cookie: ck } });
    expect(await r.json()).toEqual({ ok: true, model: "jev-1.14.0" });
  });
});

describe("driver-based narrative guide", () => {
  const context = { stock: { name: "Example Miner", code: "MIN" }, fields: [], business: ["Gold and copper mine sales; production expansion planned."], verified: [] };
  const question = { type: "question", context: "[1] Gold sales are evidenced.", question: "How do you expect gold prices to change?", selection: "single", options: [{ id: "a", label: "Weaker" }, { id: "b", label: "Stronger" }] };
  const base = { lang: "en", scenario: "both", guideMode: "drivers", context, turns: [] };
  const request = (cookie, body = base) => SELF.fetch("https://x/api/my/ai/thesis-guide", { method: "POST", headers: { ...J, cookie }, body: JSON.stringify(body) });
  const llm = (content, check = () => {}) => fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
    check(JSON.parse(opts.body)); return { choices: [{ message: { content: JSON.stringify(content) } }] };
  });
  it("returns an explicit generic fallback without a Jev key and preserves single judgments", async () => {
    const cookie = await userCookie("driver_no_key");
    llm({ ...question, selection: "multiple" }, (body) => {
      const prompt = body.messages[0].content;
      expect(prompt).toContain("demand"); expect(prompt).toContain("永续增速"); expect(prompt).toContain("一个选项只代表一个判断");
    });
    const res = await request(cookie); expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: "question", selection: "single", guideMode: "drivers", driverPlan: { version: 1, status: "not_configured", keys: ["demand", "margin", "reinvestment"] } });
  });
  it("uses Jev's closed rankings before writing the first question, then audits separately", async () => {
    const cookie = await userCookie("driver_ranked");
    await SELF.fetch("https://x/api/my/ai/jev", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ apiKey: "fake-driver-key" }) });
    const options = ["core", "secondary", "negligible", "insufficient"];
    const answer = (choice, p) => ({ type: "choice", choice, confidence: 0.8, probabilities: Object.fromEntries(options.map((key) => [key, key === choice ? p : (1 - p) / 3])) });
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(200, (opts) => {
      const body = JSON.parse(opts.body);
      expect(Object.keys(body.questions)).toContain("gold_price"); expect(body.state.supplied_business).toEqual(context.business);
      const scores = { gold_price: 0.98, copper_price: 0.96, capacity: 0.94, reinvestment: 0.92 };
      return { answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, answer(scores[key] ? "core" : "negligible", scores[key] || 0.9)])) };
    });
    llm(question, (body) => expect(body.messages[0].content).toContain("本轮只问变量 gold_price"));
    // Failed evidence audit must not discard a successfully selected plan or fabricate support.
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(503, {});
    const res = await request(cookie); expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ driverPlan: { status: "used", keys: ["gold_price", "copper_price", "capacity", "reinvestment"] }, audit: { status: "unavailable" } });
  });
  it("summarizes at the selected plan length and requires confirmation of new case conditions", async () => {
    const cookie = await userCookie("driver_summary");
    const driverPlan = { version: 1, status: "not_configured", keys: ["demand", "margin", "reinvestment"] };
    const draft = { story: "Conditional case", evidence: "No evidence", uncertainties: "Proposed conditions need confirmation", impacts: [], signals: "Suggested observation" };
    llm({ type: "summary", drafts: { c: draft, o: draft } }, (body) => {
      expect(body.messages[0].content).toContain("建议情景，待你确认"); expect(body.messages[0].content).not.toContain("本轮只问变量");
    });
    const res = await request(cookie, { ...base, driverPlan, turns: Array(3).fill({ question: "A driver?", answer: "My assumption" }) });
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ type: "summary", drafts: { c: draft, o: draft }, driverPlan });
    // No plan reselection or network call is permitted for malformed client plans.
    for (const body of [{ ...base, turns: [{ question: "q", answer: "a" }] }, { ...base, driverPlan: { ...driverPlan, keys: ["unknown", "margin", "reinvestment"] } }, { ...base, driverPlan, turns: Array(4).fill({ question: "q", answer: "a" }) }]) expect((await request(cookie, body)).status).toBe(400);
  });
  it("keeps the persisted driver order for subsequent questions", async () => {
    const cookie = await userCookie("driver_resume");
    const driverPlan = { version: 1, status: "used", keys: ["gold_price", "copper_price", "capacity"] };
    llm(question, (body) => expect(body.messages[0].content).toContain("本轮只问变量 copper_price"));
    const res = await request(cookie, { ...base, driverPlan, turns: [{ question: "Gold prices?", answer: "Stronger" }] });
    expect(res.status).toBe(200); expect((await res.json()).driverPlan).toEqual(driverPlan);
  });
  it("falls back explicitly when Jev returns a malformed driver distribution", async () => {
    const cookie = await userCookie("driver_bad_output");
    await SELF.fetch("https://x/api/my/ai/jev", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ apiKey: "fake-driver-key" }) });
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(200, { answers: {} });
    llm(question);
    fetchMock.get("https://api.typesafe.ai").intercept({ path: "/v1/systemone", method: "POST" }).reply(503, {});
    const res = await request(cookie); expect(res.status).toBe(200);
    expect((await res.json()).driverPlan).toEqual({ version: 1, status: "unavailable", keys: ["demand", "margin", "reinvestment"] });
  });
  it("rejects exhausted quota before any Jev routing request", async () => {
    const cookie = await userCookie("driver_quota");
    await SELF.fetch("https://x/api/my/ai/jev", { method: "PUT", headers: { ...J, cookie }, body: JSON.stringify({ apiKey: "fake-driver-key" }) });
    const { id } = await env.DB.prepare("SELECT id FROM users WHERE username='driver_quota'").first();
    await env.DB.prepare("INSERT OR REPLACE INTO settings(user_id,key,value) VALUES(?,?,?)").bind(id, "_ai_usage", new Date().toISOString().slice(0, 10) + ":100").run();
    expect((await request(cookie)).status).toBe(429);
  });
});

describe("sequential case API boundaries", () => {
  const context = { stock: { name: "Scenario fixture", code: "TEST" }, fields: [], business: ["Public fixture revenue data"], verified: [] };
  const plan = { version: 1, status: "uncertain", keys: ["demand", "margin", "reinvestment", "financing"] };
  const draft = { story: "This case only", evidence: "No evidence", uncertainties: "Unverified", signals: "Suggested observation", impacts: [] };
  it("keeps a single main case neutral in guide and parameter requests", async () => {
    const { validateThesisGuide, buildDriverGuidePrompt } = await import("../src/ai.js");
    const body = { lang: "zh", scenario: "c", singleCase: true, guideMode: "drivers", driverPlan: plan, turns: [], context };
    expect(validateThesisGuide(body)).toBeNull();
    expect(validateThesisGuide({ ...body, scenario: "o" })).toBe("bad single case");
    expect(buildDriverGuidePrompt(body, "zh")).toContain("不强制向弱或强的方向引导");
    const ck = await userCookie("main_case_params");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
      expect(JSON.parse(opts.body).messages[0].content).toContain("不把它改成保守预测");
      return { choices: [{ message: { content: '```json\n{"params":{"growth":{"c":9,"o":99}}}\n```' } }] };
    });
    const res = await SELF.fetch("https://x/api/my/ai/valuation", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify({ lang: "zh", messages: [{ role: "user", content: "主情景参数" }], context: { ...CONTEXT, scenario: "c", singleCase: true } }) });
    expect(res.status).toBe(200); expect((await res.json()).params).toEqual({ growth: { c: 9 } });
  });
  it("supports four driver answers for either case and summarizes only that case", async () => {
    const { validateThesisGuide, buildDriverGuidePrompt } = await import("../src/ai.js");
    for (const scenario of ["c", "o"]) {
      const body = { lang: "en", scenario, guideMode: "drivers", driverPlan: plan, turns: Array(4).fill({ question: "Driver?", answer: "My case judgment" }), context,
        thesis: { c: { ...draft, story: scenario === "c" ? "CURRENT" : "OTHER_CASE_SECRET" }, o: { ...draft, story: scenario === "o" ? "CURRENT" : "OTHER_CASE_SECRET" } } };
      expect(validateThesisGuide(body)).toBeNull();
      expect(buildDriverGuidePrompt(body, "en")).not.toContain("OTHER_CASE_SECRET");
      const ck = await userCookie("single_guide_" + scenario);
      fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
        expect(JSON.parse(opts.body).messages[0].content).toContain("单情景规则");
        return { choices: [{ message: { content: JSON.stringify({ type: "summary", draft }) } }] };
      });
      const response = await SELF.fetch("https://x/api/my/ai/thesis-guide", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(body) });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ type: "summary", draft, driverPlan: plan });
    }
  });
  it("strips the other case and target range before parameter suggestions and ignores attempts to change it", async () => {
    const ck = await userCookie("single_params_o");
    fetchMock.get("https://llm.test").intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, (opts) => {
      const prompt = JSON.parse(opts.body).messages[0].content;
      expect(prompt).not.toContain("OTHER_CASE_SECRET"); expect(prompt).not.toContain("TARGET_RANGE_SECRET");
      expect(prompt).toContain("只建议 乐观");
      return { choices: [{ message: { content: '```json\n{"params":{"growth":{"c":999,"o":18},"n":50},"reasons":{"growth":"Current case only"}}\n```' } }] };
    });
    const response = await SELF.fetch("https://x/api/my/ai/valuation", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify({ lang: "en", messages: [{ role: "user", content: "Suggest current inputs" }],
      context: { ...CONTEXT, scenario: "o", thesis: { c: { ...draft, story: "OTHER_CASE_SECRET" }, o: draft }, facts: { revenue: 100, currentConclusion: "TARGET_RANGE_SECRET" } } }) });
    expect(response.status).toBe(200); expect((await response.json()).params).toEqual({ growth: { o: 18 } });
  });
  it("parses partial suggestions without requiring or inventing a counterpart", () => {
    expect(parseSuggestion('```json\n{"params":{"growth":{"c":5},"wacc":{"o":9},"n":7}}\n```', FIELDS, "c").params).toEqual({ growth: { c: 5 }, n: 7 });
    expect(parseSuggestion('```json\n{"params":{"growth":{"c":5},"wacc":{"o":9},"n":7}}\n```', FIELDS, "o").params).toEqual({ wacc: { o: 9 } });
  });
});

describe("extended model AI context", () => {
 it("accepts large SOTP structures and limits shared facts to each case", async () => {
  const { MODELS, modeFields } = await import("../public/shared/valuation/index.js");
  const parts=Array.from({length:12},(_,i)=>({id:"p"+i,name:"Business "+i,method:"apv"}));
  const fields=modeFields(MODELS.find(m=>m.key==="sotp"),null,{_parts:parts}).map(f=>({...f,value:f.col==="dual"?{c:1,o:2}:1}));
  const context={stock:{name:"Example diversified group"},method:{key:"sotp"},fields};
  expect(fields.length).toBeGreaterThan(160);
  expect(validateChat({context,messages:[{role:"user",content:"Review this model"}]})).toBeNull();
  const prompt=buildSystemPrompt(context,"zh");
  expect(prompt).toContain("只扣未分配的集团净负债");
  expect(prompt).toContain("不得把集团收入或利润填到每个分部");
  const p=model => buildSystemPrompt({...context,method:{key:model},fields:fields.slice(0,1)},"zh");
  expect(p("options")).toContain("困境股权模式直接");
  expect(p("apv")).toContain("偿债期结束后不再产生税盾");
 });
});
