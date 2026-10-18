// 估值工作台的 AI 助手：和用户聊估值假设，回复末尾附一个 ```json 代码块给出建议参数，前端预览后一键应用。
// 不依赖各家的原生 tool calling（Workers AI 开源模型支持参差），统一用「约定格式的 JSON 代码块」，三种协议通用。
//
import { encryptJson, decryptJson } from "./crypto.js";
import { METRICS, METRIC_KEYS, metricKey } from "../public/shared/metric-spark.js";

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

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
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
    const zhipu = /(^|\.)bigmodel\.cn$/.test(hostOf(cfg.baseUrl));
    const body = JSON.stringify({ model: cfg.model, max_tokens: MAX_TOKENS, messages: [{ role: "system", content: system }, ...messages],
      ...(zhipu ? { thinking: { type: "disabled" } } : {}) }); // 智谱 GLM：关掉深度思考，更快，也不让思考吃掉输出长度
    let res, j;
    // 智谱免费模型常报「访问量过大」（并发限制），隔一会儿重试两次
    for (let attempt = 0; ; attempt++) {
      res = await fetchImpl(cfg.baseUrl + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cfg.apiKey }, body });
      j = await res.json().catch(() => null);
      const busy = !res.ok && zhipu && (res.status === 429 || /访问量过大|稍后再试|rate limit|concurrency/i.test((j && j.error && j.error.message) || ""));
      if (!busy || attempt >= 2) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
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
    "4. 如果用户只是提问、还不需要改参数，就不要放 params；只想给交互组件时代码块里只放 {\"widgets\": [...]}；两者都不需要就不要附代码块。",
    "5. 界面会把代码块渲染成参数表，所以正文里不要逐项罗列参数和数值，只用几句话讲清整体思路和关键判断（200 字以内）；只建议需要改动的字段。",
    "6. 这只是估值辅助，不构成投资建议；不要给出买卖建议。",
    "",
    "可选的交互组件（放在同一个 ```json 代码块的 \"widgets\" 数组里，每次最多 2 个；不需要就不放）。组件只指定字段和步长，数值由界面用估值模型现算，你不要在组件或正文里写出计算结果：",
    '- 敏感性：{"type":"sensitivity","field":"字段k","steps":[-2,-1,0,1,2]} —— 只改这一个字段、其他输入不变，逐档算合理价。steps 是加减量，单位同字段（百分数字段 1 = 1 个百分点；金额字段按 % 变动）。用户问「X 变一点影响多大」「哪个假设最关键」时用。',
    '- 倍数对比：{"type":"peers","multiple":"pe"|"pb"|"ps"} —— 当前倍数 vs 自身 5 年均值 vs 行业中位。讨论目标倍数取多少、贵不贵时用。',
    '- 一键改值：{"type":"set","field":"字段k","value":数字 或 {"c":保守,"o":乐观},"label":"不超过 12 字的说明"} —— 生成「把 X 改成 Y」按钮，用户点了才写入、可撤销。只改一两个字段时用它代替 params。',
    "只能用上面三种 type 和上面列出的字段 k；组件之外正文保持简短（150 字以内）。",
  ].join("\n");
}

// ── 交互组件：模型只挑组件和字段，数值由前端算；未知或不合法的组件丢弃，最多 2 个 ──
const MAX_WIDGETS = 2;
const MULTIPLES = new Set(["pe", "pb", "ps"]);
export function parseWidgets(raw, fields) {
  if (!Array.isArray(raw)) return null;
  const byKey = new Map(fields.map((f) => [f.k, f]));
  const toNum = (v) => { const n = typeof v === "string" ? Number(v.replace(/[,%\s]/g, "")) : v; return (typeof n === "number" && Number.isFinite(n)) ? n : null; };
  const out = [];
  for (const w of raw) {
    if (out.length >= MAX_WIDGETS) break;
    if (!w || typeof w !== "object") continue;
    if (w.type === "sensitivity") {
      if (!byKey.has(w.field)) continue;
      let steps = Array.isArray(w.steps) ? w.steps.map(toNum).filter((n) => n !== null && Math.abs(n) <= 100) : [];
      steps = [...new Set([0, ...steps.map((n) => Math.round(n * 100) / 100)])].sort((a, b) => a - b);
      if (steps.length < 3 || steps.length > 9) steps = [-2, -1, 0, 1, 2];
      out.push({ type: "sensitivity", field: w.field, steps });
    } else if (w.type === "peers") {
      const m = typeof w.multiple === "string" ? w.multiple.toLowerCase() : "";
      if (!MULTIPLES.has(m) || out.some((x) => x.type === "peers" && x.multiple === m)) continue;
      out.push({ type: "peers", multiple: m });
    } else if (w.type === "set") {
      const f = byKey.get(w.field); if (!f) continue;
      let value = null;
      if (f.col === "dual") {
        if (w.value && typeof w.value === "object") { const c = toNum(w.value.c), o = toNum(w.value.o); if (c !== null && o !== null) value = { c, o }; }
        else { const n = toNum(w.value); if (n !== null) value = { c: n, o: n }; }
      } else value = toNum(w.value && typeof w.value === "object" ? w.value.c : w.value);
      if (value === null) continue;
      const label = typeof w.label === "string" ? w.label.trim().slice(0, 40) : "";
      out.push({ type: "set", field: w.field, value, ...(label ? { label } : {}) });
    }
  }
  return out.length ? out : null;
}

