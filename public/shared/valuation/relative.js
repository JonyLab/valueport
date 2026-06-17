// 相对估值模型（PE / PEG / PB / PS / EV-EBITDA）。
// 纯浏览器 ESM 模块：无 import，供前端与单测共用。
// 契约：每个模型 { key, group, label, fields[], compute(vals, ctx) }。
//   - vals 为单一情景的扁平表 { [fieldKey]: Number }；
//   - ctx = { price, epsTtm, bps, shares, dividendYield }（任意值可能为 0/NaN）；
//   - compute 返回每股公允价值 Number，输入非法时返回 null。
//   - 相对估值不做折现。

// 工具：是否为有限正数（用于股本校验）
const posFinite = (x) => Number.isFinite(x) && x > 0;
// 工具：是否为有限数
const finite = (x) => Number.isFinite(x);

// PE 估值：营收增长 → 未来营收 → 净利率 → EPS → ×目标 PE
const PE = {
  key: "pe",
  group: "relative",
  label: { zh: "PE 估值", en: "P/E" },
  fields: [
    { k: "revenue", label: { zh: "当前营收", en: "Current revenue" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.revenue)) ? ctx.revenue : "", hint: { zh: "公司总营收（不是每股）", en: "Total revenue, not per share" }, meta: "revenue" },
    { k: "n", label: { zh: "预测年数", en: "Years" }, col: "single", unit: "", prefill: (ctx) => "", default: 5, meta: "forecastYears" },
    { k: "growth", label: { zh: "营收增速", en: "Revenue growth" }, col: "dual", unit: "%", default: 10, meta: "revGrowth" },
    { k: "netMargin", label: { zh: "净利率", en: "Net margin" }, col: "dual", unit: "%", default: 15, meta: "netMargin" },
    { k: "targetPE", label: { zh: "目标 PE", en: "Target P/E" }, col: "dual", unit: "", default: 20, meta: "targetPE" },
  ],
  compute(vals, ctx) {
    const shares = ctx.shares;
    if (!posFinite(shares)) return null;
    const { revenue, n, targetPE } = vals;
    const g = vals.growth / 100; // % 转小数
    const netMargin = vals.netMargin / 100; // % 转小数
    if (![revenue, n, vals.growth, vals.netMargin, targetPE].every(finite)) return null;
    const futRev = revenue * Math.pow(1 + g, n);
    const eps = (futRev * netMargin) / shares;
    return eps * targetPE;
  },
  breakdown(vals, ctx) {
    const { revenue, n, targetPE } = vals;
    const futRev = (finite(revenue) && finite(n) && finite(vals.growth)) ? revenue * Math.pow(1 + vals.growth / 100, n) : null;
    const futNi = (futRev !== null && finite(vals.netMargin)) ? futRev * (vals.netMargin / 100) : null;
    return [
      { key: "futRev", label: { zh: "预期营收（n年后）", en: "Projected revenue" }, value: futRev, kind: "money" },
      { key: "futNi", label: { zh: "预期净利润", en: "Projected net income" }, value: futNi, kind: "money" },
      { key: "pe", label: { zh: "目标 PE", en: "Target P/E" }, value: finite(targetPE) ? targetPE : null, kind: "mult" },
    ];
  },
};

// PEG 估值：impliedPE = peg × 增速「原始百分数」（注意此处不除以 100）
const PEG = {
  key: "peg",
  group: "relative",
  label: { zh: "PEG 估值", en: "PEG" },
  fields: [
    { k: "eps", label: { zh: "每股收益", en: "EPS" }, col: "single", unit: "", prefill: (ctx) => (finite(ctx.epsTtm) ? ctx.epsTtm : ""), hint: { zh: "默认取 TTM EPS", en: "Defaults to TTM EPS" }, meta: "eps" },
    { k: "growth", label: { zh: "盈利增速", en: "Earnings growth" }, col: "dual", unit: "%", default: 10, meta: "epsGrowth" },
    { k: "peg", label: { zh: "PEG 系数", en: "PEG ratio" }, col: "dual", unit: "", default: 1, meta: "peg" },
  ],
  compute(vals, ctx) {
    // 注意：PEG 约定下 growth 用「原始百分数」（如 20 表示 20%），不除以 100。
    const { eps, growth, peg } = vals;
    if (![eps, growth, peg].every(finite)) return null;
    const impliedPE = peg * growth;
    return eps * impliedPE;
  },
  breakdown(vals, ctx) {
    const { growth, peg } = vals;
    const impliedPE = (finite(peg) && finite(growth)) ? peg * growth : null;
    return [
      { key: "impliedPE", label: { zh: "隐含 PE", en: "Implied P/E" }, value: impliedPE, kind: "mult" },
    ];
  },
};

