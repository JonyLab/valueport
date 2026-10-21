// Closed, versioned driver vocabulary shared by routing, prompts and draft recovery.
export const GUIDE_DRIVERS = [
  ["gold_price", "金价中枢", "Gold prices", "Gold production or sales explicitly evidenced; long-term gold selling prices"],
  ["copper_price", "铜价中枢", "Copper prices", "Copper production or sales explicitly evidenced; long-term copper selling prices"],
  ["commodity_price", "主要商品价格", "Commodity prices", "Commodity selling prices other than separately assessed gold or copper"],
  ["capacity", "产能兑现", "Capacity delivery", "Timing and ramp-up of evidenced production capacity or projects"],
  ["unit_cost", "单位生产成本", "Unit production costs", "Mining, manufacturing or commodity unit costs"],
  ["reserves", "资源与开采条件", "Reserves and extraction", "Economically recoverable reserves, grades or mine life"],
  ["store_expansion", "门店扩张", "Store expansion", "Physical store openings and store productivity"],
  ["same_store", "同店经营", "Same-store performance", "Sales or traffic growth in existing retail locations"],
  ["penetration", "产品渗透与采用", "Product adoption", "Adoption of an evidenced product or technology"],
  ["retention", "客户留存", "Customer retention", "Recurring customers, churn or subscription renewal"],
  ["pricing", "定价与竞争", "Pricing and competition", "Pricing power or competitive pricing of noncommodity products"],
  ["pipeline", "研发与商业化", "R&D commercialization", "Evidenced research pipeline, approvals or commercialization"],
  ["net_interest_margin", "净息差", "Net interest margin", "Interest spread of a bank or lender"],
  ["credit_quality", "资产质量", "Credit quality", "Loan credit losses, nonperforming assets or underwriting quality"],
  ["insurance", "承保与赔付", "Underwriting and claims", "Insurer underwriting or claims economics"],
  ["regulation", "监管与经营约束", "Regulatory constraints", "Evidenced material changes in regulatory business constraints"],
  ["demand", "需求与销量", "Demand and sales volume", "Demand for the company's evidenced products or services"],
  ["margin", "盈利能力", "Profitability", "Operating profit conversion; do not duplicate a more specific pricing or unit-cost question"],
  ["reinvestment", "扩张投入", "Reinvestment", "Capital expenditure, working capital and investment needed to support growth"],
  ["cash_conversion", "现金转化", "Cash conversion", "Cash collection and conversion of accounting profits into cash"],
  ["financing", "融资与偿债", "Financing and debt", "Refinancing, debt servicing or funding constraints"],
  ["capital_returns", "股东回报", "Capital returns", "Dividend or buyback sustainability without asking for a payout number"],
].map(([key, zh, en, rubric]) => ({ key, zh, en, rubric }));
export const DRIVER_IMPORTANCE = ["core", "secondary", "negligible", "insufficient"];
export const FALLBACK_DRIVERS = ["demand", "margin", "reinvestment"];

export function cleanDriverPlan(raw) {
  if (!raw || raw.version !== 1 || !["used", "not_configured", "unavailable", "uncertain"].includes(raw.status)
    || !Array.isArray(raw.keys) || raw.keys.length < 3 || raw.keys.length > 4
    || new Set(raw.keys).size !== raw.keys.length || raw.keys.some((key) => !GUIDE_DRIVERS.some((d) => d.key === key))) return null;
  return { version: 1, status: raw.status, keys: [...raw.keys] };
}

export function rankGuideDrivers(assessments) {
  const scored = GUIDE_DRIVERS.flatMap((driver, index) => {
    const answer = assessments[driver.key];
    return answer?.choice === "core" && answer.confidence >= 0.45 && answer.probabilities.core >= 0.7
      ? [{ key: driver.key, score: answer.probabilities.core, index }] : [];
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  // Generic profitability must not repeat a more specific cost/price/spread driver.
  const specific = new Set(["unit_cost", "pricing", "net_interest_margin", "insurance"]);
  const candidates = scored.some((d) => specific.has(d.key)) ? scored.filter((d) => d.key !== "margin") : scored;
  const metals = candidates.some((d) => ["gold_price", "copper_price"].includes(d.key));
  const distinct = metals ? candidates.filter((d) => d.key !== "commodity_price") : candidates;
  const keys = distinct.slice(0, 4).map((d) => d.key);
  const fill = distinct.some((d) => specific.has(d.key)) ? ["demand", "reinvestment", "cash_conversion"] : FALLBACK_DRIVERS;
  for (const key of fill) { if (keys.length >= 3) break; if (!keys.includes(key)) keys.push(key); }
  return { version: 1, status: distinct.length >= 3 ? "used" : "uncertain", keys };
}
