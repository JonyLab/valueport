/**
 * valuation/resource.js — 资源股 NAV / SOTP（分部资产净值法）。
 * 每个资产按「全生命周期(life-of-mine)有限年限现金流」折现，无永续项（储量会枯竭）；
 * 各资产现值加总 − 净负债 = 股权 NAV ÷ 股本 = 每股 NAV。现价/每股NAV = P/NAV 由钟摆判定。
 * 与其它内在模型不同：用 model.run() 自跑保守/乐观两侧（每资产各自的增速），不走通用 cons/opt 拆分。
 */
const isNum = (x) => typeof x === "number" && isFinite(x);
const isPos = (x) => isNum(x) && x > 0;

// 单资产：第 t=1..L 年现金流(起点 cf 按 g 复利)折现，无永续终值。g、r 为小数。
export function assetPV(cf, L, g, r) {
  if (!isNum(cf) || !isNum(g) || !isNum(r) || !isPos(L)) return NaN;
  const yrs = Math.floor(L);
  let pv = 0;
  for (let t = 1; t <= yrs; t++) pv += cf * Math.pow(1 + g, t) / Math.pow(1 + r, t);
  return pv;
}

// 资产数组 → 每股 NAV。side 选每资产增速('c'|'o')；rPct 折现率(%)；netDebt 金额；shares 股本。
// 无有效资产 / 股本无效 → null。
export function navPerShare(assets, side, rPct, netDebt, shares) {
  if (!Array.isArray(assets) || !isPos(shares) || !isNum(rPct) || !isNum(netDebt)) return null;
  const r = rPct / 100;
  let sumPV = 0, valid = 0;
  for (const a of assets) {
    if (!a) continue;
    const cf = Number(a.cf), L = Number(a.L);
    const g = Number(a.growth && a.growth[side]);
    if (!isNum(cf) || !isPos(L) || !isNum(g)) continue;
    const pv = assetPV(cf, L, g / 100, r);
    if (!isNum(pv)) continue;
    sumPV += pv; valid++;
  }
  if (!valid) return null;
  return (sumPV - netDebt) / shares;
}

// 每资产增速取中（保守/乐观均值）—— 给摘要/明细用
function midGrowth(a) {
  const gc = Number(a && a.growth && a.growth.c), go = Number(a && a.growth && a.growth.o);
  return (isNum(gc) && isNum(go)) ? (gc + go) / 2 : (isNum(gc) ? gc : (isNum(go) ? go : 0));
}

const NAVSOTP = {
  key: "navsotp",
  group: "intrinsic",
  label: { zh: "资源股 NAV / SOTP", en: "Resource NAV / SOTP" },
  assetModel: true, // UI 标记：渲染资产表（每资产一行 → 有限寿命 DCF 加总）
  fields: [
    { k: "discount", label: { zh: "折现率", en: "Discount rate" }, col: "dual", unit: "%", default: 8, meta: "wacc" },
    { k: "netDebt", label: { zh: "净负债", en: "Net debt" }, col: "single", unit: "", prefill: (ctx) => (ctx && isNum(ctx.netDebt)) ? ctx.netDebt : 0, default: 0, meta: "netDebt" },
  ],
  // 自跑两侧：保守=各资产保守增速+折现率保守侧；乐观=乐观增速+折现率乐观侧。
  run(form, ctx) {
    const shares = ctx && ctx.shares;
    const assets = form && form.assets;
    const d = form && form.discount, nd = form && form.netDebt;
    if (!Array.isArray(assets) || !isPos(shares)) return { low: null, high: null };
    const rc = d && typeof d === "object" ? d.c : NaN, ro = d && typeof d === "object" ? d.o : NaN;
    const a = navPerShare(assets, "c", rc, nd, shares);
    const b = navPerShare(assets, "o", ro, nd, shares);
    if (a === null || b === null) return { low: null, high: null };
    return { low: Math.min(a, b), high: Math.max(a, b) };
  },
  // 结果卡明细：用每资产增速取中 + 传入的折现率标量（cons=保守率, opt=乐观率）→ 区间体现利率敏感性。
  breakdown(vals, ctx) {
    const assets = vals && vals.assets, shares = ctx && ctx.shares, r = vals && vals.discount, nd = vals && vals.netDebt;
    if (!Array.isArray(assets) || !isPos(shares) || !isNum(r) || !isNum(nd)) return [];
    let sumPV = 0;
    for (const a of assets) {
      const pv = assetPV(Number(a && a.cf), Number(a && a.L), midGrowth(a) / 100, r / 100);
      if (isNum(pv)) sumPV += pv;
    }
    const equity = sumPV - nd, ps = equity / shares;
    const price = ctx && ctx.price;
    const pnav = (isPos(price) && isPos(ps)) ? price / ps : null;
    return [
      { key: "sumpv", label: { zh: "资产现值合计", en: "Sum of asset PV" }, value: sumPV, kind: "money" },
      { key: "equity", label: { zh: "股权 NAV", en: "Equity NAV" }, value: equity, kind: "money" },
      { key: "pnav", label: { zh: "P/NAV", en: "P/NAV" }, value: pnav, kind: "mult" },
    ];
  },
  // 逐年现金流明细（情景取中）：各资产按自身寿命到期退出 → 总现金流自然衰减；无永续项。
  schedule(vals) {
    const assets = vals && vals.assets, r = vals && vals.discount;
    if (!Array.isArray(assets) || !isNum(r)) return null;
    let maxL = 0;
    const norm = assets.map((a) => {
      const cf = Number(a && a.cf), L = Math.floor(Number(a && a.L));
      if (isPos(L) && isNum(cf)) maxL = Math.max(maxL, L);
      return { cf, L, g: midGrowth(a) / 100 };
    });
    if (!isPos(maxL)) return null;
    const R = r / 100, rows = [];
    for (let t = 1; t <= maxL; t++) {
      let cf = 0;
      for (const a of norm) if (isNum(a.cf) && isPos(a.L) && t <= a.L) cf += a.cf * Math.pow(1 + a.g, t);
      rows.push({ year: t, cf, pv: cf / Math.pow(1 + R, t) });
    }
    return { kind: "money", rows, terminalPv: null };
  },
};

export const RESOURCE = [NAVSOTP];
