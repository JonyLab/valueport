// Portfolio natural-language query translator (POST /api/my/ai/portfolio-query).
// Privacy: only question + account names + currencies leave the browser; no holdings or amounts.
import { PFQ_FIELDS, PFQ_OPS, PFQ_ZONES, PFQ_STATUS, PFQ_ACTIONS, PFQ_MARKETS, PFQ_GROUPS, PFQ_METRICS, validatePfQuery } from "../../public/shared/pf-query.js";
import { plain, parseFencedJson } from "./shared.js";

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
  const obj = parseFencedJson(text);
  if (!obj) return null;
  const r = validatePfQuery(obj, { accounts: body.accounts, currencies: body.currencies });
  if (r.error) return null;
  if (r.query.view === "none") r.query.say = plain(r.query.say);
  r.query.title = plain(r.query.title);
  return r;
}

export function registerPortfolioQuery(app, runChat) {
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
