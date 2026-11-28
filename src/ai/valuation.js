// Valuation workbench AI chat: validates context, builds method-aware prompts,
// parses parameter suggestions / interactive widgets / scenarios, and serves POST /api/my/ai/valuation.
import { METHOD_RULES, MODELS } from "../../public/shared/valuation/index.js";
import { cleanManagementResearch, managementPrompt } from "../../public/shared/valuation/management-research.js";
import { thesisLines } from "../../public/shared/valuation/thesis.js";
import { scenarioContext } from "../../public/shared/valuation/thesis-guide.js";
import { searchCompany, searchPrompt, searchMetadata } from "../web-search.js";
import { MAX_MSGS, MAX_CHARS, GROUNDING, fmtVal, plain, badVerified, verifiedBlock, viewsBlock, badThesis, lastJsonFence, salvageJson } from "./shared.js";

export function validateChat(body) {
  if (!body || typeof body !== "object") return "bad body";
  if (body.webSearch !== undefined && typeof body.webSearch !== "boolean") return "bad webSearch";
  const { messages, context } = body;
  if (context?.scenario !== undefined && !["c", "o"].includes(context.scenario)) return "bad scenario";
  if (context?.singleCase !== undefined && (context.singleCase !== true || context.scenario !== "c")) return "bad single case";
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MSGS) return "messages must be 1-20 items";
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || !m.content.trim() || m.content.length > MAX_CHARS) return "bad message";
  }
  if (messages[messages.length - 1].role !== "user") return "last message must be from user";
  if (!context || typeof context !== "object" || !Array.isArray(context.fields) || !context.fields.length || context.fields.length > (context.method?.key === "sotp" ? 240 : context.method?.key === "navsotp" ? 160 : 40)) return "context.fields required";
  if (badVerified(context.verified) || badVerified(context.market) || badVerified(context.lenses) || badVerified(context.business) || badVerified(context.metrics)) return "bad verified facts";
  if (badThesis(context.thesis)) return "bad thesis";
  if (context.managementResearch !== undefined && context.managementResearch !== null && !cleanManagementResearch(context.managementResearch)) return "bad management research";
  for (const f of context.fields) if (!f || typeof f.k !== "string" || (f.col !== "single" && f.col !== "dual")) return "bad field";
  if (JSON.stringify(context).length > (context.method?.key === "sotp" ? 120000 : 40000)) return "context too large"; // 含两个场景的完整叙事
  return null;
}

