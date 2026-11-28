// Shared AI prompt grounding, request validation helpers, and fenced-JSON extraction.
import { METRICS, METRIC_KEYS } from "../../public/shared/metric-spark.js";
import { THESIS_FIELDS, THESIS_RESEARCH_FIELDS, THESIS_IMPACTS, IMPACT_DIRECTIONS, THESIS_LIMIT } from "../../public/shared/valuation/thesis.js";

export const MAX_MSGS = 20;
export const MAX_CHARS = 4000;

export const SYNTHESIS = "综合三方面判断：基本面事实、市场投研、大师方法视角；它们不一致时说清你更看重哪一方、为什么（例如分析师看多但大师指标显示偏贵）。不要声称某位大师本人对这只股票说过什么或怎么估值，只能说「按 X 的方法看」。";
export const GROUNDING = "凡是涉及现金流 / 盈利是否稳定、是否分红、增长快慢、负债多少的判断，都必须与「已核实的事实」一致；事实里没有的不要断言，不要编造任何数字或经营情况。";

// 结论旁的迷你图：模型只能从白名单里挑指标 key，前端用真实财报画图（数字永远不由模型给）
export const METRIC_RULE = "可选带一个 metric：从这份白名单里选这句话正在讲的那个指标，前端会在旁边画出它的历年迷你图供用户核对——"
  + METRIC_KEYS.map((k) => `${k}（${METRICS[k].zh}）`).join("、")
  + "。这句话讲的不是其中某个指标（如估值倍数、折现率、行业）就不要带 metric，不要为了配图硬选，也不要编造白名单以外的 key。";

export const num = (n) => (typeof n === "number" && Number.isFinite(n)) ? String(n) : "（空）";
export const fmtVal = (v) => (v && typeof v === "object") ? `保守 ${num(v.c)} / 乐观 ${num(v.o)}` : num(v);

// 界面不渲染 Markdown：去掉 **粗体**、__粗体__、`代码`、行首 # 标题
export const plain = (t) => String(t || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^#{1,6}\s+/gm, "").trim();

// 已核实的事实：前端由财报算好的短句（≤20 条，每条 ≤300 字）
export function badVerified(v) {
  return v !== undefined && (!Array.isArray(v) || v.length > 20 || v.some((x) => typeof x !== "string" || x.length > 300));
}

export function verifiedBlock(v) {
  if (!Array.isArray(v) || !v.length) return [];
  return ["", "已核实的事实（系统根据财报计算，以此为准）：", ...v.map((x) => "- " + x)];
}

// 市场投研（分析师评级 / 目标价 / 一致预期）与大师方法视角（格雷厄姆 / 林奇 / 巴菲特式指标），都由前端按数据算好
export function viewsBlock(market, lenses) {
  const out = [];
  if (Array.isArray(market) && market.length) out.push("", "市场投研（来自长桥：分析师评级、目标价、一致预期）：", ...market.map((x) => "- " + x));
  if (Array.isArray(lenses) && lenses.length) out.push("", "大师方法视角（系统按公开方法论计算）：", ...lenses.map((x) => "- " + x));
  return out;
}

export function badThesis(raw) {
  if (raw === undefined) return false;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return true;
  const badFields = (value) => !value || typeof value !== "object" || Array.isArray(value)
    || [...THESIS_FIELDS, ...THESIS_RESEARCH_FIELDS].some(({ key }) => value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > THESIS_LIMIT))
    || (value.impacts !== undefined && (!Array.isArray(value.impacts) || value.impacts.length > THESIS_IMPACTS.length || value.impacts.some((item) => !item
      || !THESIS_IMPACTS.some(({ key }) => key === item.key) || !IMPACT_DIRECTIONS.includes(item.direction)
      || typeof item.reason !== "string" || item.reason.length > THESIS_LIMIT)));
  return badFields(raw) || ["c", "o", "legacy"].some((key) => raw[key] !== undefined && badFields(raw[key]));
}

// 抽取回复里最后一个 ```json 代码块（返回正则匹配对象或 null）
export function lastJsonFence(text) {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(String(text || "")))) last = m;
  return last;
}

// 从最后一个 ```json 代码块或纯 JSON 正文中解析对象；失败返回 null
export function parseFencedJson(text) {
  const raw = String(text || "");
  const last = lastJsonFence(raw);
  try { return JSON.parse(last ? last[1] : raw.trim()); } catch { return null; }
}

// 模型输出被截断或围栏不规整时，尽量把最后一个 JSON 对象救回来：围栏少一个反引号、没有收尾围栏、
// 末尾截在半个字符串或半个键值上都能补齐（去掉最后一个不完整的成员，再补上缺的引号和括号）
export function salvageJson(text) {
  const t = String(text || "");
  const start = t.search(/\{\s*"(params|picks|business|overall|points|view|summary|widgets)"/);
  if (start < 0) return null;
  let body = t.slice(start).replace(/`{2,3}\s*$/, "");
  try { return JSON.parse(body); } catch { /* 往下修 */ }
  const stack = []; let inStr = false, esc = false, cut = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") { stack.pop(); if (!stack.length) { try { return JSON.parse(body.slice(0, i + 1)); } catch { return null; } } }
    else if (ch === ",") cut = i;
  }
  if (cut < 0) return null;
  const head = body.slice(0, cut);
  const st = []; inStr = false; esc = false;
  for (const ch of head) {
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === "{" || ch === "[") st.push(ch); else if (ch === "}" || ch === "]") st.pop();
  }
  const closed = head + (inStr ? '"' : "") + st.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
  try { return JSON.parse(closed); } catch { return null; }
}
