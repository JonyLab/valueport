// 估值工作台的 AI 助手：和用户聊估值假设，回复末尾附一个 ```json 代码块给出建议参数，前端预览后一键应用。
// 不依赖各家的原生 tool calling（Workers AI 开源模型支持参差），统一用「约定格式的 JSON 代码块」，三种协议通用。
//
import { encryptJson, decryptJson } from "./crypto.js";

// 模型服务：用户在设置页配置自己的模型（ai_models 表）、在 AI 面板里切换（见 userAi()）；没选就用站点默认（wrangler.toml [vars] / secret）：
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

// 推理类模型会把思考过程包在 <think> 里，只留最终回答
const clean = (t) => t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

// messages: [{ role: "user"|"assistant", content }]；返回模型回复文本。cfg 不传则用站点默认
export async function chatComplete(env, system, messages, fetchImpl = fetch, cfgIn = null) {
  const text = await rawComplete(env, system, messages, fetchImpl, cfgIn || aiConfig(env));
  return clean(text);
}
async function rawComplete(env, system, messages, fetchImpl, cfg) {
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
// 已核实的事实：前端由财报算好的短句（≤20 条，每条 ≤300 字）
function badVerified(v) { return v !== undefined && (!Array.isArray(v) || v.length > 20 || v.some((x) => typeof x !== "string" || x.length > 300)); }
function verifiedBlock(v) {
  if (!Array.isArray(v) || !v.length) return [];
  return ["", "已核实的事实（系统根据财报计算，以此为准）：", ...v.map((x) => "- " + x)];
}
// 界面不渲染 Markdown：去掉 **粗体**、__粗体__、`代码`、行首 # 标题
export const plain = (t) => String(t || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^#{1,6}\s+/gm, "").trim();
// 市场投研（分析师评级 / 目标价 / 一致预期）与大师方法视角（格雷厄姆 / 林奇 / 巴菲特式指标），都由前端按数据算好
function viewsBlock(market, lenses) {
  const out = [];
  if (Array.isArray(market) && market.length) out.push("", "市场投研（来自长桥：分析师评级、目标价、一致预期）：", ...market.map((x) => "- " + x));
  if (Array.isArray(lenses) && lenses.length) out.push("", "大师方法视角（系统按公开方法论计算）：", ...lenses.map((x) => "- " + x));
  return out;
}
const SYNTHESIS = "综合三方面判断：基本面事实、市场投研、大师方法视角；它们不一致时说清你更看重哪一方、为什么（例如分析师看多但大师指标显示偏贵）。不要声称某位大师本人对这只股票说过什么或怎么估值，只能说「按 X 的方法看」。";
const GROUNDING = "凡是涉及现金流 / 盈利是否稳定、是否分红、增长快慢、负债多少的判断，都必须与「已核实的事实」一致；事实里没有的不要断言，不要编造任何数字或经营情况。";
export function validateChat(body) {
  if (!body || typeof body !== "object") return "bad body";
  const { messages, context } = body;
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MSGS) return "messages must be 1-20 items";
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim() || m.content.length > MAX_CHARS) return "bad message";
  }
  if (messages[messages.length - 1].role !== "user") return "last message must be from user";
  if (!context || typeof context !== "object" || !Array.isArray(context.fields) || !context.fields.length || context.fields.length > 40) return "context.fields required";
  if (badVerified(context.verified)) return "bad verified facts";
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
    ...verifiedBlock(c.verified),
    "",
    "当前方法的输入字段（k｜名称｜类型｜单位｜当前值）：",
    fieldLines,
    "",
    "规则：",
    "1. 只能建议上面列出的字段，不要发明字段；保守值应比乐观值更谨慎（增速、利润率、倍数更低；折现率更高）。",
    "2. 基于已知数据与行业常识给出合理假设；数据不足时说明你的假设前提，不要编造具体财务数字。" + GROUNDING,
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
  if (!last) return { reply: plain(text), params: null, reasons: null };
  let obj = null;
  try { obj = JSON.parse(last[1]); } catch { return { reply: plain(text), params: null, reasons: null }; }
  const reply = plain(text.slice(0, last.index) + text.slice(last.index + last[0].length));
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

