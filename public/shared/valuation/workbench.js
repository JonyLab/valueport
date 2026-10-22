import { modeFields } from "./index.js";

const finite = (n) => typeof n === "number" && Number.isFinite(n);

export function fieldsFor(model, mode, form) {
  return model ? modeFields(model, mode, form) : [];
}

export function midpointForm(model, mode, form) {
  const out = {};
  for (const field of fieldsFor(model, mode, form)) {
    const value = form[field.k];
    if (field.col === "dual") {
      const c = value && typeof value === "object" ? Number(value.c) : NaN;
      const o = value && typeof value === "object" ? Number(value.o) : NaN;
      out[field.k] = finite(c) && finite(o) ? (c + o) / 2 : (finite(c) ? c : o);
    } else {
      out[field.k] = Number(value);
    }
  }
  if (model && model.modes) out._mode = mode || model.defaultMode;
  if (form._parts) out._parts = form._parts;
  if (form.assets) out.assets = form.assets;
  if (form.prices) out.prices = form.prices;
  return out;
}

export function scheduleSeries(schedule) {
  if (!schedule || !Array.isArray(schedule.rows)) return [];
  return schedule.rows
    .filter((row) => finite(Number(row.cf)))
    .map((row) => ({
      label: String(row.year),
      value: Number(row.cf),
      pv: finite(Number(row.pv)) ? Number(row.pv) : null,
    }));
}

export function sensitivityMatrix({ model, mode, form, ctx, run, lang }) {
  if (!model || typeof run !== "function") return null;
  const fields = fieldsFor(model, mode, form);
  const candidates = fields
    .filter((field) => field.col === "dual" && numericDual(form[field.k]))
    .concat(fields.filter((field) => field.col !== "dual" && finite(Number(form[field.k]))));
  if (candidates.length < 2) return null;

  const x = candidates[0];
  const y = candidates[1];
  const xVals = stepsForField(x, form[x.k]);
  const yVals = stepsForField(y, form[y.k]);
  if (!xVals || !yVals) return null;

  const rows = yVals.map((yv, yi) => ({
    label: formatAxisValue(yv, y),
    value: yv,
    cells: xVals.map((xv, xi) => {
      const varied = cloneForm(form);
      setFieldMid(varied, x, xv);
      setFieldMid(varied, y, yv);
      let result = null;
      try { result = run(model, varied, ctx); } catch { result = null; }
      const low = result && finite(Number(result.low)) ? Number(result.low) : null;
      const high = result && finite(Number(result.high)) ? Number(result.high) : null;
      const value = low === null || high === null ? null : (low + high) / 2;
      return { value, center: xi === 2 && yi === 2 };
    }),
  }));

  return {
    x: axisMeta(x, lang),
    y: axisMeta(y, lang),
    columns: xVals.map((v) => ({ label: formatAxisValue(v, x), value: v })),
    rows,
  };
}

function numericDual(value) {
  if (!value || typeof value !== "object") return false;
  return finite(Number(value.c)) || finite(Number(value.o));
}

function stepsForField(field, value) {
  let center;
  let spread;
  if (field.col === "dual") {
    const c = value && typeof value === "object" ? Number(value.c) : NaN;
    const o = value && typeof value === "object" ? Number(value.o) : NaN;
    if (finite(c) && finite(o)) {
      center = (c + o) / 2;
      spread = Math.abs(o - c) / 2;
    } else {
      center = finite(c) ? c : o;
      spread = Math.max(Math.abs(center) * 0.1, 1);
    }
  } else {
    center = Number(value);
    spread = Math.max(Math.abs(center) * 0.1, field.unit === "%" ? 1 : 0.5);
  }
  if (!finite(center)) return null;
  if (!finite(spread) || spread === 0) spread = Math.max(Math.abs(center) * 0.1, field.unit === "%" ? 1 : 0.5);
  return [-2, -1, 0, 1, 2].map((n) => round(center + n * spread));
}

function setFieldMid(form, field, value) {
  if (field.col === "dual") form[field.k] = { c: value, o: value };
  else form[field.k] = value;
}

function axisMeta(field, lang) {
  return {
    key: field.k,
    label: (field.label && field.label[lang]) || (field.label && field.label.en) || field.k,
    unit: field.unit || "",
  };
}

function formatAxisValue(value, field) {
  if (!finite(value)) return "-";
  const s = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
  return field.unit === "%" ? `${s}%` : s;
}

function cloneForm(form) {
  return JSON.parse(JSON.stringify(form || {}));
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// AI 助手的「敏感性」组件：只改一个字段、其他输入保持当前值，逐档跑模型。
// steps 是加减量：金额字段（money）按 % 变动，其余按字段单位加减（百分数字段 1 = 1 个百分点）；
// 两档字段的保守 / 乐观同时平移，保留两档间距。返回 { rows:[{ step, value, low, high, current }] } 或 null
export function fieldSweep({ model, form, ctx, run, field, steps, money }) {
  if (!model || !field || typeof run !== "function" || !Array.isArray(steps)) return null;
  const cur = form && form[field.k];
  const shift = (v, s) => (money ? v * (1 + s / 100) : v + s);
  let base;
  if (field.col === "dual") {
    const c = cur && typeof cur === "object" ? Number(cur.c) : NaN;
    const o = cur && typeof cur === "object" ? Number(cur.o) : NaN;
    if (!finite(c) || !finite(o)) return null;
    base = { c, o };
  } else {
    base = Number(cur);
    if (!finite(base)) return null;
  }
  const rows = steps.filter(finite).map((s) => {
    const value = field.col === "dual" ? { c: round(shift(base.c, s)), o: round(shift(base.o, s)) } : round(shift(base, s));
    const varied = cloneForm(form);
    varied[field.k] = value;
    let r = null;
    try { r = run(model, varied, ctx); } catch { r = null; }
    const low = r && finite(Number(r.low)) ? Number(r.low) : null;
    const high = r && finite(Number(r.high)) ? Number(r.high) : null;
    return { step: s, value, low, high, current: s === 0 };
  });
  return rows.length ? { rows } : null;
}
