import { MODELS, modeFields } from "./index.js";

const FACT_KEYS = {
  revenue: "latestAnnualRevenue", netIncome: "latestAnnualNetIncome", eps: "epsTtm", bps: "bookValuePerShare",
  dps: "dividendPerShare", fcf: "freeCashFlow", netDebt: "netDebt", ebitda: "ebitda",
};
const number = (v) => typeof v === "number" && Number.isFinite(v);

// 只检查数据是否存在，不按缺失程度排序，也不把示例参数当作用户已确认的假设。
export function methodReadiness(key, facts = {}, lang = "zh") {
  facts = facts && typeof facts === "object" ? facts : {};
  const model = MODELS.find((m) => m.key === key);
  if (!model) return null;
  const label = (value) => value?.[lang === "en" ? "en" : "zh"] || key;
  const fields = modeFields(model, model.defaultMode), missingInputs = [], assumptions = [];
  for (const field of fields) {
    const factKey = FACT_KEYS[field.k];
    if (factKey) {
      const actualKey = field.k === "revenue" ? Object.keys(facts).find((k) => k === factKey || k.startsWith(factKey + " (FY")) : factKey;
      if (!number(facts[actualKey])) missingInputs.push({ key: field.k, label: label(field.label) });
    } else if (field.money && field.col === "single" && field.default === undefined) missingInputs.push({ key: field.k, label: label(field.label) });
    else assumptions.push({ key: field.k, label: label(field.label) });
  }
  if (!["peg", "pb", "ddm"].includes(key) && !(number(facts.sharesOutstanding) && facts.sharesOutstanding > 0)) {
    missingInputs.push({ key: "shares", label: lang === "en" ? "Shares outstanding (company data)" : "总股本（公司基础资料）" });
  }
  if (key === "sotp") missingInputs.push({ key: "_parts", label: lang === "en" ? "Configure businesses and their valuation methods in Parameters first" : "先在参数页添加业务分部并选择各自方法" });
  if (model.assetModel) missingInputs.push({ key: "assets", label: lang === "en" ? "Asset packages: output, costs, mine lives or appraised values" : "资产包：产量、成本、矿山寿命或评估价值" });
  return { status: missingInputs.length ? "needs_data" : "needs_confirmation", missingInputs, assumptions };
}

export function cleanReadiness(value) {
  if (!value || !["needs_data", "needs_confirmation"].includes(value.status)) return null;
  const list = (items) => Array.isArray(items) ? items.filter((x) => x && typeof x.key === "string" && typeof x.label === "string")
    .slice(0, 20).map((x) => ({ key: x.key.slice(0, 60), label: x.label.slice(0, 160) })) : [];
  const missingInputs = list(value.missingInputs);
  return { status: missingInputs.length ? "needs_data" : "needs_confirmation", missingInputs, assumptions: list(value.assumptions) };
}

export function readinessText(value, lang = "zh") {
  const ready = cleanReadiness(value); if (!ready) return "";
  if (ready.missingInputs.length) return (lang === "en" ? "Data to add: " : "当前资料待补：") + ready.missingInputs.map((x) => x.label).join(lang === "en" ? ", " : "、");
  return lang === "en" ? "Base data available; assumptions still need your confirmation." : "基础数据已具备，估值假设仍需逐项确认。";
}

export function cleanMethodDecision(value) {
  if (value?.engine === "jev" && value.status === "used") return { engine: "jev", status: "used", classification: { needsReview: value.classification?.needsReview === true } };
  if (value?.engine === "llm" && value.status === "fallback") return { engine: "llm", status: "fallback" };
  return null;
}

export function methodDecisionText(value, lang = "zh") {
  const decision = cleanMethodDecision(value); if (!decision) return "";
  if (decision.status === "fallback") return lang === "en" ? "Enhanced check did not complete this time; showing the regular recommendation." : "本次增强判断未成功，以下为常规推荐。";
  return lang === "en" ? "Method fit has been checked against the company evidence; you choose the method." + (decision.classification.needsReview ? " Business classification needs review." : "")
    : "已按公司资料辅助判断方法适配度，最终由你选择。" + (decision.classification.needsReview ? "业务分类仍有不确定性，请核对。" : "");
}