// ── 选方法：根据公司特点推荐估值方法 ──
export function validateMethodReq(body) {
  if (!body || typeof body !== "object") return "bad body";
  const { stock, methods } = body;
  if (!stock || typeof stock !== "object" || typeof stock.name !== "string") return "stock required";
  if (!Array.isArray(methods) || !methods.length || methods.length > 30) return "methods required";
  for (const m of methods) if (!m || typeof m.key !== "string" || typeof m.title !== "string") return "bad method";
  if (badVerified(body.verified) || badVerified(body.market) || badVerified(body.lenses)) return "bad verified facts";
  if (JSON.stringify(body).length > 20000) return "body too large";
  return null;
}
export function buildMethodPrompt(body, lang) {
  const { stock, facts, methods, verified, market, lenses } = body;
  const zh = lang !== "en";
  const factLines = facts && typeof facts === "object"
    ? Object.entries(facts).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `- ${k}: ${v}`).join("\n") : "";
  return [
    "你是一位严谨的价值投资分析师。用户要给一只股票做估值，请根据这家公司的业务类型、盈利与现金流特征、分红情况，从下面的估值方法里推荐最合适的。",
    zh ? "用中文回答。" : "Answer in English.",
    "",
    `标的：${stock.name}（${stock.code || ""}）　币种：${stock.currency || "未知"}　现价：${stock.price || "未知"}`,
    "已知数据：", factLines || "（无）",
    ...verifiedBlock(verified),
    ...viewsBlock(market, lenses),
    "",
    "可选方法（key｜名称｜适用场景）：",
    methods.map((m) => `- ${m.key}｜${m.title}｜${m.subtitle || ""}`).join("\n"),
    "",
    "规则：",
    "1. 推荐 1 个首选方法 + 1~2 个用来交叉验证的方法，只能从上面的 key 里选。",
    "2. 依据公司实际情况：银行保险等看账面价值；股息折现（DDM）只在分红是主要回报方式时才作主方法（分红率约 40% 以上、股息率不低、长期稳定派息）——分红率低、主要靠回购或再投资的公司（多数科技成长股）不要首选 DDM，以「已核实的事实」里的分红判断为准；现金流各年为正且稳定可预测才首选现金流折现；自由现金流有负值年份或大幅波动时，优先用盈利倍数（多业务公司可用 P/E 的「分业务」口径，按业务分别估）或市销率，现金流折现最多作交叉验证；尚未盈利的成长股用市销率；最近三年都盈利的公司不要首选市销率（盈利有波动就用 P/E 并说明取哪年口径）；资源类看资产重估。",
    "3. " + GROUNDING + SYNTHESIS + "大师视角里某个指标「不满足」不等于方法不能用，要结合公司类型解释。",
    zh ? "4. 正文用两三句话讲清这家公司的特点和选择依据（120 字以内），引用一两条已核实的事实作依据，不要逐项罗列方法；提到方法时用上面的方法名称（如「DCF 自由现金流」），不要写 key。" : "4. Keep the prose to two or three sentences (under 70 words): what kind of company this is and why the primary method fits, citing one or two verified facts. Don't walk through every method; refer to methods by their names (e.g. "DCF free cash flow"), never by key.",
    "5. 回复最后附一个 ```json 代码块，格式严格如下：",
    '```json\n{"picks": [{"key": "方法key", "role": "primary", "reason": "一句话理由"}, {"key": "方法key", "role": "check", "reason": "一句话理由"}]}\n```',
  ].join("\n");
}
export function parsePicks(text, methods) {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return { reply: plain(text), picks: [] };
  const reply = plain(text.slice(0, last.index) + text.slice(last.index + last[0].length));
  let obj = null; try { obj = JSON.parse(last[1]); } catch { return { reply, picks: [] }; }
  const keys = new Set(methods.map((x) => x.key));
  const seen = new Set(), picks = [];
  for (const p of (obj && Array.isArray(obj.picks) ? obj.picks : [])) {
    if (!p || !keys.has(p.key) || seen.has(p.key)) continue;
    seen.add(p.key);
    picks.push({ key: p.key, role: picks.length ? "check" : "primary", reason: typeof p.reason === "string" ? plain(p.reason).slice(0, 200) : "" });
    if (picks.length >= 3) break;
  }
  return { reply, picks };
}