// 从回复里取出最后一个 ```json 代码块，按字段表校验；返回 { reply（去掉代码块后的正文）, params, reasons, widgets? }
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
  const widgets = parseWidgets(obj.widgets, fields);
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
  const res = { reply, params: Object.keys(params).length ? params : null, reasons: Object.keys(reasons).length ? reasons : null };
  if (widgets) res.widgets = widgets; // 没有组件时不带这个键，老前端 / 老测试不受影响
  return res;
}

// ── 选方法：根据公司特点推荐估值方法 ──
export function validateMethodReq(body) {
  if (!body || typeof body !== "object") return "bad body";
  const { stock, methods } = body;
  if (!stock || typeof stock !== "object" || typeof stock.name !== "string") return "stock required";
  if (!Array.isArray(methods) || !methods.length || methods.length > 30) return "methods required";
  for (const m of methods) if (!m || typeof m.key !== "string" || typeof m.title !== "string") return "bad method";
  if (badVerified(body.verified) || badVerified(body.market) || badVerified(body.lenses) || badVerified(body.business)) return "bad verified facts";
  if (JSON.stringify(body).length > 24000) return "body too large";
  return null;
}
// 生意类型：先看懂公司怎么赚钱，再按类型选方法（参考林奇的六类公司 + 金融、公用事业）。
// avoid：这类公司不该用的方法——即使模型选了，也在服务端剔除（开源模型常无视规则）。
export const BUSINESS_TYPES = {
  cyclical: { zh: "资源与周期", en: "Cyclical / commodity", desc: "矿业、油气、航运、钢铁、化工、养殖等，盈利随商品价格或行业周期大起大落", play: "首选资源股 NAV / SOTP（有可估储量的资源资产）或 EV/EBITDA（用中周期口径）；P/E 只能用正常化的中周期利润；不要用 PEG、不要用当期高景气利润外推增速——林奇也把周期股单列，周期股市盈率最低时往往是周期顶点", avoid: ["peg", "ps"] },
  financial: { zh: "金融", en: "Financial", desc: "银行、保险、券商等，资产负债表就是生意本身", play: "首选 P/B（结合 ROE 看能撑多高的 PB）；长期高分红的可用 DDM；P/E 作交叉验证；不用自由现金流类和 EV/EBITDA、P/S", avoid: ["fcff", "fcf", "fcfe", "evebitda", "ps"] },
  utility: { zh: "公用事业 / 类债券", en: "Utility / bond-like", desc: "电力、水务、燃气、收费公路、电信运营等，价格受管制、现金流稳定", play: "首选 DDM 或 DCF 自由现金流；P/E 作交叉验证；不用 PEG、P/S", avoid: ["peg", "ps"] },
  stalwart: { zh: "成熟稳健", en: "Stalwart", desc: "行业龙头，增长中低速、盈利与现金流稳定", play: "首选 DCF 自由现金流或 P/E；分红率高的可加 DDM 交叉验证；不用 P/S", avoid: ["ps"] },
  fast_grower: { zh: "高速成长", en: "Fast grower", desc: "已经盈利、收入利润快速增长", play: "首选分阶段的 FCFF / DCF 或 P/E（配合增速）；PEG 作交叉验证；不用 DDM、P/B", avoid: ["ddm", "pb"] },
  unprofitable: { zh: "未盈利成长 / 困境反转", en: "Unprofitable / turnaround", desc: "尚未盈利或刚经历大亏、正在扭转", play: "首选 P/S 或 EV/收入类倍数；FCFF 用情景假设作交叉验证；不用 P/E、PEG、DDM", avoid: ["pe", "peg", "ddm"] },
  asset_play: { zh: "资产型 / 多元控股", en: "Asset play / holding", desc: "价值主要在资产或多项业务（地产、控股集团、多元化公司）", play: "首选 NAV / SOTP 分部加总或 P/B；P/E 作交叉验证；不用 PEG、P/S", avoid: ["peg", "ps"] },
  platform: { zh: "轻资产平台 / 品牌", en: "Asset-light platform / brand", desc: "高 ROE、强现金流的平台、软件、消费品牌", play: "首选 DCF 自由现金流或 FCFF；P/E 作交叉验证；分红率低时不用 DDM；不用 P/B", avoid: ["pb"] },
};
export function buildMethodPrompt(body, lang) {
  const { stock, facts, methods, verified, market, lenses, business } = body;
  const zh = lang !== "en";
  const factLines = facts && typeof facts === "object"
    ? Object.entries(facts).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `- ${k}: ${v}`).join("\n") : "";
  const types = Object.entries(BUSINESS_TYPES).map(([k, t]) => `- ${k}｜${t.zh}｜${t.desc}｜估值做法：${t.play}`).join("\n");
  return [
    "你是一位严谨的价值投资分析师。像巴菲特、芒格、林奇那样，先弄懂这门生意——它靠什么赚钱、收入和利润由什么驱动、周期性强不强、要不要大量资本投入、护城河在哪——再结合财务状况决定用什么方法估值，而不是只看利润增速或几个指标。",
    zh ? "用中文回答。" : "Answer in English.",
    "",
    `标的：${stock.name}（${stock.code || ""}）　币种：${stock.currency || "未知"}　现价：${stock.price || "未知"}`,
    ...(Array.isArray(business) && business.length ? ["", "生意本身（来自长桥：公司简介与收入构成）：", ...business.map((x) => "- " + x)] : []),
    "", "已知数据：", factLines || "（无）",
    ...verifiedBlock(verified),
    ...viewsBlock(market, lenses),
    "",
    "生意类型（type｜名称｜特征｜估值做法）：",
    types,
    "",
    "可选方法（key｜名称｜适用场景）：",
    methods.map((m) => `- ${m.key}｜${m.title}｜${m.subtitle || ""}`).join("\n"),
    "",
    "步骤与规则：",
    "1. 先根据「生意本身」和你对这家公司的了解判断它怎么赚钱、收入利润的驱动因素（量、价、商品价格、利率、用户数等）、周期性与资本密集度，归入上面的一个生意类型。周期性和类型要以生意本身为准：利润增速高不等于高速成长，如果增长主要来自商品价格上涨，它仍是资源与周期类。",
    "2. 再按该类型的估值做法选 1 个首选 + 1~2 个交叉验证方法，只能从可选方法的 key 里选；用已核实的事实、市场投研、大师方法视角去细化和检验（例如分红率决定 DDM 能不能用、现金流稳不稳定决定 DCF 的可靠性）。大师方法里不适用于该类型的指标（如周期股的 PEG）要明确忽略。",
    "3. " + GROUNDING + SYNTHESIS + "不确定的业务细节不要编，说「从公开资料看」即可。",
    zh ? "4. 只输出下面这个 ```json 代码块，不要写代码块以外的文字、标题或列表。summary 用两句话说清为什么选这几个方法（100 字以内），不要重复生意画像；提到方法时用方法名称（如「DCF 自由现金流」），不要写 key。" : "4. Output only the ```json block below — no prose, headings or lists outside it. summary: two sentences (under 60 words) on why these methods fit; don't repeat the business profile; refer to methods by name (e.g. \"DCF free cash flow\"), never by key.",
    "5. 格式严格如下（business 里的字段各一句话，type 用上面的 key）：",
    '```json\n{"business": {"type": "生意类型key", "model": "它怎么赚钱", "drivers": "收入和利润主要由什么驱动", "implication": "这对估值意味着什么"}, "summary": "为什么选这几个方法", "picks": [{"key": "方法key", "role": "primary", "reason": "一句话理由"}, {"key": "方法key", "role": "check", "reason": "一句话理由"}]}\n```',
  ].join("\n");
}
// 长篇正文 → 第一段像样的句子（跳过「估值方法选择」这类小标题、列表符号和「JSON 代码块」字样）
function briefOf(t) {
  const paras = String(t || "").split(/\n\s*\n/).map((x) => x.replace(/^\s*([-*•]|\d+\.)\s+/gm, "").replace(/JSON\s*代码块|JSON block/gi, "").trim()).filter(Boolean);
  const first = paras.find((x) => x.length > 20) || paras[0] || "";
  return first.length > 200 ? first.slice(0, 200).replace(/[，,；;][^，,；;]*$/, "") + "…" : first;
}
export function parsePicks(text, methods) {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return { reply: plain(text), picks: [], business: null };
  const reply = plain(text.slice(0, last.index) + text.slice(last.index + last[0].length));
  let obj = null; try { obj = JSON.parse(last[1]); } catch { return { reply, picks: [], business: null }; }
  const keys = new Set(methods.map((x) => x.key));
  const bz = obj && obj.business && typeof obj.business === "object" && BUSINESS_TYPES[obj.business.type] ? obj.business : null;
  const avoid = new Set(bz ? BUSINESS_TYPES[bz.type].avoid : []);
  const seen = new Set(), picks = [];
  for (const p of (obj && Array.isArray(obj.picks) ? obj.picks : [])) {
    if (!p || !keys.has(p.key) || seen.has(p.key) || avoid.has(p.key)) continue; // 不适合该生意类型的方法直接剔除
    seen.add(p.key);
    picks.push({ key: p.key, role: picks.length ? "check" : "primary", reason: typeof p.reason === "string" ? plain(p.reason).slice(0, 200) : "" });
    if (picks.length >= 3) break;
  }
  const str = (v) => (typeof v === "string" ? plain(v).slice(0, 200) : "");
  const business = bz ? { type: bz.type, model: str(bz.model), drivers: str(bz.drivers), implication: str(bz.implication) } : null;
  // 正文以 JSON 里的 summary 为准；小模型常无视字数、写长篇带标题的正文，没给 summary 时只取正文第一段并截断
  const summary = obj && typeof obj.summary === "string" ? plain(obj.summary) : "";
  return { reply: (summary || briefOf(reply)).slice(0, 240), picks, business };
}

