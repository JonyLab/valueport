// 估值工作台的 AI 助手：和用户聊估值假设，回复末尾附一个 ```json 代码块给出建议参数，前端预览后一键应用。
// 不依赖各家的原生 tool calling（Workers AI 开源模型支持参差），统一用「约定格式的 JSON 代码块」，三种协议通用。
//
// 模型服务（站点级配置，wrangler.toml [vars] / secret）：
//   AI_PROVIDER  workers-ai（默认，用 [ai] 绑定，无需 Key）| openai（OpenAI 兼容协议）| anthropic
//   AI_MODEL     模型名；不填按协议取默认
//   AI_BASE_URL  openai / anthropic 协议的接口地址（可指向任意兼容服务）
//   AI_API_KEY   openai / anthropic 协议的 Key（secret）

const DEFAULTS = {
  "workers-ai": { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
  anthropic: { model: "claude-sonnet-5-5", baseUrl: "https://api.anthropic.com" },
};
const MAX_TOKENS = 1500;

export function aiConfig(env) {
  const provider = (env.AI_PROVIDER || "workers-ai").trim().toLowerCase();
  const d = DEFAULTS[provider];
  if (!d) throw new Error(`unknown AI_PROVIDER: ${provider}`);
  return { provider, model: env.AI_MODEL || d.model, baseUrl: (env.AI_BASE_URL || d.baseUrl || "").replace(/\/+$/, ""), apiKey: env.AI_API_KEY || "" };
}

// messages: [{ role: "user"|"assistant", content }]；返回模型回复文本
export async function chatComplete(env, system, messages, fetchImpl = fetch) {
  const cfg = aiConfig(env);
  if (cfg.provider === "workers-ai") {
    if (!env.AI || typeof env.AI.run !== "function") throw new Error("Workers AI binding (AI) is not configured");
    const out = await env.AI.run(cfg.model, { messages: [{ role: "system", content: system }, ...messages], max_tokens: MAX_TOKENS });
    // 老模型返回 { response }，新模型可能返回 OpenAI 形状
    const text = out && (typeof out.response === "string" ? out.response
      : out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content);
    if (typeof text !== "string") throw new Error("empty AI response");
    return text;
  }
  if (!cfg.apiKey) throw new Error("AI_API_KEY is not configured");
  if (cfg.provider === "openai") {
    const res = await fetchImpl(cfg.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, max_tokens: MAX_TOKENS, messages: [{ role: "system", content: system }, ...messages] }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error((j && j.error && j.error.message) || `AI HTTP ${res.status}`);
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== "string") throw new Error("empty AI response");
    return text;
  }
  // anthropic
  const res = await fetchImpl(cfg.baseUrl + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: cfg.model, max_tokens: MAX_TOKENS, system, messages }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error((j && j.error && j.error.message) || `AI HTTP ${res.status}`);
  const text = j && Array.isArray(j.content) ? j.content.filter((b) => b.type === "text").map((b) => b.text).join("") : null;
  if (typeof text !== "string" || !text) throw new Error("empty AI response");
  return text;
}

// ── 请求校验 ──
const MAX_MSGS = 20, MAX_CHARS = 4000;
export function validateChat(body) {
  if (!body || typeof body !== "object") return "bad body";
  const { messages, context } = body;
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MSGS) return "messages must be 1-20 items";
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim() || m.content.length > MAX_CHARS) return "bad message";
  }
  if (messages[messages.length - 1].role !== "user") return "last message must be from user";
  if (!context || typeof context !== "object" || !Array.isArray(context.fields) || !context.fields.length || context.fields.length > 40) return "context.fields required";
  for (const f of context.fields) if (!f || typeof f.k !== "string" || (f.col !== "single" && f.col !== "dual")) return "bad field";
  if (JSON.stringify(context).length > 20000) return "context too large";
  return null;
}

// ── 提示词 ──
const fmtVal = (v) => (v && typeof v === "object") ? `保守 ${num(v.c)} / 乐观 ${num(v.o)}` : num(v);
const num = (n) => (typeof n === "number" && Number.isFinite(n)) ? String(n) : "（空）";

