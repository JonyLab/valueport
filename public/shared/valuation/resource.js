/**
 * valuation/resource.js — 资源股 NAV / SOTP（商品价格驱动）。
 * 思路（参考紫金式重置净值法）：每个在产矿的税后年现金流由「宏观商品价」派生——
 *   税后年现金流 = 权益年产量 × 单位换算 ×(长期商品价 − 完全成本)×(1 − 税率)
 *   资产重置价值 = 税后年现金流 × 年金系数(寿命 L, WACC)   ← 平价、不增长、有限寿命、无永续
 * 另支持「固定值包」(锂板块 / 已折算的未开发期权现值等)。各资产现值加总 − 净负债 = 股权 NAV ÷ 股本。
 * 保守/乐观由宏观价(低/高)与 WACC(高/低)共同决定 → NAV 区间喂钟摆。
 */
const isNum = (x) => typeof x === "number" && isFinite(x);
const isPos = (x) => isNum(x) && x > 0;

// 商品登记：产量单位 → 基准单位换算(toBase)、价格单位、默认保守/乐观价(元)。
export const COMMODITIES = {
  copper: { label: { zh: "铜", en: "Copper" }, priceUnit: { zh: "元/吨", en: "CNY/t" }, outUnit: { zh: "万吨", en: "kt" }, toBase: 1e4, price: { c: 60000, o: 85000 } },
  gold: { label: { zh: "黄金", en: "Gold" }, priceUnit: { zh: "元/克", en: "CNY/g" }, outUnit: { zh: "吨", en: "t" }, toBase: 1e6, price: { c: 600, o: 820 } },
  silver: { label: { zh: "白银", en: "Silver" }, priceUnit: { zh: "元/克", en: "CNY/g" }, outUnit: { zh: "吨", en: "t" }, toBase: 1e6, price: { c: 6, o: 9 } },
  zinc: { label: { zh: "锌", en: "Zinc" }, priceUnit: { zh: "元/吨", en: "CNY/t" }, outUnit: { zh: "万吨", en: "kt" }, toBase: 1e4, price: { c: 16000, o: 26000 } },
};

// 年金现值系数：L 年、每年 1 元、折现率 wPct(%)。w<=0 时退化为 L（不折现）。
export function annuityFactor(L, wPct) {
  if (!isPos(L)) return NaN;
  const w = wPct / 100;
  if (!isNum(w)) return NaN;
  if (w <= 0) return L;
  return (1 - Math.pow(1 + w, -L)) / w;
}

// 单资产重置价值。priceOf(commodity)→当前情景商品价；wPct 折现率；taxPct 税率。
// type==="fixed" → 直接用 value（固定值包，对价格/折现不敏感）。
export function assetResetValue(asset, priceOf, wPct, taxPct) {
  if (!asset) return NaN;
  if (asset.type === "fixed") { const v = Number(asset.value); return isNum(v) ? v : NaN; }
  const com = COMMODITIES[asset.commodity];
  if (!com) return NaN;
  const price = Number(priceOf ? priceOf(asset.commodity) : NaN);
  const cost = Number(asset.unitCost), output = Number(asset.output), L = Number(asset.life);
  if (!isNum(price) || !isNum(cost) || !isNum(output) || !isPos(L)) return NaN;
  const tax = isNum(taxPct) ? taxPct : 0;
  const cf = output * com.toBase * (price - cost) * (1 - tax / 100); // 税后年现金流（元，可为负=亏损矿）
  const af = annuityFactor(L, wPct);
  return isNum(af) ? cf * af : NaN;
}

// 某情景下的每股 NAV。priceOf 给出该情景商品价；wPct 折现率。无有效资产/股本无效 → null。
export function navPerShare(form, ctx, priceOf, wPct) {
  const shares = ctx && ctx.shares;
  const assets = form && form.assets;
  if (!Array.isArray(assets) || !isPos(shares)) return null;
  const tax = Number(form.taxRate), nd = Number(form.netDebt);
  let sum = 0, valid = 0;
  for (const a of assets) {
    const v = assetResetValue(a, priceOf, wPct, tax);
    if (isNum(v)) { sum += v; valid++; }
  }
  if (!valid) return null;
  return (sum - (isNum(nd) ? nd : 0)) / shares;
}