// 结论旁的迷你图：模型只能从白名单里挑指标 key，前端用真实财报画图（数字永远不由模型给）
const METRIC_RULE = "可选带一个 metric：从这份白名单里选这句话正在讲的那个指标，前端会在旁边画出它的历年迷你图供用户核对——"
  + METRIC_KEYS.map((k) => `${k}（${METRICS[k].zh}）`).join("、")
  + "。这句话讲的不是其中某个指标（如估值倍数、折现率、行业）就不要带 metric，不要为了配图硬选，也不要编造白名单以外的 key。";
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
  if (badVerified(body.verified) || badVerified(body.metrics) || badVerified(body.comparisons) || badVerified(body.market) || badVerified(body.lenses) || badVerified(body.business)) return "bad facts";
  if (JSON.stringify(body).length > 20000) return "body too large";
  return null;
}
export function buildReviewPrompt(body, lang) {
  const { stock, method, fields, result, valuedAt, verified, metrics, comparisons, market, lenses, business } = body;
  const zh = lang !== "en";
  const fieldLines = fields.map((f) => `- ${f.k}｜${f.label || f.k}｜${f.unit === "%" ? "百分数" : f.money ? "金额" : (f.unit || "数字")}｜当初填的：${fmtVal(f.value)}`).join("\n");
  return [
    "你是一位严谨的价值投资分析师，正在帮用户复核一张已保存的估值卡：用最新的财报数据检查当初的估值假设是否还成立。",
    zh ? "用中文回答。" : "Answer in English.",
    "",
    `标的：${stock.name}（${stock.code || ""}）　币种：${stock.currency || "未知"}　现价：${stock.price || "未知"}`,
    `估值方法：${method.label || method.key}　估值日期：${valuedAt || "未知"}　当初结论：合理价 ${result.low} ~ ${result.high}`,
    "",
    ...(Array.isArray(business) && business.length ? ["生意本身（公司简介与收入构成）：", ...business.map((x) => "- " + x), ""] : []),
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
    "4. 每项 check " + METRIC_RULE,
    "5. 正文不要罗列，结论全部放进回复最后的 ```json 代码块，格式严格如下：",
    '```json\n{"overall": "hold|watch|broken", "summary": "两三句话的总体判断（100 字以内）", "checks": [{"k": "字段k", "status": "ok|watch|broken", "reason": "一句话依据，写出最新实际数字和当初的假设，如：近三年营收复合 10.0%，低于保守 12%", "metric": "revenue"}]}\n```',
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
    const metric = metricKey(ck.metric);
    checks.push({ k: ck.k, status: ck.status, reason: typeof ck.reason === "string" ? plain(ck.reason).slice(0, 240) : "", ...(metric ? { metric } : {}) });
  }
  return { overall: obj.overall, summary: typeof obj.summary === "string" ? plain(obj.summary).slice(0, 400) : "", checks };
}

