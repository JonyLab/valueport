// Business classification and valuation method recommendation (POST /api/my/ai/method, with optional Jev engine).
import { METHOD_RULES } from "../../public/shared/valuation/index.js";
import { methodReadiness } from "../../public/shared/valuation/method-readiness.js";
import { managementPrompt } from "../../public/shared/valuation/management-research.js";
import { cleanThesis, thesisLines } from "../../public/shared/valuation/thesis.js";
import { recommendWithJev } from "../jev-methods.js";
import { GROUNDING, SYNTHESIS, plain, badVerified, verifiedBlock, viewsBlock, badThesis, lastJsonFence } from "./shared.js";

export function validateMethodReq(body) {
  if (!body || typeof body !== "object") return "bad body";
  const { stock, methods } = body;
  if (!stock || typeof stock !== "object" || typeof stock.name !== "string") return "stock required";
  if (!Array.isArray(methods) || !methods.length || methods.length > 30) return "methods required";
  for (const m of methods) if (!m || typeof m.key !== "string" || typeof m.title !== "string") return "bad method";
  if (badVerified(body.verified) || badVerified(body.market) || badVerified(body.lenses) || badVerified(body.business)) return "bad verified facts";
  if (badThesis(body.thesis)) return "bad thesis";
  if (JSON.stringify(body).length > 60000) return "body too large"; // 含两个场景的叙事
  return null;
}

// 生意类型：先看懂公司怎么赚钱，再按类型选方法（参考林奇的六类公司 + 金融、公用事业）。
// avoid：这类公司不该用的方法——即使模型选了，也在服务端剔除（开源模型常无视规则）。
export const BUSINESS_TYPES = {
  cyclical: { zh: "资源与周期", en: "Cyclical / commodity", desc: "矿业、油气、航运、钢铁、化工、养殖等，盈利随商品价格或行业周期大起大落", play: "首选资源股 NAV（有可估储量的资源资产）或 EV/EBITDA（用中周期口径）；P/E 只能用正常化的中周期利润；不要用 PEG、不要用当期高景气利润外推增速——林奇也把周期股单列，周期股市盈率最低时往往是周期顶点", avoid: ["peg", "ps"] },
  financial: { zh: "金融", en: "Financial", desc: "银行、保险、券商等，资产负债表就是生意本身", play: "首选 P/B（结合 ROE 看能撑多高的 PB）；长期高分红的可用 DDM；P/E 作交叉验证；不用自由现金流类和 EV/EBITDA、P/S", avoid: ["fcff", "fcf", "fcfe", "evebitda", "ps", "evsales", "apv", "tobinq", "sector"] },
  utility: { zh: "公用事业 / 类债券", en: "Utility / bond-like", desc: "电力、水务、燃气、收费公路、电信运营等，价格受管制、现金流稳定", play: "首选 DDM 或 DCF 自由现金流；P/E 作交叉验证；不用 PEG、P/S", avoid: ["peg", "ps"] },
  stalwart: { zh: "成熟稳健", en: "Stalwart", desc: "行业龙头，增长中低速、盈利与现金流稳定", play: "首选 DCF 自由现金流或 P/E；分红率高的可加 DDM 交叉验证；不用 P/S", avoid: ["ps"] },
  fast_grower: { zh: "高速成长", en: "Fast grower", desc: "已经盈利、收入利润快速增长", play: "首选分阶段的 FCFF / DCF 或 P/E（配合增速）；PEG 作交叉验证；不用 DDM、P/B", avoid: ["ddm", "pb"] },
  unprofitable: { zh: "未盈利成长 / 困境反转", en: "Unprofitable / turnaround", desc: "尚未盈利或刚经历大亏、正在扭转", play: "首选 P/S 或 EV/Sales；FCFF 用情景假设作交叉验证；不用 P/E、PEG、DDM", avoid: ["pe", "peg", "ddm"] },
  asset_play: { zh: "资产型 / 多元控股", en: "Asset play / holding", desc: "价值主要在资产或多项业务（地产、控股集团、多元化公司）", play: "多业务集团可用 SOTP 分部加总；各分部选择适合的方法。资产变现问题用清算价值或 NCAV；账面资产有经济意义时考虑 P/B，不能把资源股 NAV 当作通用 SOTP；不用 PEG", avoid: ["peg", "ps"] },
  platform: { zh: "轻资产平台 / 品牌", en: "Asset-light platform / brand", desc: "高 ROE、强现金流的平台、软件、消费品牌", play: "首选 DCF 自由现金流或 FCFF；P/E 作交叉验证；分红率低时不用 DDM；不用 P/B", avoid: ["pb"] },
};