// ── AI 复核：用最新财报检查一张估值卡当初的假设还成不成立 ──
const REVIEW_OVERALL = new Set(["hold", "watch", "broken"]), REVIEW_STATUS = new Set(["ok", "watch", "broken"]);
export function validateReviewReq(body) {
  if (!body || typeof body !== "object") return "bad body";
  const { stock, method, fields, result } = body;
  if (!stock || typeof stock.name !== "string") return "stock required";
  if (!method || typeof method.key !== "string") return "method required";
  if (!Array.isArray(fields) || !fields.length || fields.length > 40) return "fields required";
  for (const f of fields) if (!f || typeof f.k !== "string" || (f.col !== "single" && f.col !== "dual")) return "bad field";
  if (!result || !Number.isFinite(Number(result.low)) || !Number.isFinite(Number(result.high))) return "result required";
  if (badVerified(body.verified) || badVerified(body.metrics) || badVerified(body.comparisons) || badVerified(body.market) || badVerified(body.lenses)) return "bad facts";
  if (JSON.stringify(body).length > 20000) return "body too large";
  return null;
}
export function buildReviewPrompt(body, lang) {
  const { stock, method, fields, result, valuedAt, verified, metrics, comparisons, market, lenses } = body;
  const zh = lang !== "en";
  const fieldLines = fields.map((f) => `- ${f.k}｜${f.label || f.k}｜${f.unit === "%" ? "百分数" : f.money ? "金额" : (f.unit || "数字")}｜当初填的：${fmtVal(f.value)}`).join("\n");
  return [
    "你是一位严谨的价值投资分析师，正在帮用户复核一张已保存的估值卡：用最新的财报数据检查当初的估值假设是否还成立。",
    zh ? "用中文回答。" : "Answer in English.",
    "",
    `标的：${stock.name}（${stock.code || ""}）　币种：${stock.currency || "未知"}　现价：${stock.price || "未知"}`,
    `估值方法：${method.label || method.key}　估值日期：${valuedAt || "未知"}　当初结论：合理价 ${result.low} ~ ${result.high}`,
    "",
    "当初的假设（k｜名称｜单位｜当初填的值；两档为 保守 / 乐观）：",
    fieldLines,
    ...verifiedBlock(verified),
    ...(Array.isArray(metrics) && metrics.length ? ["", "最新实际数据（系统根据财报计算，以此为准）：", ...metrics.map((x) => "- " + x)] : []),
    ...viewsBlock(market, lenses),
    ...(Array.isArray(comparisons) && comparisons.length ? ["", "假设对照（系统已把最新实际值和两档假设比好，以此为准，不要自己重新比较数字）：", ...comparisons.map((x) => "- " + x)] : []),
    "",
    "规则：",
    "1. 有「假设对照」的字段，状态必须和对照结果一致：落在两档之间或高于两档（增速、利润率）→ ok；低于两档 → watch 或 broken（差得多才算 broken）；倍数类看当前与自身历史是否支持当初的目标倍数。其余逐项对照关键假设和最新实际数据：增速、利润率、倍数、折现率等是否还说得通。实际表现落在保守与乐观之间或更好 → ok；接近保守下沿或趋势在变差 → watch；明显跌破保守假设、或前提已经变了 → broken。没有对应数据的假设（如折现率、永续增速）只在有明确理由时才评价，不必每项都写。",
    "2. " + GROUNDING + SYNTHESIS + "可以对照分析师目标价区间和当初的合理价区间，差得很远时在总结里点出来。",
    "3. 不给买卖建议，只说假设是否成立、哪里需要调整。",
    "4. 正文不要罗列，结论全部放进回复最后的 ```json 代码块，格式严格如下：",
    '```json\n{"overall": "hold|watch|broken", "summary": "两三句话的总体判断（100 字以内）", "checks": [{"k": "字段k", "status": "ok|watch|broken", "reason": "一句话依据，写出最新实际数字和当初的假设，如：近三年营收复合 10.0%，低于保守 12%"}]}\n```',
  ].join("\n");
}
export function parseReview(text, fields) {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(text))) last = m;
  let obj = null;
  try { obj = JSON.parse(last ? last[1] : text); } catch { return null; }
  if (!obj || !REVIEW_OVERALL.has(obj.overall)) return null;
  const keys = new Set(fields.map((f) => f.k)), seen = new Set(), checks = [];
  for (const ck of Array.isArray(obj.checks) ? obj.checks : []) {
    if (!ck || !keys.has(ck.k) || seen.has(ck.k) || !REVIEW_STATUS.has(ck.status)) continue;
    seen.add(ck.k);
    checks.push({ k: ck.k, status: ck.status, reason: typeof ck.reason === "string" ? plain(ck.reason).slice(0, 240) : "" });
  }
  return { overall: obj.overall, summary: typeof obj.summary === "string" ? plain(obj.summary).slice(0, 400) : "", checks };
}

