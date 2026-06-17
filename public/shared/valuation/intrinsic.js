// Damodaran 风格的内在价值（折现）估值模型。
// 浏览器原生 ESM，无依赖。每个模型对象遵循统一契约（其它代码依赖该形状）：
//   { key, group, label:{zh,en}, fields:[...], compute(vals, ctx) }
//
// 字段 col:"single" 为单输入；col:"dual" 为「保守|乐观」一对。
// unit:"%" 表示用户输入百分数（如 20 代表 20%），compute 内部自行 /100。
// unit:"" 为普通数字（倍数、年数、金额、每股）。
// prefill:(ctx)=>Number|"" 仅用于 single 字段，给出初始值。
// default:Number 为可选默认值，UI 用它预填 dual 两列及无 prefill 的 single 字段。
// compute(vals, ctx) 接收某一情景的扁平 { [fieldKey]: Number }，
//   ctx = { price, epsTtm, bps, shares, dividendYield }，返回每股合理价 Number 或 null。

// 有限正数校验：NaN / Infinity / 非数字均为 false。
function isFinitePos(x) {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function isFiniteNum(x) {
  return typeof x === "number" && Number.isFinite(x);
}

// ---------------------------------------------------------------------------
// FCFF 两阶段
// ---------------------------------------------------------------------------
const FCFF = {
  key: "fcff",
  group: "intrinsic",
  label: { zh: "FCFF 两阶段", en: "FCFF (2-stage)" },
  fields: [
    { k: "revenue", label: { zh: "当前营收", en: "Current revenue" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.revenue)) ? ctx.revenue : "", hint: { zh: "公司总营收（不是每股）", en: "Total revenue, not per share" }, meta: "revenue" },
    { k: "n", label: { zh: "高增长年数", en: "High-growth years" }, col: "single", unit: "", prefill: (ctx) => 10, default: 10, meta: "growthYears" },
    { k: "growth", label: { zh: "营收增速", en: "Revenue growth" }, col: "dual", unit: "%", default: 10, meta: "revGrowth" },
    { k: "opMargin", label: { zh: "目标营业利润率", en: "Target operating margin" }, col: "dual", unit: "%", default: 15, meta: "opMargin" },
    { k: "taxRate", label: { zh: "税率", en: "Tax rate" }, col: "single", unit: "%", prefill: (ctx) => 25, default: 25, meta: "taxRate" },
    { k: "salesToCap", label: { zh: "销售/资本比", en: "Sales-to-capital ratio" }, col: "dual", unit: "", default: 2, meta: "salesToCap" },
    { k: "wacc", label: { zh: "WACC", en: "WACC" }, col: "dual", unit: "%", default: 9, meta: "wacc" },
    { k: "termGrowth", label: { zh: "永续增速", en: "Terminal growth" }, col: "dual", unit: "%", default: 2.5, meta: "termGrowth" },
    { k: "netDebt", label: { zh: "净负债", en: "Net debt" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.netDebt)) ? ctx.netDebt : 0, default: 0, meta: "netDebt" },
  ],
  compute(vals, ctx) {
    const shares = ctx && ctx.shares;
    if (!isFinitePos(shares)) return null;
    const { revenue, n, growth, opMargin, taxRate, salesToCap, wacc, termGrowth, netDebt } = vals;
    if (![revenue, n, growth, opMargin, taxRate, salesToCap, wacc, termGrowth, netDebt].every(isFiniteNum)) return null;
    if (!isFinitePos(salesToCap)) return null;

    const g = growth / 100;
    const m = opMargin / 100;
    const tax = taxRate / 100;
    const w = wacc / 100;
    const gT = termGrowth / 100;

    let PV = 0;
    let prev = revenue;
    // 显性期：逐年自由现金流（FCFF = NOPAT - 再投资）折现
    for (let t = 1; t <= n; t++) {
      const rev = revenue * Math.pow(1 + g, t);
      const nopat = rev * m * (1 - tax);
      const reinvest = (rev - prev) / salesToCap;
      const fcff = nopat - reinvest;
      PV += fcff / Math.pow(1 + w, t);
      prev = rev;
    }
    // 终值：永续阶段
    const revN = revenue * Math.pow(1 + g, n);
    const revT = revN * (1 + gT);
    const nopatT = revT * m * (1 - tax);
    const reinvestT = (revT - revN) / salesToCap;
    const fcffT = nopatT - reinvestT;
    if (w <= gT) return null; // 折现率必须大于永续增速
    const TV = fcffT / (w - gT);
    PV += TV / Math.pow(1 + w, n);

    return (PV - netDebt) / shares;
  },
};