export function buildSystemPrompt(context, lang) {
  const c = context;
  const zh = lang !== "en";
  const fieldLines = c.fields.map((f) =>
    `- ${f.k}｜${f.label || f.k}｜${f.col === "dual" ? "保守/乐观两档" : "单值"}｜单位：${f.unit === "%" ? "百分数（填 12 表示 12%）" : (f.money ? "金额（原始数值，不带单位缩写）" : (f.unit || "数字"))}｜当前：${fmtVal(f.value)}${f.isDefault ? "（方法默认值，还没按这家公司调整）" : ""}`).join("\n");
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
    ...(Array.isArray(c.business) && c.business.length ? ["", "生意本身（公司简介与收入构成）：", ...c.business.map((x) => "- " + x)] : []),
    ...verifiedBlock(c.verified),
    managementPrompt(c.managementResearch, lang),
    METHOD_RULES,
    MODELS.find((model) => model.key === c.method?.key)?.guidance?.[lang === "en" ? "en" : "zh"] || "",
    ...(Array.isArray(c.metrics) && c.metrics.length ? ["", "最新实际数据与历史区间（系统根据财报计算，以此为准）：", ...c.metrics.map((x) => "- " + x)] : []),
    ...viewsBlock(c.market, c.lenses),
    ...(thesisLines(c.thesis, lang).length ? ["", "用户先形成的分场景叙事与检验：", ...thesisLines(c.thesis, lang),
      "先评估这些叙事是否符合常识与历史，再把每个叙事分别翻译成该场景的增长率、利润率、再投资和风险参数。逐项解释映射依据，不把两个叙事混用，不为凑当前股价或预定估值倒推理由；若叙事不可行或缺证据，先指出并建议修正叙事。"] : []),
    "",
    "当前方法的输入字段（k｜名称｜类型｜单位｜当前值）：",
    fieldLines,
    ...(c.method?.key === "navsotp" ? [
      "",
      "资源股 NAV 专用口径（优先于通用增速/利润率模板）：",
      "在产矿现值 = 权益年产量 × 商品单位换算 ×（长期商品价 − 完全成本）×（1 − 税率）× 年金系数(剩余寿命,WACC)。有限寿命、产量恒定、无永续价值，不额外加入增长率或终值。",
      "保守情景 = 较低长期商品价 + 较高 WACC；乐观情景 = 较高长期商品价 + 较低 WACC。WACC 保守值通常高于乐观值，不要套用通用的保守值更低规则。长期价格不是现货报价，默认价格不是已核实的当前行情。",
      "资产包、商品价格、完全成本与净负债都以人民币计价；黄金/白银产量为吨、价格为元/克，铜/锌产量为万吨、价格为元/吨；总股本为股。不得将美元/盎司、千吨、亿元直接当作表单原始单位。报价币种不等于资产模型币种，未提供汇率时不要虚构换算。",
      "固定值包是直接计入的现值，不再折现或重复加同一矿山；未开发储量期权由 Black–Scholes 计算，使用储量、边际成本、开发成本现值、波动率、期限、无风险利率，不用矿山 WACC 再折现；不能同时算进在产矿与期权。当前 UI 的资产产量/成本/寿命、固定现值、税率与净负债是两情景共用单值，只能给单值建议，不要伪造两档结构。",
      "用户要完整假设时，逐一覆盖：资产清单与权益口径、每种商品长期价格两档、每个在产矿的权益产量/完全成本/剩余寿命、固定值包依据、期权输入、WACC 两档、有效税率与净负债；说明哪些是用户输入、哪些是待核实假设、哪些来自给定公司资料。",
      "没有披露依据的矿名、权益产量、成本、储量、寿命、开发成本、负债不得凭公司名称补造，空值不可当零；列出具体待补数据及建议查阅的年报/储量报告/成本披露。可以给明确标注为情景假设的长期价格和折现率，并说明依据和局限，不能冒充实时事实。",
      "如果资产行仍是空的「主力矿」占位，不能据此认定这家公司只有铜矿，也不能宣称已给出公司完整 NAV。正文先指出缺失资产和数据；待补项写入对应 scenarios 的 drivers/signals。当前接口只能修改已列出的字段，不能自动新增/删除/更改商品种类；需要新资产时在文字里说明如何添加。",
      "理由与两档情景应解释商品周期、成本压力、储量消耗、矿权/国家风险及折现率选择；先检查是否有资产重复计价、权益产量混用、维持资本开支遗漏。资料不足时明确尚不能得出完整 NAV，不要编造计算结果。",
    ] : []),
    "",
    "规则：",
    "1. 只能建议上面列出的字段，不要发明字段；保守值应比乐观值更谨慎（增速、利润率、倍数更低；折现率更高）。",
    "2. 基于已知数据与行业常识给出合理假设；数据不足时说明你的假设前提，不要编造具体财务数字。" + GROUNDING,
    "3. 当你建议具体参数时，在回复最后附一个 ```json 代码块，格式严格如下（只含需要修改的字段）：",
    '```json\n{"params": {"单值字段k": 数字, "两档字段k": {"c": 保守数字, "o": 乐观数字}}, "reasons": {"字段k": "一句话理由"}, "scenarios": {"c": {"story": "保守情景的叙事", "drivers": ["关键假设一", "关键假设二"], "breaks": "这个情景最可能在哪里被证明错了", "signals": "后续要跟踪的信号"}, "o": {"story": "…", "drivers": ["…"], "breaks": "…", "signals": "…"}}}\n```',
    "   建议了保守 / 乐观两档参数时必须写 scenarios，分别对两个情景做有深度的分析，不要互相复制：",
    "   - story：2~3 句，这个情景下公司的生意会怎样发展——收入和利润由什么驱动、行业与竞争会怎样、管理层会怎么做，要和「生意本身」对得上，说清它发生的前提。",
    "   - drivers：2~4 条，每条对应一个关键假设，写清取这个值的依据（对照历史区间、一致预期、行业或大师视角），以及几个假设之间为什么自洽（如高增速需要更多再投资、利润率扩张需要规模效应）。不要只复述参数，要写「取多少 + 和实际 / 历史比怎样 + 为什么」，例如：「营收增速保守取 8%：低于近三年复合 10.6%，因为广告恢复放缓、游戏新品节奏不确定」。",
    "   - 每个假设都以「最新实际数据与历史区间」为锚：明显偏离最新实际值时（如利润率只有实际的一半、增速是历史的两倍），必须在 drivers 里写明为什么会偏离；没有理由就不要偏离。",
    "   - breaks：一句话，这个情景最可能落空的地方——保守情景说「哪里可能其实太悲观」，乐观情景说「哪里最容易兑现不了」。",
    "   - signals：一句话，未来几个季度财报或经营数据里，哪些具体指标会证实或证伪这个情景。",
    "   数字只能引用上面给出的数据和你建议的参数，不要编造新的财务数字；scenarios 里提到的每个假设值必须和 params 里的完全一致。",
    "   用户要「一套完整的假设」时：标了「方法默认值」的字段都要按这家公司重新判断并写进 params；两档字段的保守值和乐观值一般应该不同，相同时要在 drivers 里说明为什么。",
    "4. 如果用户只是提问、还不需要改参数，就不要放 params；只想给交互组件时代码块里只放 {\"widgets\": [...]}；两者都不需要就不要附代码块。不用组件时不要写 widgets 键；代码块一定要用三个反引号开头和结尾。",
    "5. 界面会把代码块渲染成参数表和两个情景卡片，所以正文里不要逐项罗列参数、也不要重复情景分析，只用两三句话讲清整体判断（150 字以内）；只建议需要改动的字段。",
    "6. 这只是估值辅助，不构成投资建议；不要给出买卖建议。",
    "",
    "可选的交互组件（放在同一个 ```json 代码块的 \"widgets\" 数组里，每次最多 2 个；不需要就不放）。组件只指定字段和步长，数值由界面用估值模型现算，你不要在组件或正文里写出计算结果：",
    '- 敏感性：{"type":"sensitivity","field":"字段k","steps":[-2,-1,0,1,2]} —— 只改这一个字段、其他输入不变，逐档算合理价。steps 是加减量，单位同字段（百分数字段 1 = 1 个百分点；金额字段按 % 变动）。用户问「X 变一点影响多大」「哪个假设最关键」时用。',
    '- 倍数对比：{"type":"peers","multiple":"pe"|"pb"|"ps"} —— 当前倍数 vs 自身 5 年均值 vs 行业中位。讨论目标倍数取多少、贵不贵时用。',
    '- 一键改值：{"type":"set","field":"字段k","value":数字 或 {"c":保守,"o":乐观},"label":"不超过 12 字的说明"} —— 生成「把 X 改成 Y」按钮，用户点了才写入、可撤销。只改一两个字段时用它代替 params。',
    "只能用上面三种 type 和上面列出的字段 k；组件之外正文保持简短（150 字以内）。",
    ...(["c", "o"].includes(c.scenario) ? [
      `单情景引导专用规则，覆盖前面两档输出规则：本轮只建议 ${c.singleCase ? "单一主情景" : c.scenario === "c" ? "保守" : "乐观"}（${c.scenario}）参数。不得生成、推断或使用另一情景的叙事、参数、价值作为本轮依据。`,
      `只输出当前情景字段：params 中两档字段的值只能为 {"${c.scenario}": 数字}；scenarios 也只能包含 ${c.scenario}。共用数据只有提供了来源才可建议；乐观轮不得改动共用基础数据。不要为了拉开两个估值而强制调整数字。`,
      c.singleCase ? "用户选择只做一套最合理的主情景估值，不把它改成保守预测，不要求再补乐观情景。判断和数字均须有条件和依据。" : "保守是审慎但合理的条件组合，稳定或温和增长也可以是保守；乐观须有实现条件和投入约束。缺少证据时保持缺口，不能编造数值。",
    ] : []),
  ].join("\n");
}