// ── 投资逻辑备注草稿：保存估值前，根据当前假设 + 与 AI 的对话，起草「为什么给这个估值」，用户改完再存 ──
const MAX_NOTE = 2000;
export function validateNoteReq(body) {
  if (!body || typeof body !== "object") return "bad body";
  const { context, messages, note } = body;
  if (!context || typeof context !== "object" || !Array.isArray(context.fields) || !context.fields.length || context.fields.length > 40) return "context.fields required";
  for (const f of context.fields) if (!f || typeof f.k !== "string" || (f.col !== "single" && f.col !== "dual")) return "bad field";
  if (badVerified(context.verified) || badVerified(context.market) || badVerified(context.lenses)) return "bad facts";
  if (messages !== undefined) {
    if (!Array.isArray(messages) || messages.length > MAX_MSGS) return "bad messages";
    for (const m of messages) if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.content.length > MAX_CHARS) return "bad message";
  }
  if (note !== undefined && (typeof note !== "string" || note.length > MAX_NOTE)) return "bad note";
  if (JSON.stringify(body).length > 40000) return "body too large";
  return null;
}
export function buildNotePrompt(body, lang) {
  const c = body.context, zh = lang !== "en";
  const fieldLines = c.fields.map((f) => `- ${f.label || f.k}｜${f.unit === "%" ? "百分数" : f.money ? "金额" : (f.unit || "数字")}｜${fmtVal(f.value)}`).join("\n");
  const convo = Array.isArray(body.messages) && body.messages.length
    ? body.messages.map((m) => `${m.role === "user" ? "用户" : "AI"}：${String(m.content).replace(/```[\s\S]*?```/g, "（参数建议）").slice(0, 600)}`).join("\n") : "";
  return [
    "你是一位严谨的价值投资分析师，正在帮用户起草一张估值卡的「投资逻辑备注」：用户自己的话，记下为什么给这个估值，方便以后复核。",
    zh ? "用中文写。" : "Write in English.",
    "",
    `标的：${c.stock && c.stock.name || ""}（${c.stock && c.stock.code || ""}）　币种：${c.stock && c.stock.currency || "未知"}　现价：${c.stock && c.stock.price || "未知"}`,
    `估值方法：${c.method && c.method.label || ""}${c.facts && c.facts.currentConclusion ? "　当前结论：合理价 " + c.facts.currentConclusion : ""}`,
    "",
    "用户填的假设（名称｜单位｜值；两档为 保守 / 乐观）：",
    fieldLines,
    ...verifiedBlock(c.verified),
    ...viewsBlock(c.market, c.lenses),
    ...(convo ? ["", "用户和 AI 在估值工作台里的对话（摘录）：", convo] : []),
    ...(body.note && body.note.trim() ? ["", "用户已经写的备注（保留其中的观点，在此基础上补全）：", body.note.trim()] : []),
    "",
    "要求：",
    "1. 第一人称、写给未来的自己看，三到五行，每行一句，不要标题、不要 Markdown、不要编号以外的符号。",
    "2. 依次写：这是一家什么样的公司 / 为什么选这个方法；关键假设和依据（只挑最影响结论的一两个，写出数值）；什么情况出现说明逻辑不成立（可观察的信号，如「营收增速连续两年低于 X%」）。",
    "3. " + GROUNDING + "对话里用户表达过的判断优先保留。",
    zh ? "4. 总共 200 字以内。" : "4. Under 120 words in total.",
    "5. 只写备注本身，不给买卖建议，不要开场白。",
  ].join("\n");
}
export function parseNote(text) {
  const t = plain(String(text || "").replace(/```[\s\S]*?```/g, "")).replace(/\n{3,}/g, "\n\n").trim();
  return t ? t.slice(0, MAX_NOTE) : null;
}