// 价格解析器：side 'c'|'o' 取保守/乐观；'mid' 取均值。回退到商品默认价。
function priceResolver(prices, side) {
  return (com) => {
    const p = prices && prices[com];
    const d = COMMODITIES[com] && COMMODITIES[com].price;
    const pick = (o) => o ? (side === "mid" ? (Number(o.c) + Number(o.o)) / 2 : Number(o[side])) : NaN;
    const v = pick(p);
    return isNum(v) ? v : pick(d);
  };
}

const NAVSOTP = {
  key: "navsotp",
  group: "intrinsic",
  label: { zh: "资源股 NAV / SOTP", en: "Resource NAV / SOTP" },
  assetModel: true, // UI 标记：渲染商品价 + 资产表
  fields: [
    { k: "wacc", label: { zh: "宏观折现率 WACC", en: "Macro WACC" }, col: "dual", unit: "%", default: 8, meta: "wacc" },
    { k: "taxRate", label: { zh: "税率", en: "Tax rate" }, col: "single", unit: "%", prefill: () => 25, default: 25, meta: "taxRate" },
    { k: "netDebt", label: { zh: "净负债", en: "Net debt" }, col: "single", unit: "", prefill: (ctx) => (ctx && isNum(ctx.netDebt)) ? ctx.netDebt : 0, default: 0, meta: "netDebt" },
  ],
  // 自跑两侧：保守=低价+高WACC；乐观=高价+低WACC。
  run(form, ctx) {
    const d = form && form.wacc;
    if (!d || typeof d !== "object") return { low: null, high: null };
    const prices = (form && form.prices) || {};
    const a = navPerShare(form, ctx, priceResolver(prices, "c"), d.c);
    const b = navPerShare(form, ctx, priceResolver(prices, "o"), d.o);
    if (a === null || b === null) return { low: null, high: null };
    return { low: Math.min(a, b), high: Math.max(a, b) };
  },
  // 结果卡明细：商品价取中、折现率取传入标量(cons=保守率/opt=乐观率)→ P/NAV 区间体现利率敏感性。
  breakdown(vals, ctx) {
    const shares = ctx && ctx.shares, w = vals && vals.wacc;
    if (!Array.isArray(vals && vals.assets) || !isPos(shares) || !isNum(w)) return [];
    const priceOf = priceResolver((vals && vals.prices) || {}, "mid");
    let sum = 0;
    for (const a of vals.assets) { const v = assetResetValue(a, priceOf, w, Number(vals.taxRate)); if (isNum(v)) sum += v; }
    const nd = Number(vals.netDebt), equity = sum - (isNum(nd) ? nd : 0), ps = equity / shares;
    const price = ctx && ctx.price;
    const pnav = (isPos(price) && isPos(ps)) ? price / ps : null;
    return [
      { key: "sumpv", label: { zh: "资产重置现值合计", en: "Sum of asset value" }, value: sum, kind: "money" },
      { key: "equity", label: { zh: "股权 NAV（铁底）", en: "Equity NAV" }, value: equity, kind: "money" },
      { key: "pnav", label: { zh: "P/NAV", en: "P/NAV" }, value: pnav, kind: "mult" },
    ];
  },
  // 逐年现金流明细（情景取中）：在产矿平价现金流、按各自寿命到期退出 → 总现金流阶梯衰减；无永续。
  schedule(vals) {
    const w = vals && vals.wacc;
    if (!Array.isArray(vals && vals.assets) || !isNum(w)) return null;
    const priceOf = priceResolver((vals && vals.prices) || {}, "mid");
    const tax = Number(vals.taxRate);
    let maxL = 0;
    const mines = [];
    for (const a of vals.assets) {
      if (!a || a.type === "fixed") continue;
      const com = COMMODITIES[a.commodity]; if (!com) continue;
      const price = Number(priceOf(a.commodity)), cost = Number(a.unitCost), output = Number(a.output), L = Math.floor(Number(a.life));
      if (!isNum(price) || !isNum(cost) || !isNum(output) || !isPos(L)) continue;
      const cf = output * com.toBase * (price - cost) * (1 - (isNum(tax) ? tax : 0) / 100);
      mines.push({ cf, L }); maxL = Math.max(maxL, L);
    }
    if (!isPos(maxL)) return null;
    const W = w / 100, rows = [];
    for (let t = 1; t <= maxL; t++) {
      let cf = 0;
      for (const m of mines) if (t <= m.L) cf += m.cf; // 平价：每年现金流恒定
      rows.push({ year: t, cf, pv: cf / Math.pow(1 + W, t) });
    }
    return { kind: "money", rows, terminalPv: null };
  },
};

export const RESOURCE = [NAVSOTP];