// ── 交互组件：模型只挑组件和字段，数值由前端算；未知或不合法的组件丢弃，最多 2 个 ──
const MAX_WIDGETS = 2;
const MULTIPLES = new Set(["pe", "pb", "ps"]);
const parseCleanNum = (v) => {
  const n = typeof v === "string" ? Number(v.replace(/[,%\s]/g, "")) : v;
  return (typeof n === "number" && Number.isFinite(n)) ? n : null;
};

export function parseWidgets(raw, fields) {
  if (!Array.isArray(raw)) return null;
  const byKey = new Map(fields.map((f) => [f.k, f]));
  const out = [];
  for (const w of raw) {
    if (out.length >= MAX_WIDGETS) break;
    if (!w || typeof w !== "object") continue;
    if (w.type === "sensitivity") {
      if (!byKey.has(w.field)) continue;
      let steps = Array.isArray(w.steps) ? w.steps.map(parseCleanNum).filter((n) => n !== null && Math.abs(n) <= 100) : [];
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
        if (w.value && typeof w.value === "object") { const c = parseCleanNum(w.value.c), o = parseCleanNum(w.value.o); if (c !== null && o !== null) value = { c, o }; }
        else { const n = parseCleanNum(w.value); if (n !== null) value = { c: n, o: n }; }
      } else value = parseCleanNum(w.value && typeof w.value === "object" ? w.value.c : w.value);
      if (value === null) continue;
      const label = typeof w.label === "string" ? w.label.trim().slice(0, 40) : "";
      out.push({ type: "set", field: w.field, value, ...(label ? { label } : {}) });
    }
  }
  return out.length ? out : null;
}