// ── 基本面解读：把十年财报浓缩成三条要点 + 一两个风险（只用系统算好的事实，不做估值、不给买卖建议）──
export function validateBriefReq(body) {
  if (!body || typeof body !== "object") return "bad body";
  if (!body.stock || typeof body.stock.name !== "string") return "stock required";
  if (badVerified(body.verified) || badVerified(body.metrics) || badVerified(body.market) || badVerified(body.lenses)) return "bad facts";
  if (!(Array.isArray(body.verified) && body.verified.length) && !(Array.isArray(body.metrics) && body.metrics.length)) return "facts required";
  if (JSON.stringify(body).length > 20000) return "body too large";
  return null;
}
export function buildBriefPrompt(body, lang) {
  const { stock, verified, metrics, market, lenses } = body, zh = lang !== "en";
  return [
    "你是一位严谨的价值投资分析师。用户正在看一家公司的十年财报，想快速判断它值不值得深入研究。",
    zh ? "用中文回答。" : "Answer in English.",
    "",
    `公司：${stock.name}（${stock.code || ""}）　币种：${stock.currency || "未知"}`,
    ...verifiedBlock(verified),
    ...(Array.isArray(metrics) && metrics.length ? ["", "最新实际数据（系统根据财报计算，以此为准）：", ...metrics.map((x) => "- " + x)] : []),
    ...viewsBlock(market, lenses),
    "",
    "规则：",
    "1. 只依据上面的数据：" + GROUNDING,
    "2. 三条要点：分别讲生意质量（盈利能力 / 现金含量）、增长、财务稳健度，每条一句话并带上关键数字；数据里没有的方面换成数据里最突出的特点。",
    "3. 一到两个风险：只写数据里能看出来的（如现金流波动、负债上升、增速放缓、盈利依赖少数年份），不要泛泛而谈行业风险。",
    "4. 不估值、不给买卖建议、不预测股价。",
    "5. 每条要点和风险" + METRIC_RULE,
    "6. 全部放进回复最后的 ```json 代码块，格式严格如下：",
    '```json\n{"points": [{"text": "要点一", "metric": "roe"}, {"text": "要点二", "metric": "revenue"}, {"text": "要点三"}], "risks": [{"text": "风险一", "metric": "netDebt"}]}\n```',
  ].join("\n");
}
export function parseBrief(text) {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(text))) last = m;
  let obj = null;
  try { obj = JSON.parse(last ? last[1] : text); } catch { return null; }
  // 每条统一成 {text, metric?}；老格式的纯字符串照收，未知 metric 丢掉只留文字
  const item = (x) => {
    const t = typeof x === "string" ? x : x && typeof x === "object" && typeof x.text === "string" ? x.text : "";
    if (!t.trim()) return null;
    const metric = typeof x === "object" ? metricKey(x.metric) : null;
    return { text: plain(t).slice(0, 240), ...(metric ? { metric } : {}) };
  };
  const list = (a, n) => (Array.isArray(a) ? a : []).map(item).filter(Boolean).slice(0, n);
  const points = list(obj && obj.points, 3), risks = list(obj && obj.risks, 2);
  return points.length ? { points, risks } : null;
}