// PB 估值：每股净资产 × 目标 PB
const PB = {
  key: "pb",
  group: "relative",
  label: { zh: "PB 估值", en: "P/B" },
  fields: [
    { k: "bps", label: { zh: "每股净资产", en: "Book value/share" }, col: "single", unit: "", prefill: (ctx) => (finite(ctx.bps) ? ctx.bps : ""), meta: "bps" },
    { k: "targetPB", label: { zh: "目标 PB", en: "Target P/B" }, col: "dual", unit: "", default: 2, meta: "targetPB" },
  ],
  compute(vals, ctx) {
    const { bps, targetPB } = vals;
    if (![bps, targetPB].every(finite)) return null;
    return bps * targetPB;
  },
  breakdown(vals, ctx) {
    const { targetPB } = vals;
    return [
      { key: "pb", label: { zh: "目标 PB", en: "Target P/B" }, value: finite(targetPB) ? targetPB : null, kind: "mult" },
    ];
  },
};

// PS 估值：未来营收 × 目标 PS / 股本
const PS = {
  key: "ps",
  group: "relative",
  label: { zh: "PS 估值", en: "P/S" },
  fields: [
    { k: "revenue", label: { zh: "当前营收", en: "Current revenue" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.revenue)) ? ctx.revenue : "", hint: { zh: "公司总营收（不是每股）", en: "Total revenue, not per share" }, meta: "revenue" },
    { k: "n", label: { zh: "预测年数", en: "Years" }, col: "single", unit: "", prefill: (ctx) => "", default: 5, meta: "forecastYears" },
    { k: "growth", label: { zh: "营收增速", en: "Revenue growth" }, col: "dual", unit: "%", default: 10, meta: "revGrowth" },
    { k: "targetPS", label: { zh: "目标 PS", en: "Target P/S" }, col: "dual", unit: "", default: 5, meta: "targetPS" },
  ],
  compute(vals, ctx) {
    const shares = ctx.shares;
    if (!posFinite(shares)) return null;
    const { revenue, n, targetPS } = vals;
    const g = vals.growth / 100; // % 转小数
    if (![revenue, n, vals.growth, targetPS].every(finite)) return null;
    const futRev = revenue * Math.pow(1 + g, n);
    return (futRev * targetPS) / shares;
  },
  breakdown(vals, ctx) {
    const { revenue, n, targetPS } = vals;
    const futRev = (finite(revenue) && finite(n) && finite(vals.growth)) ? revenue * Math.pow(1 + vals.growth / 100, n) : null;
    return [
      { key: "futRev", label: { zh: "预期营收（n年后）", en: "Projected revenue" }, value: futRev, kind: "money" },
      { key: "ps", label: { zh: "目标 PS", en: "Target P/S" }, value: finite(targetPS) ? targetPS : null, kind: "mult" },
    ];
  },
};

// EV/EBITDA 估值：未来 EBITDA × 倍数 = EV，扣净债后除股本
const EVEBITDA = {
  key: "evebitda",
  group: "relative",
  label: { zh: "EV/EBITDA 估值", en: "EV/EBITDA" },
  fields: [
    { k: "ebitda", label: { zh: "当前 EBITDA", en: "Current EBITDA" }, col: "single", unit: "", prefill: (ctx) => "", hint: { zh: "公司总额（不是每股）", en: "Total, not per share" }, meta: "ebitda" },
    { k: "n", label: { zh: "预测年数", en: "Years" }, col: "single", unit: "", prefill: (ctx) => "", default: 5, meta: "forecastYears" },
    { k: "growth", label: { zh: "EBITDA 增速", en: "EBITDA growth" }, col: "dual", unit: "%", default: 10, meta: "ebitdaGrowth" },
    { k: "targetMultiple", label: { zh: "目标倍数", en: "Target multiple" }, col: "dual", unit: "", default: 12, meta: "targetMultiple" },
    { k: "netDebt", label: { zh: "净负债", en: "Net debt" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.netDebt)) ? ctx.netDebt : "", default: 0, meta: "netDebt" },
  ],
  compute(vals, ctx) {
    const shares = ctx.shares;
    if (!posFinite(shares)) return null;
    const { ebitda, n, targetMultiple, netDebt } = vals;
    const g = vals.growth / 100; // % 转小数
    if (![ebitda, n, vals.growth, targetMultiple, netDebt].every(finite)) return null;
    const futEbitda = ebitda * Math.pow(1 + g, n);
    const ev = futEbitda * targetMultiple;
    return (ev - netDebt) / shares;
  },
  breakdown(vals, ctx) {
    const { ebitda, n, targetMultiple } = vals;
    const futEbitda = (finite(ebitda) && finite(n) && finite(vals.growth)) ? ebitda * Math.pow(1 + vals.growth / 100, n) : null;
    const ev = (futEbitda !== null && finite(targetMultiple)) ? futEbitda * targetMultiple : null;
    return [
      { key: "futEbitda", label: { zh: "预期 EBITDA（n年后）", en: "Projected EBITDA" }, value: futEbitda, kind: "money" },
      { key: "ev", label: { zh: "企业价值 EV", en: "Enterprise value" }, value: ev, kind: "money" },
      { key: "mult", label: { zh: "目标倍数", en: "Target multiple" }, value: finite(targetMultiple) ? targetMultiple : null, kind: "mult" },
    ];
  },
};

export const RELATIVE = [PE, PEG, PB, PS, EVEBITDA];
