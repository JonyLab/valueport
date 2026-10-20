import { COMMODITIES } from "./resource.js";

const numberOrNull = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
const ASSET_FIELDS = {
  mine: [
    ["output", "权益年产量", "Attributable annual output", "output"],
    ["unitCost", "完全成本", "All-in unit cost", "price"],
    ["life", "剩余寿命", "Remaining life", "years"],
  ],
  fixed: [["value", "资产包现值", "Asset package PV", "money"]],
  option: [
    ["reserves", "权益未开发储量", "Attributable undeveloped reserves", "output"],
    ["marginalCost", "单位边际成本", "Marginal unit cost", "price"],
    ["devCost", "开发成本现值", "Development cost PV", "money"],
    ["sigma", "价格波动率", "Price volatility", "%"],
    ["years", "期权期限", "Option term", "years"],
    ["rf", "无风险利率", "Risk-free rate", "%"],
  ],
};

// Keep the existing scalar suggestion contract, with explicit targets for nested NAV inputs.
export function resourceAiFields(form, lang = "zh") {
  const fields = [], assets = Array.isArray(form.assets) ? form.assets : [];
  const language = lang === "en" ? "en" : "zh";
  const used = new Set(assets.filter((a) => a.type !== "fixed").map((a) => a.commodity));
  for (const key of used) {
    const com = COMMODITIES[key]; if (!com) continue;
    const p = form.prices?.[key] || com.price;
    fields.push({ k: `resource.price.${key}`, label: `${com.label[language]} · ${language === "zh" ? "长期商品价" : "Long-term price"}`,
      col: "dual", unit: com.priceUnit[language], money: false, value: { c: numberOrNull(p.c), o: numberOrNull(p.o) },
      isDefault: p.c === com.price.c && p.o === com.price.o,
      target: { commodity: key } });
  }
  assets.forEach((asset, index) => {
    const com = COMMODITIES[asset.commodity];
    const identity = JSON.stringify([asset.type, asset.name || "", asset.commodity || ""]);
    const name = asset.name || `${language === "zh" ? "资产" : "Asset"} ${index + 1}`;
    for (const [key, zh, en, kind] of ASSET_FIELDS[asset.type] || []) {
      const outputUnit = language === "en" && com?.toBase === 1e4 ? "10,000 t" : com?.outUnit[language];
      const unit = kind === "output" ? outputUnit : kind === "price" ? com?.priceUnit[language]
        : kind === "years" ? (language === "zh" ? "年" : "years") : kind === "money" ? "CNY" : kind;
      fields.push({ k: `resource.asset.${index}.${key}`, label: `${name} · ${language === "zh" ? zh : en}`,
        col: "single", unit: unit || "", money: kind === "money", value: numberOrNull(asset[key]),
        target: { index, key, identity } });
    }
  });
  return fields;
}

export function resourceAiFacts(form) {
  return {
    currency: "CNY: all asset PVs, debt, costs and commodity prices; do not mix with the stock quote currency",
    assets: (form.assets || []).map((a, index) => ({ index, ...a })),
    prices: form.prices || {},
    commodityUnits: Object.fromEntries(Object.entries(COMMODITIES).map(([k, c]) => [k,
      { output: c.outUnit.zh, price: c.priceUnit.zh, toBase: c.toBase }])),
    inputStatus: "User inputs and method defaults, not independently verified company disclosures",
  };
}

// Reject stale suggestions after assets have been renamed, removed, or reordered.
export function applyResourceAiParams(form, params, originalFields) {
  const next = structuredClone(form);
  const current = new Map(resourceAiFields(form).map((f) => [f.k, f]));
  const original = new Map(originalFields.map((f) => [f.k, f]));
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith("resource.")) { next[key] = value; continue; }
    const field = current.get(key), previous = original.get(key);
    if (!field || !previous || JSON.stringify(field.target) !== JSON.stringify(previous.target))
      throw new Error("resource_inputs_changed");
    if (field.target.commodity) {
      next.prices ||= {};
      next.prices[field.target.commodity] = { ...value };
    } else next.assets[field.target.index][field.target.key] = value;
  }
  return next;
}
