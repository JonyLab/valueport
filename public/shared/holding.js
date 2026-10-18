// 持仓与目标仓位的共用逻辑（资产页的持仓表、个股详情页的「我的持仓」卡都用这里，保证口径一致）
// 偏离按「5/25 规则」：|当前 − 目标| 超过 band 个百分点，或超过目标的 rel%，二者先到为准。
// 价值投资不机械再平衡：建议动作结合估值区间（zone：0 击球区 … 4 泡沫区，-1 未估值）。

export const driftTolerance = (tgt, plan) => Math.max(0.1, Math.min(plan.band, tgt * plan.rel / 100));
export function driftStatus(held, cur, tgt, tol) {
  if (!held) return "build";
  const d = cur - tgt;
  return d > tol ? "over" : d < -tol ? "under" : "ok";
}
export function driftAction(status, zone) {
  const hot = zone >= 3, cheap = zone >= 0 && zone <= 1;
  if (status === "build") return cheap ? "buildCheap" : "build";
  if (status === "over") return hot ? "trimHot" : cheap ? "trimHold" : "trim";
  if (status === "under") return cheap ? "addCheap" : hot ? "addWait" : "add";
  return "ok";
}
export function driftText(lang) {
  const zh = lang !== "en", T = (a, b) => (zh ? a : b);
  return {
    trimHot: T("超配且已高估，考虑减仓", "Overweight and overvalued — consider trimming"),
    trimHold: T("超配但仍低估，可以继续持有，留意集中度", "Overweight but still cheap — fine to hold, watch concentration"),
    trim: T("超配，按计划减仓回到目标", "Overweight — trim back to target"),
    addCheap: T("低配且价格便宜，是加仓的好时机", "Underweight and cheap — a good time to add"),
    addWait: T("低配但已高估，不急着补，等更好的价格", "Underweight but expensive — wait for a better price"),
    add: T("低配，按计划加仓回到目标", "Underweight — add back to target"),
    build: T("计划建仓", "Planned position"),
    buildCheap: T("计划建仓，已进入击球区 / 低估", "Planned — now in strike / undervalued zone"),
    ok: T("在容忍带内", "Within band"),
    cashLow: T("现金低于目标，加仓余力不足", "Cash below target — less room to add"),
    cashHigh: T("现金高于目标，可以留意击球区标的", "Cash above target — look for strike-zone names"),
  };
}

// 某只股票在全部账户里的持仓汇总（d = GET /api/my/portfolio 的返回）。
// 金额：native = 该股票自己的币种；base = 资产页的折算币种。没持有也没设目标 → null
export function holdingFor(d, symbol, zone) {
  if (!d || !Array.isArray(d.holdings)) return null;
  const fx = d.fx || {}, conv = (v, cur) => (fx[cur] > 0 ? v * fx[cur] : NaN);
  const plan = d.plan || { targets: {}, cash: null, band: 5, rel: 25 };
  const tgt = plan.targets && plan.targets[symbol];
  const mine = d.holdings.filter((h) => h.symbol === symbol);
  if (!mine.length && !(tgt > 0)) return null;
  // 总资产（base），用来算占比
  let total = 0;
  for (const h of d.holdings) { const p = d.quotes[h.symbol]; if (p > 0) { const v = conv(h.quantity * p, h.currency); if (Number.isFinite(v)) total += v; } }
  for (const c of d.cash || []) { const v = conv(c.amount, c.currency); if (Number.isFinite(v)) total += v; }
  const price = d.quotes[symbol], prev = d.prevClose && d.prevClose[symbol];
  const currency = mine.length ? mine[0].currency : (symbol.startsWith("us") ? "USD" : symbol.startsWith("hk") ? "HKD" : "CNY");
  const accName = new Map((d.accounts || []).map((a) => [a.id, a.name]));
  let qty = 0, costQty = 0, cost = 0;
  const accounts = mine.map((h) => {
    qty += h.quantity;
    if (Number.isFinite(h.costPrice) && h.costPrice > 0) { costQty += h.quantity; cost += h.quantity * h.costPrice; }
    return { name: accName.get(h.accountId) || "", qty: h.quantity, costPrice: Number.isFinite(h.costPrice) && h.costPrice > 0 ? h.costPrice : NaN };
  });
  const value = price > 0 ? qty * price : NaN;
  const avgCost = costQty ? cost / costQty : NaN;
  const pnl = costQty && price > 0 ? costQty * price - cost : NaN;
  const out = {
    held: mine.length > 0, currency, base: d.base, qty, price, avgCost, value, pnl,
    pnlPct: Number.isFinite(pnl) && cost ? pnl / cost * 100 : NaN,
    day: price > 0 && prev > 0 ? qty * (price - prev) : NaN,
    weight: total && Number.isFinite(conv(value, currency)) ? conv(value, currency) / total * 100 : 0,
    accounts, plan: null,
  };
  if (tgt > 0) {
    const tol = driftTolerance(tgt, plan), status = driftStatus(out.held, out.weight, tgt, tol);
    const trade = (tgt - out.weight) / 100 * total;          // 回到目标需要买(+)卖(−)多少（base）
    const px = price > 0 ? conv(price, currency) : NaN;
    out.plan = { tgt, tol, drift: out.weight - tgt, status, action: driftAction(status, zone), trade, shares: px > 0 ? Math.round(trade / px) : NaN };
  }
  return out;
}