// 保守 / 乐观两个情景的分析：{ c: {story, drivers[], breaks, signals}, o: {…} }；两个都缺就不要
export function parseScenarios(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v, n) => (typeof v === "string" ? plain(v).slice(0, n) : "");
  const one = (x) => {
    if (!x || typeof x !== "object") return null;
    const out = { story: str(x.story, 400), drivers: (Array.isArray(x.drivers) ? x.drivers : []).map((d) => str(d, 220)).filter(Boolean).slice(0, 4),
      breaks: str(x.breaks || x.risks, 220), signals: str(x.signals || x.watch, 220) };
    return out.story || out.drivers.length ? out : null;
  };
  const ro = raw.o || raw.optimistic;
  if (ro && typeof ro === "object") { if (!ro.breaks && typeof raw.breaks === "string") ro.breaks = raw.breaks; if (!ro.signals && typeof raw.signals === "string") ro.signals = raw.signals; }
  const c = one(raw.c || raw.conservative), o = one(ro);
  return c || o ? { ...(c ? { c } : {}), ...(o ? { o } : {}) } : null;
}

// 从回复里取出最后一个 ```json 代码块，按字段表校验；返回 { reply（去掉代码块后的正文）, params, reasons, widgets? }
export function parseSuggestion(text, fields, scenario = null) {
  const last = lastJsonFence(text);
  let obj = null, reply;
  if (last) { try { obj = JSON.parse(last[1]); } catch { obj = null; } }
  if (obj) reply = plain(text.slice(0, last.index) + text.slice(last.index + last[0].length));
  else {
    // 没有完整围栏 / 被截断：从正文里救出 JSON，正文只留 JSON 之前的部分
    obj = salvageJson(text);
    if (!obj) return { reply: plain(text), params: null, reasons: null };
    const at = text.search(/`{0,3}\s*(json)?\s*\{\s*"(params|widgets|scenarios|reasons)"/);
    reply = plain(at >= 0 ? text.slice(0, at) : "");
  }
  const raw = obj && typeof obj === "object" ? (obj.params && typeof obj.params === "object" ? obj.params : obj) : null;
  if (!raw) return { reply, params: null, reasons: null };
  const widgets = parseWidgets(obj.widgets, fields);
  const byKey = new Map(fields.map((f) => [f.k, f]));
  const params = {};
  for (const [k, v] of Object.entries(raw)) {
    const f = byKey.get(k); if (!f) continue;
    if (f.col === "dual") {
      if (v && typeof v === "object") {
        const c = parseCleanNum(v.c ?? v.conservative), o = parseCleanNum(v.o ?? v.optimistic);
        if (scenario && (scenario === "c" ? c : o) !== null) params[k] = { [scenario]: scenario === "c" ? c : o };
        else if (!scenario && c !== null && o !== null) params[k] = { c, o };
      } else { const n = parseCleanNum(v); if (n !== null) params[k] = scenario ? { [scenario]: n } : { c: n, o: n }; }
    } else if (scenario !== "o") {
      const n = parseCleanNum(v && typeof v === "object" ? (v.value ?? v.c) : v); if (n !== null) params[k] = n;
    }
  }
  const reasons = {};
  if (obj.reasons && typeof obj.reasons === "object") {
    for (const [k, v] of Object.entries(obj.reasons)) if (params[k] !== undefined && typeof v === "string") reasons[k] = v.slice(0, 300);
  }
  const res = { reply, params: Object.keys(params).length ? params : null, reasons: Object.keys(reasons).length ? reasons : null };
  if (widgets) res.widgets = widgets; // 没有组件时不带这个键，老前端 / 老测试不受影响
  const scenarios = res.params ? parseScenarios(obj.scenarios) : null;
  if (scenarios) res.scenarios = scenario ? (scenarios[scenario] ? { [scenario]: scenarios[scenario] } : undefined) : scenarios;
  return res;
}

export function registerValuationAi(app, runChat) {
  app.post("/api/my/ai/valuation", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validateChat(body);
    if (err) return c.json({ error: err }, 400);
    const lang = body.lang === "en" ? "en" : "zh";
    const context = scenarioContext(body.context, body.context.scenario);
    let research;
    const { text, res } = await runChat(c, buildSystemPrompt(context, lang), body.messages.map((m) => ({ role: m.role, content: m.content })),
      body.webSearch ? async (system) => {
        research = await searchCompany(c.env, context);
        return system + searchPrompt(research);
      } : null);
    if (res) return res;
    c.header("Cache-Control", "no-store");
    return c.json({ ...parseSuggestion(text, context.fields, context.scenario), ...(research ? { research: searchMetadata(research) } : {}) });
  });
}
