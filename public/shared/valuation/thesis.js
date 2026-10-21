// Shared by the editor, saved cards and API validation. Empty fields are optional.
export const THESIS_LIMIT = 800;
export const THESIS_SCENARIOS = [
  { key: "c", zh: "保守场景", en: "Conservative case" },
  { key: "o", zh: "乐观场景", en: "Optimistic case" },
];
export const THESIS_FIELDS = [
  { key: "story", step: 1, zh: "核心判断", en: "Business thesis", placeholderZh: "先描述生意：产品、客户、管理层与竞争会如何变化？本场景成立需要什么前提？", placeholderEn: "Start with the business: products, customers, management and competition. What makes this case possible?" },
  { key: "assessment", step: 2, zh: "叙事检验", en: "Test the story", placeholderZh: "常识、历史与竞争格局支持这个叙事吗？哪些证据相反，哪些仍待核实？", placeholderEn: "Do history, competition and common sense support this case? What contradicts it or remains unverified?" },
  { key: "drivers", step: 3, zh: "关键假设", en: "Key assumptions", placeholderZh: "把叙事翻译成增长、利润率、再投资和风险的方向；量化后补充取值依据。", placeholderEn: "Translate the story into growth, margins, reinvestment and risk. Add numerical assumptions once justified." },
  { key: "signals", step: 5, zh: "验证条件", en: "What to watch", placeholderZh: "跟踪哪些经营指标？什么变化会让你先修正叙事，再更新数字？", placeholderEn: "What will you track? What changes would make you revise the story and then update the numbers?" },
];

export const THESIS_RESEARCH_FIELDS = [
  { key: "evidence", zh: "已有依据", en: "Supporting evidence" },
  { key: "uncertainties", zh: "还没证实", en: "Still unverified" },
];
// These are research categories, not numerical assumptions or model defaults.
export const THESIS_IMPACTS = [
  { key: "growth", zh: "收入与盈利增长", en: "Revenue & earnings growth", metas: ["revGrowth", "niGrowth", "epsGrowth", "ebitdaGrowth", "fcfGrowth"], pattern: /新品|产品|客户|订单|海外|渠道|扩张|需求|销量|收入|增长|product|customer|order|overseas|expan|demand|revenue|growth/i },
  { key: "margin", zh: "利润率", en: "Profit margins", metas: ["opMargin", "netMargin"], pattern: /成本|费用|效率|规模效应|定价|价格|利润率|cost|efficien|pricing|margin/i },
  { key: "reinvestment", zh: "扩张需要的投入", en: "Investment needed to grow", metas: ["salesToCap", "reinvest"], pattern: /扩张|产能|工厂|投入|投资|资本开支|expan|capacity|factor|invest|capex/i },
  { key: "risk", zh: "经营与融资风险", en: "Business & financing risk", metas: ["wacc", "costOfEquity"], pattern: /竞争|不确定|风险|负债|融资|周期|compet|uncertain|risk|debt|financ|cyclic/i },
  { key: "returns", zh: "资本回报", en: "Returns on capital", metas: ["targetPB"], pattern: /资本回报|净资产收益|ROE|ROIC|return on/i },
  { key: "payout", zh: "分红能力", en: "Dividend capacity", metas: ["divGrowth"], pattern: /股息|分红|派息|dividend|payout/i },
];
export const IMPACT_DIRECTIONS = ["up", "flat", "down", "unknown"];

export function suggestedImpacts(story) {
  // Wording suggests topics only: never infer a direction or fill a value.
  return THESIS_IMPACTS.filter((item) => item.pattern.test(String(story || ""))).map(({ key }) => key);
}

export function impactDirection(key, direction, lang = "zh") {
  if (lang === "en") return ({ up: "Increase", flat: "Stable", down: "Decrease", unknown: "Not sure yet" })[direction] || "Not sure yet";
  const labels = key === "growth" ? { up: "加快", flat: "稳定", down: "放缓" }
    : key === "risk" ? { up: "上升", flat: "不变", down: "下降" }
    : key === "reinvestment" ? { up: "增加", flat: "不变", down: "减少" }
    : { up: "改善", flat: "稳定", down: "下降" };
  return labels[direction] || "还不确定";
}