// 用户已经写好的两个场景叙事：方法要能表达叙事里的驱动力（例如叙事押在利润率上，方法里就要有利润率这个参数）
function storyBlock(thesis, lang) {
  const lines = thesisLines(cleanThesis(thesis), lang);
  return lines.length ? ["", "用户已写的场景叙事（是用户的判断，不是事实；选方法时让方法的参数能表达这些驱动力，并在 summary 里说明对应关系）：", ...lines.map((x) => "- " + x)] : [];
}

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
    ...storyBlock(body.thesis, lang),
    "", "已知数据：", factLines || "（无）",
    ...verifiedBlock(verified),
    managementPrompt(body.managementResearch, lang),
    ...viewsBlock(market, lenses),
    "",
    "生意类型（type｜名称｜特征｜估值做法）：",
    types,
    "",
    "可选方法（key｜名称｜适用场景）：",
    methods.map((m) => `- ${m.key}｜${m.title}｜${m.subtitle || ""}`).join("\n"),
    METHOD_RULES,
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
  const last = lastJsonFence(text);
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

export function registerMethodAi(app, runChat) {
  app.post("/api/my/ai/method", async (c) => {
    const body = await c.req.json().catch(() => null);
    const err = validateMethodReq(body);
    if (err) return c.json({ error: err }, 400);
    const lang = body.lang === "en" ? "en" : "zh";
    c.header("Cache-Control", "no-store");
    const jev = await recommendWithJev(c.env, c.get("uid"), body, BUSINESS_TYPES);
    const decided = jev.status === "used";
    const explanationBody = decided ? { ...body, methods: jev.picks.map((p) => body.methods.find((m) => m.key === p.key)) } : body;
    const decisionPrompt = decided ? "\n系统已确定方法顺序：" + jev.picks.map((p) => p.key).join("、")
      + "。只解释这些方法，保持顺序，不得重选或因缺数据删除方法。未知数据明确说需要补充，不能编造。"
      + (jev.classification.type ? " 生意类型已判定为：" + jev.classification.type : " 生意分类尚不确定，不要假装已经确认。") : "";
    const { text, res } = await runChat(c, buildMethodPrompt(explanationBody, lang) + decisionPrompt, [{ role: "user", content: lang === "en" ? "Which valuation methods fit this company?" : "这家公司适合用哪些估值方法？" }]);
    if (decided) {
      const explanation = res ? null : parsePicks(text, explanationBody.methods);
      const aligned = explanation?.picks.length === jev.picks.length && explanation.picks.every((p, i) => p.key === jev.picks[i].key);
      const business = jev.classification.type && explanation?.business?.type === jev.classification.type ? explanation.business : null;
      return c.json({ reply: aligned && explanation.reply ? explanation.reply : (lang === "en" ? "These methods were selected for business and story fit. Missing data can be added; assumptions need your confirmation." : "这些方法按业务特点与场景适配程度推荐。缺失数据可以补充，估值假设仍由你确认。"),
        business, decision: { engine: "jev", status: "used", model: jev.model, classification: jev.classification },
        picks: jev.picks.map((p) => ({ ...p, reason: aligned ? explanation.picks.find((x) => x.key === p.key)?.reason || p.reason : p.reason })) });
    }
    if (res) return res;
    const picks = parsePicks(text, body.methods);
    if (!picks.picks.length && !picks.reply) return c.json({ error: "bad_ai_output" }, 502);
    // 没配置 Jev 时保持原有 API；Jev 失败则显式标明回退，并保留原有推荐。
    return c.json(jev.status === "not_configured" ? picks : { ...picks,
      decision: { engine: "llm", status: "fallback", reason: jev.reason },
      picks: picks.picks.map((p) => ({ ...p, readiness: methodReadiness(p.key, body.facts, lang) })) });
  });
}
