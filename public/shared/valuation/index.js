/**
 * valuation/index.js — 估值模型注册表 + 运行器（glue）。
 * 组合内在价值组（intrinsic.js）与相对估值组（relative.js），
 * 提供统一的 MODELS 列表与 runModel(model, form, ctx)。
 */
import { INTRINSIC } from "./intrinsic.js";
import { RELATIVE } from "./relative.js";

// 列表顺序即 UI 方法选择条的顺序。
export const MODELS = [...INTRINSIC, ...RELATIVE];

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
export function runModel(model, form, ctx) {
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