// ── 资产页提问：把自然语言问题翻译成固定词表里的小查询（public/shared/pf-query.js），前端用真实数据本地执行 ──
// 隐私：请求里只有问题和可选值（账户名、币种），没有任何金额、数量或持仓列表；模型也不产出数字结论
import { PFQ_FIELDS, PFQ_OPS, PFQ_ZONES, PFQ_STATUS, PFQ_ACTIONS, PFQ_MARKETS, PFQ_GROUPS, PFQ_METRICS, validatePfQuery } from "../public/shared/pf-query.js";
const PFQ_NAME_RE = /^[^\n\r`]{1,40}$/;
export function validatePfReq(body) {
  if (!body || typeof body !== "object") return "bad body";
  if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 200) return "question must be 1-200 chars";
  if (!Array.isArray(body.accounts) || body.accounts.length > 20 || body.accounts.some((a) => typeof a !== "string" || !PFQ_NAME_RE.test(a))) return "bad accounts";
  if (!Array.isArray(body.currencies) || body.currencies.length > 10 || body.currencies.some((c) => typeof c !== "string" || !/^[A-Z]{3}$/.test(c))) return "bad currencies";
  return null;
}
export function buildPfPrompt(body, lang) {
  const zh = lang !== "en";
  const vals = { zone: PFQ_ZONES, market: PFQ_MARKETS, currency: body.currencies, account: body.accounts, driftStatus: PFQ_STATUS, action: PFQ_ACTIONS };
  const desc = {
    zone: "估值区间：deep 击球区、under 低估、fair 合理、over 高估、xover 泡沫区、none 未估值", market: "市场：US 美股、HK 港股、CN A 股", currency: "交易币种", account: "所在券商账户（一只股票可在多个账户）",
    weight: "占总资产（含现金）的百分比，填 10 表示 10%", target: "目标仓位 %（没设目标的为空）", drift: "当前占比 − 目标，百分点；正 = 超配",
    driftStatus: "相对目标：over 超配、under 低配、ok 在容忍带内、build 计划建仓（设了目标还没持有）、none 没设目标",
    action: "建议动作：trimHot 超配且高估、trimHold 超配但低估、trim 超配、addCheap 低配且便宜、addWait 低配但贵、add 低配、build / buildCheap 计划建仓、ok、none 没设目标",
    pnlPct: "浮动盈亏 %，亏 20% 填 -20", value: "市值（只能用于排序和求和，不知道具体金额，不要用它做数值过滤）", valued: "是否已设估值区间", held: "是否已持有（false = 计划建仓）",
    name: "名称（子串匹配）", ticker: "代码（如 AAPL、00700）",
  };
  const fieldLines = Object.entries(PFQ_FIELDS).map(([k, f]) => `- ${k}｜${f.type}｜${desc[k]}｜运算符：${PFQ_OPS[f.type].join(" / ")}${vals[k] ? "｜取值：" + (vals[k].length ? vals[k].join(", ") : "（无）") : ""}`).join("\n");
  return [
    "你是一个查询翻译器：把用户关于自己持仓组合的问题翻译成一个 JSON 查询，由页面用真实数据在本地执行。你看不到任何持仓和金额，也不要回答问题本身。",
    "",
    "字段（字段｜类型｜含义｜运算符｜取值）：",
    fieldLines,
    "",
    "运算符：eq 等于、ne 不等于、in 属于列表（value 是数组）、gt / gte / lt / lte 大于 / 大于等于 / 小于 / 小于等于、contains 包含。",
    "视图 view：",
    "- table：列出符合条件的持仓（可加 sort {field, dir: asc|desc} 和 limit）；「最大 / 最重的 N 只」用 sort weight desc + limit。",
    `- donut：符合条件的持仓按 groupBy 分组看市值分布，groupBy 取 ${PFQ_GROUPS.join(" / ")}。`,
    `- stat：一个数字，metric 取 ${PFQ_METRICS.join(" / ")}（count 只数、weight 占总资产 %、value 市值合计）；「X 占比多少」用 metric weight。`,
    "- none：问题和持仓数据无关、或无法用上面的字段表达时，用 say 写一句话说明（不要编数字）。",
    "",
    "规则：",
    "1. 只能用上面的字段、运算符和取值，不要发明；多个过滤条件是「并且」关系；「高估区」通常指 over 和 xover 两档。",
    "2. title 是一句话标题，复述用户想看什么（" + (zh ? "中文，20 字以内" : "English, under 8 words") + "），不含任何数字结论。",
    "3. 只输出一个 ```json 代码块，不要其他文字。格式：",
    '```json\n{"view": "table", "filter": [{"field": "zone", "op": "in", "value": ["over", "xover"]}, {"field": "driftStatus", "op": "eq", "value": "over"}], "sort": {"field": "weight", "dir": "desc"}, "title": "高估区里超配的持仓"}\n```',
    "其他例子：「港股占比多少？」→ {\"view\":\"stat\",\"metric\":\"weight\",\"filter\":[{\"field\":\"market\",\"op\":\"eq\",\"value\":\"HK\"}],\"title\":\"港股占总资产比例\"}；「哪些股票还没估值？」→ {\"view\":\"table\",\"filter\":[{\"field\":\"valued\",\"op\":\"eq\",\"value\":false}],\"title\":\"还没估值的持仓\"}；「各账户分布」→ {\"view\":\"donut\",\"groupBy\":\"account\",\"filter\":[],\"title\":\"各账户市值分布\"}",
  ].join("\n");
}
// → { query } | null（解析失败、未知字段 / 运算符 / 取值都算失败）
export function parsePfQuery(text, body) {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(text))) last = m;
  let obj = null;
  try { obj = JSON.parse(last ? last[1] : String(text).trim()); } catch { return null; }
  const r = validatePfQuery(obj, { accounts: body.accounts, currencies: body.currencies });
  if (r.error) return null;
  if (r.query.view === "none") r.query.say = plain(r.query.say);
  r.query.title = plain(r.query.title);
  return r;
}
function registerPortfolioQuery(app, runChat) {
  app.post("/api/my/ai/portfolio-query", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validatePfReq(body);
    if (err) return c.json({ error: err }, 400);
    const lang = body.lang === "en" ? "en" : "zh";
    const { text, res } = await runChat(c, buildPfPrompt(body, lang), [{ role: "user", content: body.question.trim() }]);
    if (res) return res;
    const r = parsePfQuery(text, body);
    if (!r) return c.json({ error: "bad_ai_output" }, 502);
    return c.json({ query: r.query });
  });
}
// ── 资产页提问 end ──