export function impactParameterHint(key, fields, modelKey, lang = "zh") {
  const impact = THESIS_IMPACTS.find((item) => item.key === key);
  const labels = (fields || []).filter((field) => impact?.metas.includes(field.meta)).map((field) => field.label?.[lang] || field.k);
  const zh = lang !== "en";
  if (labels.length) return (zh ? "量化时对应：" : "Inputs to consider: ") + labels.join(zh ? "、" : ", ") + (key === "returns" ? (zh ? "；先用 ROE 与资本成本检验倍数，不直接套数。" : "; assess the multiple against ROE and cost of equity.") : "");
  if (!modelKey) return zh ? "选择估值方法后，再找到对应参数；现在不用填数字。" : "Choose a method later to find matching inputs. No numbers needed yet.";
  if (modelKey === "pb") return zh ? "P/B 不直接预测这项变化。先说明它如何影响 ROE 或风险，再判断目标 PB；需要单独量化时可换用其他方法。" : "P/B does not forecast this directly. Explain its effect on ROE or risk before choosing a multiple, or use another method.";
  return zh ? "当前方法没有直接对应的参数；保留这条判断，检查方法是否能表达它，不必硬塞进某个数字。" : "This method has no direct input for this topic. Keep the judgment and consider whether another method represents it better.";
}

// 参数旁的提示：这个参数对应叙事里的哪项影响，两个场景各自判断的方向和原因。只复述用户的判断，不推算数值。
export function fieldStoryHint(meta, thesis, lang = "zh") {
  const impact = THESIS_IMPACTS.find((item) => item.metas.includes(meta));
  if (!impact) return null;
  const zh = lang !== "en", parts = [];
  for (const scenario of THESIS_SCENARIOS) {
    const item = (thesis?.[scenario.key]?.impacts || []).find((x) => x.key === impact.key);
    if (!item || (item.direction === "unknown" && !item.reason)) continue;
    const reason = item.reason ? (zh ? `（${item.reason}）` : ` (${item.reason})`) : "";
    parts.push(`${zh ? scenario.zh : scenario.en} ${impactDirection(impact.key, item.direction, lang).toLowerCase()}${reason}`);
  }
  if (!parts.length) return null;
  return (zh ? `你的叙事：${impact.zh} — ` : `Your story: ${impact.en} — `) + parts.join(zh ? "；" : "; ");
}

function cleanFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const { key } of [...THESIS_FIELDS, ...THESIS_RESEARCH_FIELDS]) {
    const text = typeof raw[key] === "string" ? raw[key].trim().slice(0, THESIS_LIMIT) : "";
    if (text) out[key] = text;
  }
  if (Array.isArray(raw.impacts)) {
    const seen = new Set();
    const impacts = raw.impacts.filter((item) => item && THESIS_IMPACTS.some(({ key }) => key === item.key) && !seen.has(item.key) && seen.add(item.key))
      .slice(0, THESIS_IMPACTS.length).map((item) => ({ key: item.key, direction: IMPACT_DIRECTIONS.includes(item.direction) ? item.direction : "unknown", reason: typeof item.reason === "string" ? item.reason.trim().slice(0, THESIS_LIMIT) : "" }));
    if (impacts.length) out.impacts = impacts;
  }
  return out;
}

export function cleanThesis(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const { key } of THESIS_SCENARIOS) {
    const fields = cleanFields(raw[key]);
    if (Object.keys(fields).length) out[key] = fields;
  }
  // A previous shared story cannot be attributed to either case automatically.
  const legacy = cleanFields(raw.legacy || raw);
  if (Object.keys(legacy).length) out.legacy = legacy;
  return out;
}

export function thesisEntries(fields, lang = "zh") {
  const label = (field) => lang === "en" ? field.en : field.zh;
  const entries = [...THESIS_FIELDS.slice(0, 2), ...THESIS_RESEARCH_FIELDS, THESIS_FIELDS[2]]
    .filter(({ key }) => fields?.[key]).map((field) => ({ label: label(field), text: fields[field.key] }));
  for (const item of fields?.impacts || []) {
    const impact = THESIS_IMPACTS.find(({ key }) => key === item.key);
    if (impact) entries.push({ label: label(impact), text: impactDirection(item.key, item.direction, lang) + (item.reason ? `：${item.reason}` : "") });
  }
  if (fields?.signals) entries.push({ label: label(THESIS_FIELDS[3]), text: fields.signals });
  return entries;
}

export function thesisLines(raw, lang = "zh") {
  const thesis = cleanThesis(raw);
  const scenarios = [...THESIS_SCENARIOS, { key: "legacy", zh: "未分场景的旧记录", en: "Previous shared notes" }];
  return scenarios.flatMap((s) => thesisEntries(thesis[s.key], lang).map((f) => `${lang === "en" ? s.en : s.zh} · ${f.label}：${f.text}`));
}