export function buildSystemPrompt(context, lang) {
  const c = context;
  const zh = lang !== "en";
  const fieldLines = c.fields.map((f) =>
    `- ${f.k}｜${f.label || f.k}｜${f.col === "dual" ? "保守/乐观两档" : "单值"}｜单位：${f.unit === "%" ? "百分数（填 12 表示 12%）" : (f.money ? "金额（原始数值，不带单位缩写）" : (f.unit || "数字"))}｜当前：${fmtVal(f.value)}`).join("\n");
  const facts = c.facts && typeof c.facts === "object"
    ? Object.entries(c.facts).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n") : "";
  return [
    "你是一位严谨的价值投资分析师，正在帮用户在估值工作台里为一只股票设定估值假设。",
    zh ? "用中文回答，简洁、具体，先给结论再给依据。" : "Answer in English, concise and specific: conclusion first, then reasoning.",
    "",
    `标的：${c.stock && c.stock.name || ""}（${c.stock && c.stock.code || ""}）　币种：${c.stock && c.stock.currency || "未知"}　现价：${c.stock && c.stock.price || "未知"}`,
    `估值方法：${c.method && c.method.label || ""}（${c.method && c.method.key || ""}）${c.mode ? "　口径：" + c.mode : ""}`,
    "",
    "已知数据：",
    facts || "（无）",
    "",
    "当前方法的输入字段（k｜名称｜类型｜单位｜当前值）：",
    fieldLines,
    "",
    "规则：",
    "1. 只能建议上面列出的字段，不要发明字段；保守值应比乐观值更谨慎（增速、利润率、倍数更低；折现率更高）。",
    "2. 基于已知数据与行业常识给出合理假设；数据不足时说明你的假设前提，不要编造具体财务数字。",
    "3. 当你建议具体参数时，在回复最后附一个 ```json 代码块，格式严格如下（只含需要修改的字段）：",
    '```json\n{"params": {"单值字段k": 数字, "两档字段k": {"c": 保守数字, "o": 乐观数字}}, "reasons": {"字段k": "一句话理由"}}\n```',
    "4. 如果用户只是提问、还不需要改参数，就不要附代码块。",
    "5. 界面会把代码块渲染成参数表，所以正文里不要逐项罗列参数和数值，只用几句话讲清整体思路和关键判断（200 字以内）；只建议需要改动的字段。",
    "6. 这只是估值辅助，不构成投资建议；不要给出买卖建议。",
  ].join("\n");
}

// 从回复里取出最后一个 ```json 代码块，按字段表校验；返回 { reply（去掉代码块后的正文）, params, reasons }
export function parseSuggestion(text, fields) {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return { reply: text.trim(), params: null, reasons: null };
  let obj = null;
  try { obj = JSON.parse(last[1]); } catch { return { reply: text.trim(), params: null, reasons: null }; }
  const reply = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  const raw = obj && typeof obj === "object" ? (obj.params && typeof obj.params === "object" ? obj.params : obj) : null;
  if (!raw) return { reply, params: null, reasons: null };
  const byKey = new Map(fields.map((f) => [f.k, f]));
  const toNum = (v) => { const n = typeof v === "string" ? Number(v.replace(/[,%\s]/g, "")) : v; return (typeof n === "number" && Number.isFinite(n)) ? n : null; };
  const params = {};
  for (const [k, v] of Object.entries(raw)) {
    const f = byKey.get(k); if (!f) continue;
    if (f.col === "dual") {
      if (v && typeof v === "object") {
        const c = toNum(v.c ?? v.conservative), o = toNum(v.o ?? v.optimistic);
        if (c !== null && o !== null) params[k] = { c, o };
      } else { const n = toNum(v); if (n !== null) params[k] = { c: n, o: n }; }
    } else {
      const n = toNum(v && typeof v === "object" ? (v.value ?? v.c) : v); if (n !== null) params[k] = n;
    }
  }
  const reasons = {};
  if (obj.reasons && typeof obj.reasons === "object") {
    for (const [k, v] of Object.entries(obj.reasons)) if (params[k] !== undefined && typeof v === "string") reasons[k] = v.slice(0, 300);
  }
  return { reply, params: Object.keys(params).length ? params : null, reasons: Object.keys(reasons).length ? reasons : null };
}

// 每人每天的对话次数上限（防刷；计数存在 settings 表的内部键，不在 SETTING_KEYS 白名单里，不会返回给前端）
export const DAILY_LIMIT = 100;
async function takeQuota(env, uid) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key='_ai_usage'").bind(uid).first();
  const [d, n] = row && typeof row.value === "string" ? row.value.split(":") : [];
  const used = d === day ? Number(n) || 0 : 0;
  if (used >= DAILY_LIMIT) return false;
  await env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?, '_ai_usage', ?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value")
    .bind(uid, `${day}:${used + 1}`).run();
  return true;
}

export function registerAi(app, { chat = chatComplete } = {}) {
  app.post("/api/my/ai/valuation", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validateChat(body);
    if (err) return c.json({ error: err }, 400);
    if (!(await takeQuota(c.env, c.get("uid")))) return c.json({ error: "daily_limit" }, 429);
    const lang = body.lang === "en" ? "en" : "zh";
    let text;
    try {
      text = await chat(c.env, buildSystemPrompt(body.context, lang), body.messages.map((m) => ({ role: m.role, content: m.content })));
    } catch (e) {
      return c.json({ error: "ai_failed", detail: String(e && e.message || e).slice(0, 300) }, 502);
    }
    return c.json(parseSuggestion(text, body.context.fields));
  });
}