// ── 用户的模型：设置页只管「配置了哪些」（ai_models 表，可多条），AI 面板里切「用哪个」（settings 内部键 _ai_active）──
// 不用配置就能选的：站点默认（"default"）+ 几个 Workers AI 模型（"wa:<模型 id>"，走站点的 Workers AI 额度）
// 用户自己加的 OpenAI 兼容 / Anthropic 模型：id 为 "m:<行 id>"，Key 用 CREDENTIALS_KEY 加密，接口永不返回明文
export const WORKERS_MODELS = [
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B" },
];
// 站点 Key 的免费模型：站长配了对应的 secret 才出现在列表里（走站点的 Key，同样受每人每天次数限制）
export const SITE_KEY_MODELS = [
  { id: "zhipu-glm-4.7-flash", label: "智谱 GLM-4.7-Flash", model: "glm-4.7-flash", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "ZHIPU_API_KEY" },
];
export const siteKeyModels = (env) => SITE_KEY_MODELS.filter((m) => env && env[m.keyEnv]);
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
  if (active.startsWith("sk:")) {
    const m = siteKeyModels(env).find((x) => x.id === active.slice(3));
    if (m) return { cfg: { provider: "openai", model: m.model, baseUrl: m.baseUrl, apiKey: env[m.keyEnv] }, own: false, active };
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

// 免费额度用完 / 容量不足：4006（daily free allocation of neurons）、3040（Out of Capacity）、429
export function isWorkersQuotaError(e) {
  const m = String(e && (e.message || e) || "");
  return /\b(4006|3040|429)\b/.test(m) || /neurons?|free allocation|out of capacity|capacity temporarily exceeded|rate limit/i.test(m);
}

export function registerAi(app, { chat = chatComplete } = {}) {
  // 用当前用户的模型配置调用；自己的 Key 不占站点每日额度。返回 { text } 或 { res }（错误响应）
  async function runChat(c, system, messages) {
    let u;
    try { u = await userAi(c.env, c.get("uid")); } catch { return { res: c.json({ error: "ai_settings_unreadable", detail: "saved API key can't be decrypted — re-enter it in settings" }, 500) }; }
    if (!u.own && !(await takeQuota(c.env, c.get("uid")))) return { res: c.json({ error: "daily_limit" }, 429) };
    try { return { text: await chat(c.env, system, messages, undefined, u.cfg) }; }
    catch (e) {
      // Workers AI 账号每天的免费额度（10,000 Neurons，全站共用）用完：单独报 site_quota，前端提示「早上 8 点恢复 / 配自己的模型」
      if (u.cfg.provider === "workers-ai" && isWorkersQuotaError(e)) return { res: c.json({ error: "site_quota" }, 429) };
      return { res: c.json({ error: "ai_failed", detail: String(e && e.message || e).slice(0, 300) }, 502) };
    }
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
      active: u.active, dailyLimit: DAILY_LIMIT,
      site: { id: "default", kind: "site", provider: site.provider, model: site.model, name: site.provider === "workers-ai" ? wm(site.model) : site.model },
      workers: WORKERS_MODELS.map((m) => ({ id: "wa:" + m.id, kind: "workers-ai", name: m.label, model: m.id })),
      siteKey: siteKeyModels(c.env).map((m) => ({ id: "sk:" + m.id, kind: "site-key", name: m.label, model: m.model })),
      custom,
    });
  });
  // 切换当前用的模型
  app.put("/api/my/ai/active", async (c) => {
    const uid = c.get("uid"), b = await c.req.json().catch(() => ({}));
    const id = typeof b.id === "string" ? b.id : "";
    const ok = id === "default" || (id.startsWith("wa:") && WORKERS_MODELS.some((m) => "wa:" + m.id === id))
      || (id.startsWith("sk:") && siteKeyModels(c.env).some((m) => "sk:" + m.id === id))
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
    const picks = parsePicks(text, body.methods);
    if (!picks.picks.length && !picks.reply) return c.json({ error: "bad_ai_output" }, 502); // 模型偶尔吐出空的 / 不成形的结果：让前端提示重试，而不是显示一块空白
    return c.json(picks);
  });
  app.post("/api/my/ai/note", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validateNoteReq(body);
    if (err) return c.json({ error: err }, 400);
    const lang = body.lang === "en" ? "en" : "zh";
    const { text, res } = await runChat(c, buildNotePrompt(body, lang), [{ role: "user", content: lang === "en" ? "Draft the investment-thesis note for this valuation." : "帮我起草这张估值卡的投资逻辑备注。" }]);
    if (res) return res;
    const note = parseNote(text);
    if (!note) return c.json({ error: "bad_ai_output" }, 502);
    return c.json({ note });
  });
  app.post("/api/my/ai/brief", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validateBriefReq(body);
    if (err) return c.json({ error: err }, 400);
    const lang = body.lang === "en" ? "en" : "zh";
    const { text, res } = await runChat(c, buildBriefPrompt(body, lang), [{ role: "user", content: lang === "en" ? "Summarize these fundamentals." : "帮我解读这家公司的基本面。" }]);
    if (res) return res;
    const brief = parseBrief(text);
    if (!brief) return c.json({ error: "bad_ai_output" }, 502);
    return c.json({ brief: { ...brief, at: new Date().toISOString() } });
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
  registerPortfolioQuery(app, runChat); // 资产页提问
}