// ---------------------------------------------------------------------------
// FCFE 两阶段
// ---------------------------------------------------------------------------
const FCFE = {
  key: "fcfe",
  group: "intrinsic",
  label: { zh: "FCFE 两阶段", en: "FCFE (2-stage)" },
  fields: [
    {
      k: "netIncome",
      label: { zh: "净利润", en: "Net income" },
      col: "single",
      unit: "",
      // 预填 = 优先 ctx.netIncome，回退到每股收益 × 股本（不可用时返回 ""）
      prefill: (ctx) => {
        if (ctx && Number.isFinite(ctx.netIncome)) return ctx.netIncome;
        const v = (ctx && ctx.epsTtm) * (ctx && ctx.shares);
        return Number.isFinite(v) ? v : "";
      },
      hint: { zh: "公司净利润总额（不是每股）", en: "Total net income, not per share" },
      meta: "netIncome",
    },
    { k: "growth", label: { zh: "净利润增速", en: "Net income growth" }, col: "dual", unit: "%", default: 10, meta: "niGrowth" },
    { k: "reinvestRate", label: { zh: "股权再投资率", en: "Equity reinvestment rate" }, col: "dual", unit: "%", default: 40, hint: { zh: "占净利润的比例", en: "As % of net income" }, meta: "reinvest" },
    { k: "costOfEquity", label: { zh: "股权成本", en: "Cost of equity" }, col: "dual", unit: "%", default: 9, meta: "costOfEquity" },
    { k: "n", label: { zh: "高增长年数", en: "High-growth years" }, col: "single", unit: "", prefill: (ctx) => 10, default: 10, meta: "growthYears" },
    { k: "termGrowth", label: { zh: "永续增速", en: "Terminal growth" }, col: "dual", unit: "%", default: 2.5, meta: "termGrowth" },
  ],
  compute(vals, ctx) {
    const shares = ctx && ctx.shares;
    if (!isFinitePos(shares)) return null;
    const { netIncome, growth, reinvestRate, costOfEquity, n, termGrowth } = vals;
    if (![netIncome, growth, reinvestRate, costOfEquity, n, termGrowth].every(isFiniteNum)) return null;

    const g = growth / 100;
    const rr = reinvestRate / 100;
    const ke = costOfEquity / 100;
    const gT = termGrowth / 100;

    let PV = 0;
    // 显性期：FCFE = 净利润 × (1 - 再投资率)
    for (let t = 1; t <= n; t++) {
      const ni = netIncome * Math.pow(1 + g, t);
      const fcfe = ni * (1 - rr);
      PV += fcfe / Math.pow(1 + ke, t);
    }
    const niN = netIncome * Math.pow(1 + g, n);
    const fcfeT = niN * (1 + gT) * (1 - rr);
    if (ke <= gT) return null;
    const TV = fcfeT / (ke - gT);
    PV += TV / Math.pow(1 + ke, n);

    return PV / shares;
  },
};

// ---------------------------------------------------------------------------
// DDM 两阶段（股利折现）
// ---------------------------------------------------------------------------
const DDM = {
  key: "ddm",
  group: "intrinsic",
  label: { zh: "DDM 两阶段", en: "DDM (2-stage)" },
  fields: [
    {
      k: "dps",
      label: { zh: "每股股利", en: "Dividend per share" },
      col: "single",
      unit: "",
      // 预填 = 价格 × 股息率(%) / 100（不可用时返回 ""）
      prefill: (ctx) => {
        const v = (ctx && ctx.price) * (ctx && ctx.dividendYield) / 100;
        return Number.isFinite(v) ? v : "";
      },
      meta: "dps",
    },
    { k: "growth", label: { zh: "股利增速", en: "Dividend growth" }, col: "dual", unit: "%", default: 10, meta: "divGrowth" },
    { k: "n", label: { zh: "高增长年数", en: "High-growth years" }, col: "single", unit: "", prefill: (ctx) => 5, default: 5, meta: "growthYears" },
    { k: "costOfEquity", label: { zh: "股权成本", en: "Cost of equity" }, col: "dual", unit: "%", default: 9, meta: "costOfEquity" },
    { k: "termGrowth", label: { zh: "永续增速", en: "Terminal growth" }, col: "dual", unit: "%", default: 2.5, meta: "termGrowth" },
  ],
  compute(vals, ctx) {
    const shares = ctx && ctx.shares;
    if (!isFinitePos(shares)) return null; // 与契约一致：shares<=0 时返回 null
    const { dps, growth, n, costOfEquity, termGrowth } = vals;
    if (![dps, growth, n, costOfEquity, termGrowth].every(isFiniteNum)) return null;

    const g = growth / 100;
    const ke = costOfEquity / 100;
    const gT = termGrowth / 100;

    let PV = 0;
    for (let t = 1; t <= n; t++) {
      const d = dps * Math.pow(1 + g, t);
      PV += d / Math.pow(1 + ke, t);
    }
    const dT = dps * Math.pow(1 + g, n) * (1 + gT);
    if (ke <= gT) return null;
    const TV = dT / (ke - gT);
    PV += TV / Math.pow(1 + ke, n);

    return PV; // 已是每股
  },
};

export const INTRINSIC = [FCFF, FCFE, DDM];
