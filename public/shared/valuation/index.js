/**
 * valuation/index.js — 估值模型注册表 + 运行器（glue）。
 * 组合内在价值组（intrinsic.js）与相对估值组（relative.js），
 * 提供统一的 MODELS 列表与 runModel(model, form, ctx)。
 */
import { INTRINSIC } from "./intrinsic.js";
import { RELATIVE } from "./relative.js";
import { RESOURCE } from "./resource.js";

// 列表顺序即 UI 方法选择条的顺序。
export const MODELS = [...INTRINSIC, ...RESOURCE, ...RELATIVE];

// UI 展示分组按「估值口径」组织，不等同于模型内部 group。
export const METHOD_MENU_GROUPS = [
  {
    key: "cashflow",
    title: { zh: "现金流折现", en: "Cash-flow discounting" },
    methods: [
      { key: "fcff", title: { zh: "FCFF 经营现金流", en: "FCFF operating cash flow" }, subtitle: { zh: "从收入、利润率、资本效率推导企业价值。", en: "Derives enterprise value from revenue, margins, and capital efficiency." } },
      { key: "fcf", title: { zh: "DCF 自由现金流", en: "DCF free cash flow" }, subtitle: { zh: "直接用自由现金流折现，适合现金流较稳定公司。", en: "Discounts free cash flow directly for steadier cash-flow businesses." } },
      { key: "fcfe", title: { zh: "FCFE 股权现金流", en: "FCFE equity cash flow" }, subtitle: { zh: "从净利润与再投资推导股东可得现金流。", en: "Estimates cash flow available to equity from earnings and reinvestment." } },
      { key: "ddm", title: { zh: "DDM 股息折现", en: "DDM dividend discount" }, subtitle: { zh: "适合稳定分红、股息可预测的公司。", en: "Best for companies with stable, predictable dividends." } },
    ],
  },
  {
    key: "asset",
    title: { zh: "资产重估", en: "Asset revaluation" },
    methods: [
      { key: "navsotp", title: { zh: "资源股 NAV / SOTP", en: "Resource NAV / SOTP" }, subtitle: { zh: "按资产包、商品价格和折现率拆开估算净资产价值。", en: "Values asset packages with commodity prices and discount rates." } },
    ],
  },
  {
    key: "multiple",
    title: { zh: "倍数反推", en: "Multiple-implied value" },
    methods: [
      { key: "pe", title: { zh: "P/E 市盈率", en: "P/E earnings multiple" }, subtitle: { zh: "用盈利增长与目标 PE 推导合理股价。", en: "Uses earnings growth and a target P/E to infer fair price." } },
      { key: "peg", title: { zh: "PEG 成长校准", en: "PEG growth calibration" }, subtitle: { zh: "用增长率校准 PE，适合成长股粗筛。", en: "Calibrates P/E by growth for quick growth-stock screening." } },
      { key: "pb", title: { zh: "P/B 市净率", en: "P/B book multiple" }, subtitle: { zh: "适合银行、保险或其他资产型公司。", en: "Useful for banks, insurers, and asset-heavy companies." } },
      { key: "ps", title: { zh: "P/S 市销率", en: "P/S sales multiple" }, subtitle: { zh: "适合利润暂不稳定但收入可比的公司。", en: "Works when revenue is comparable but margins are not yet steady." } },
      { key: "evebitda", title: { zh: "EV/EBITDA 企业倍数", en: "EV/EBITDA enterprise multiple" }, subtitle: { zh: "用企业价值口径比较经营资产。", en: "Compares operating assets on an enterprise-value basis." } },
    ],
  },
];

const METHOD_META = new Map(METHOD_MENU_GROUPS.flatMap((group) => group.methods.map((method) => [method.key, method])));

export function methodMenuMeta(model) {
  if (!model) return null;
  return METHOD_META.get(model.key) || null;
}

// 取某模型在某口径下的字段;无 modes 的模型回退到 model.fields。
export function modeFields(model, mode) {
  if (!model.modes) return model.fields || [];
  const key = mode || model.defaultMode || model.modes[0].key;
  const m = model.modes.find((x) => x.key === key) || model.modes.find((x) => x.key === model.defaultMode) || model.modes[0];
  return m.fields;
}

/**
 * 用保守/乐观两套假设各跑一次 compute，得到低~高每股合理价值。
 * @param {Object} model  模型对象（含 fields 或 modes + compute）
 * @param {Object} form   { [fieldKey]: Number(single) | {c:Number,o:Number}(dual) }
 * @param {Object} ctx    { price, epsTtm, bps, shares, dividendYield }
 * @returns {{low:Number|null, high:Number|null}}
 */
export function runScenario(model, form, ctx, scenario) {
  if (!["c", "o"].includes(scenario)) return null;
  if (typeof model.run === "function") {
    const result = model.run(form, ctx);
    return safe(scenario === "c" ? result?.low : result?.high);
  }
  const values = {};
  const fields = model.modes ? modeFields(model, form._mode || model.defaultMode) : model.fields;
  for (const field of fields) values[field.k] = field.col === "dual" ? form[field.k]?.[scenario] : form[field.k];
  if (model.modes) values._mode = form._mode || model.defaultMode;
  try { return safe(model.compute(values, ctx)); } catch { return null; }
}

export function runModel(model, form, ctx) {
  // 自跑型模型（如 NAV/SOTP：每资产各自增速、求和后取区间）自带 run()，跳过通用 cons/opt 拆分。
  if (typeof model.run === "function") return model.run(form, ctx) || { low: null, high: null };
  const cons = {};
  const opt = {};
  const fields = model.modes ? modeFields(model, form._mode || model.defaultMode) : model.fields;
  for (const field of fields) {
    const v = form[field.k];
    if (field.col === "dual") {
      cons[field.k] = v && typeof v === "object" ? v.c : NaN;
      opt[field.k] = v && typeof v === "object" ? v.o : NaN;
    } else {
      cons[field.k] = v;
      opt[field.k] = v;
    }
  }
  if (model.modes) { cons._mode = opt._mode = form._mode || model.defaultMode; }

  const a = safe(model.compute(cons, ctx));
  const b = safe(model.compute(opt, ctx));

  // 仅当两套假设都算出有限值，才形成一个区间；否则视为输入不完整。
  if (a === null || b === null) return { low: null, high: null };
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

function safe(v) {
  return (typeof v === "number" && isFinite(v)) ? v : null;
}