// ── 用户的模型：设置页只管「配置了哪些」（ai_models 表，可多条），AI 面板里切「用哪个」（settings 内部键 _ai_active）──
// 不用配置就能选的：站点默认（"default"）+ 几个 Workers AI 模型（"wa:<模型 id>"，走站点的 Workers AI 额度）
// 用户自己加的 OpenAI 兼容 / Anthropic 模型：id 为 "m:<行 id>"，Key 用 CREDENTIALS_KEY 加密，接口永不返回明文
export const WORKERS_MODELS = [
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B" },
];
const MODEL_RE = /^[\w@.:\/-]{1,100}$/;
const MAX_MODELS = 10;
function cleanBaseUrl(raw) {
  let u; try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || String(raw).length > 300) return null;
  return u.toString().replace(/\/+$/, "");
}
// 新增 / 修改一个自定义模型 → { error } | { value: { provider, name, model, baseUrl, apiKey } }；apiKey 不传 = 沿用已存的
export function validateModel(b) {
  if (!b || typeof b !== "object") return { error: "bad body" };
  const provider = b.provider;
  if (provider !== "openai" && provider !== "anthropic") return { error: "provider must be openai or anthropic" };
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!MODEL_RE.test(model)) return { error: "model required" };
  const name = (typeof b.name === "string" ? b.name.trim() : "").slice(0, 40) || model;
  let baseUrl = "";
  if (b.baseUrl || provider === "openai") { baseUrl = cleanBaseUrl(b.baseUrl); if (!baseUrl) return { error: "base URL must be https" }; }
  let apiKey;
  if (b.apiKey !== undefined && b.apiKey !== "") {
    if (typeof b.apiKey !== "string" || b.apiKey.length > 500 || /\s/.test(b.apiKey.trim())) return { error: "bad api key" };
    apiKey = b.apiKey.trim();
  }
  return { value: { provider, name, model, baseUrl, apiKey } };
}
async function listModelRows(env, uid) {
  try { const { results } = await env.DB.prepare("SELECT * FROM ai_models WHERE user_id=? ORDER BY id ASC").bind(uid).all(); return results || []; }
  catch { return []; } // 线上还没跑迁移时当作没有自定义模型
}
async function readActive(env, uid) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key='_ai_active'").bind(uid).first();
  return row && typeof row.value === "string" ? row.value : "default";
}
const keyHint = (k) => (k && k.length > 4 ? "…" + k.slice(-4) : "");
const rowCfg = async (env, r) => ({ provider: r.provider, model: r.model, baseUrl: r.base_url || DEFAULTS[r.provider].baseUrl, apiKey: (await decryptJson(env.CREDENTIALS_KEY, r.key_enc)).apiKey });
// 当前用户实际用的配置；own = 用的是自己的 Key（不占站点每日额度）。选中的模型被删了就回到站点默认
export async function userAi(env, uid) {
  const active = await readActive(env, uid);
  if (active.startsWith("wa:")) {
    const m = WORKERS_MODELS.find((x) => x.id === active.slice(3));
    if (m) return { cfg: { provider: "workers-ai", model: m.id, baseUrl: "", apiKey: "" }, own: false, active };
  }
  if (active.startsWith("m:")) {
    const r = (await listModelRows(env, uid)).find((x) => String(x.id) === active.slice(2));
    if (r) return { cfg: await rowCfg(env, r), own: true, active };
  }
  return { cfg: aiConfig(env), own: false, active: "default" };
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
  // 用当前用户的模型配置调用；自己的 Key 不占站点每日额度。返回 { text } 或 { res }（错误响应）
  async function runChat(c, system, messages) {
    let u;
    try { u = await userAi(c.env, c.get("uid")); } catch { return { res: c.json({ error: "ai_settings_unreadable", detail: "saved API key can't be decrypted — re-enter it in settings" }, 500) }; }
    if (!u.own && !(await takeQuota(c.env, c.get("uid")))) return { res: c.json({ error: "daily_limit" }, 429) };
    try { return { text: await chat(c.env, system, messages, undefined, u.cfg) }; }
    catch (e) { return { res: c.json({ error: "ai_failed", detail: String(e && e.message || e).slice(0, 300) }, 502) }; }
  }
  // 可选模型列表 + 当前选中（AI 面板的切换器和设置页都用）
  app.get("/api/my/ai/models", async (c) => {
    const uid = c.get("uid");
    const rows = await listModelRows(c.env, uid);
    const u = await userAi(c.env, uid).catch(() => ({ active: "default" }));
    const site = aiConfig(c.env);
    const wm = (id) => (WORKERS_MODELS.find((m) => m.id === id) || { label: id }).label;
    const custom = [];
    for (const r of rows) {
      let hint = ""; try { hint = keyHint((await decryptJson(c.env.CREDENTIALS_KEY, r.key_enc)).apiKey); } catch { hint = ""; }
      custom.push({ id: "m:" + r.id, kind: r.provider, name: r.name, model: r.model, baseUrl: r.base_url, keyHint: hint });
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      active: u.active,
      site: { id: "default", kind: "site", provider: site.provider, model: site.model, name: site.provider === "workers-ai" ? wm(site.model) : site.model },
      workers: WORKERS_MODELS.map((m) => ({ id: "wa:" + m.id, kind: "workers-ai", name: m.label, model: m.id })),
      custom,
    });
  });
  // 切换当前用的模型
  app.put("/api/my/ai/active", async (c) => {
    const uid = c.get("uid"), b = await c.req.json().catch(() => ({}));
    const id = typeof b.id === "string" ? b.id : "";
    const ok = id === "default" || (id.startsWith("wa:") && WORKERS_MODELS.some((m) => "wa:" + m.id === id))
      || (id.startsWith("m:") && (await listModelRows(c.env, uid)).some((r) => "m:" + r.id === id));
    if (!ok) return c.json({ error: "unknown model" }, 400);
    await c.env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?, '_ai_active', ?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").bind(uid, id).run();
    return c.json({ ok: true, active: id });
  });
  app.post("/api/my/ai/models", async (c) => {
    const uid = c.get("uid"), v = validateModel(await c.req.json().catch(() => null));
    if (v.error) return c.json({ error: v.error }, 400);
    if (!v.value.apiKey) return c.json({ error: "api key required" }, 400);
    if ((await listModelRows(c.env, uid)).length >= MAX_MODELS) return c.json({ error: `at most ${MAX_MODELS} models` }, 400);
    const enc = await encryptJson(c.env.CREDENTIALS_KEY, { apiKey: v.value.apiKey });
    const r = await c.env.DB.prepare("INSERT INTO ai_models (user_id, provider, name, model, base_url, key_enc, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(uid, v.value.provider, v.value.name, v.value.model, v.value.baseUrl, enc, new Date().toISOString()).run();
    return c.json({ ok: true, id: "m:" + r.meta.last_row_id }, 201);
  });
  const ownRow = async (c) => (await listModelRows(c.env, c.get("uid"))).find((r) => String(r.id) === c.req.param("id")) || null;
  app.put("/api/my/ai/models/:id", async (c) => {
    const row = await ownRow(c);
    if (!row) return c.json({ error: "not found" }, 404);
    const v = validateModel(await c.req.json().catch(() => null));
    if (v.error) return c.json({ error: v.error }, 400);
    if (!v.value.apiKey && v.value.provider !== row.provider) return c.json({ error: "api key required when changing provider" }, 400);
    const enc = v.value.apiKey ? await encryptJson(c.env.CREDENTIALS_KEY, { apiKey: v.value.apiKey }) : row.key_enc;
    await c.env.DB.prepare("UPDATE ai_models SET provider=?, name=?, model=?, base_url=?, key_enc=? WHERE id=? AND user_id=?")
      .bind(v.value.provider, v.value.name, v.value.model, v.value.baseUrl, enc, row.id, c.get("uid")).run();
    return c.json({ ok: true });
  });
  app.delete("/api/my/ai/models/:id", async (c) => {
    const row = await ownRow(c);
    if (!row) return c.json({ error: "not found" }, 404);
    await c.env.DB.prepare("DELETE FROM ai_models WHERE id=? AND user_id=?").bind(row.id, c.get("uid")).run();
    return c.json({ ok: true }); // 正在用的被删了：userAi() 自动回到站点默认
  });
  // 测试连接：用表单里（可能还没保存）的配置发一条最小请求；编辑已有模型时不填 Key 就用已存的
  app.post("/api/my/ai/models/test", async (c) => {
    const b = await c.req.json().catch(() => null);
    const v = validateModel(b);
    if (v.error) return c.json({ error: v.error }, 400);
    let apiKey = v.value.apiKey;
    if (!apiKey && b && typeof b.id === "string" && b.id.startsWith("m:")) {
      const r = (await listModelRows(c.env, c.get("uid"))).find((x) => "m:" + x.id === b.id);
      if (r) { try { apiKey = (await decryptJson(c.env.CREDENTIALS_KEY, r.key_enc)).apiKey; } catch { apiKey = ""; } }
    }
    if (!apiKey) return c.json({ error: "api key required" }, 400);
    const cfg = { provider: v.value.provider, model: v.value.model, baseUrl: v.value.baseUrl || DEFAULTS[v.value.provider].baseUrl, apiKey };
    const t0 = Date.now();
    try {
      const text = await chat(c.env, "You are a connectivity check. Reply with exactly: OK", [{ role: "user", content: "ping" }], undefined, cfg);
      return c.json({ ok: true, reply: String(text).slice(0, 80), ms: Date.now() - t0, model: cfg.model });
    } catch (e) {
      return c.json({ ok: false, error: String(e && e.message || e).slice(0, 300) });
    }
  });
  app.post("/api/my/ai/valuation", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validateChat(body);
    if (err) return c.json({ error: err }, 400);
    const lang = body.lang === "en" ? "en" : "zh";
    const { text, res } = await runChat(c, buildSystemPrompt(body.context, lang), body.messages.map((m) => ({ role: m.role, content: m.content })));
    if (res) return res;
    return c.json(parseSuggestion(text, body.context.fields));
  });
  app.post("/api/my/ai/method", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validateMethodReq(body);
    if (err) return c.json({ error: err }, 400);
    const lang = body.lang === "en" ? "en" : "zh";
    const { text, res } = await runChat(c, buildMethodPrompt(body, lang), [{ role: "user", content: lang === "en" ? "Which valuation methods fit this company?" : "这家公司适合用哪些估值方法？" }]);
    if (res) return res;
    return c.json(parsePicks(text, body.methods));
  });
  app.post("/api/my/ai/review", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validateReviewReq(body);
    if (err) return c.json({ error: err }, 400);
    const lang = body.lang === "en" ? "en" : "zh";
    const { text, res } = await runChat(c, buildReviewPrompt(body, lang), [{ role: "user", content: lang === "en" ? "Do the assumptions of this valuation still hold?" : "这张估值卡的假设还成立吗？" }]);
    if (res) return res;
    const review = parseReview(text, body.fields);
    if (!review) return c.json({ error: "bad_ai_output" }, 502);
    return c.json({ review: { ...review, at: new Date().toISOString() } });
  });
}
