// Pure, DOM-free portfolio aggregation, target-plan drift view, credential blob parsing,
// and user-entered symbol normalization. Shared with unit tests (test-core/portfolio-model.test.js).
import { computeAnchors, priceToPhi, structValid, ZONES } from "../core.js";
import { driftTolerance, driftStatus, driftAction } from "../holding.js";
import { evaluateSignalAlerts, isAllocOnly, computeBucketSummary, computeScheduleStatus } from "../rebalance.js";

// 现价落在看板估值区间的第几段；-1 = 未估值（不在看板或没设区间）
export function zoneFor(it, price) {
  if (!it || !(price > 0)) return -1;
  const cfg = { ...it, price };
  if (!structValid(cfg)) return -1;
  return Math.min(ZONES.length - 1, Math.floor(Math.max(0, Math.min(179.9, priceToPhi(computeAnchors(cfg), price))) / (180 / ZONES.length)));
}

export function currencyOfSymbol(sym) {
  return sym.startsWith("us") ? "USD" : sym.startsWith("hk") ? "HKD" : "CNY";
}

// 前端先把常见写法规整成腾讯格式（后端会再校验）
export function normSymbol(raw) {
  const s = String(raw || "").trim();
  if (/^(us|hk|sh|sz)[A-Za-z0-9.]+$/.test(s)) return s.slice(0, 2) + (s.startsWith("us") ? s.slice(2).toUpperCase() : s.slice(2));
  let m = /^([A-Za-z.]+)\.US$/i.exec(s); if (m) return "us" + m[1].toUpperCase();
  m = /^(\d{1,5})\.HK$/i.exec(s); if (m) return "hk" + m[1].padStart(5, "0");
  m = /^(\d{6})\.(SH|SS)$/i.exec(s); if (m) return "sh" + m[1];
  m = /^(\d{6})\.SZ$/i.exec(s); if (m) return "sz" + m[1];
  if (/^\d{6}$/.test(s)) return (/^[695]/.test(s) ? "sh" : "sz") + s;
  if (/^\d{1,5}$/.test(s)) return "hk" + s.padStart(5, "0");
  if (/^[A-Za-z.]+$/.test(s)) return "us" + s.toUpperCase();
  return s;
}

// 一次粘贴多项凭证（长桥「复制所有」等）：拆成 { appKey, appSecret, accessToken } / { token, queryId }
export function parseCredBlob(text, broker) {
  const want = broker === "ibkr" ? { token: /token/, queryId: /query/ }
    : broker === "tiger" ? { tigerId: /^(tiger)?id$/, account: /^account$/, privateKey: /privatekey/, token: /^token$/ }
    : broker === "etrade" ? { consumerKey: /consumerkey|^key$/, consumerSecret: /consumersecret|^secret$/ }
    : { appKey: /appkey|^key$/, appSecret: /appsecret|^secret$/, accessToken: /accesstoken|^token$/ };
  const norm = (k) => String(k).toLowerCase().replace(/^(export\s+)?(longport|longbridge|lb|ibkr|flex|tigeropen)[_\s-]*/, "").replace(/[^a-z]/g, "");
  const out = {};
  const put = (k, v) => {
    const nk = norm(k);
    v = String(v || "").trim().replace(/^["'`]|["'`,;]+$/g, "").replace(/^["'`]|["'`]$/g, "");
    if (!v) return;
    for (const [f, re] of Object.entries(want)) if (!out[f] && re.test(nk)) { out[f] = v; return; }
  };
  const t = String(text || "").trim();
  try { const j = JSON.parse(t); if (j && typeof j === "object") { for (const [k, v] of Object.entries(j)) put(k, v); return out; } } catch {}
  const lines = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const bare = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:export\s+)?["']?([A-Za-z][A-Za-z0-9 _-]{0,39}?)["']?\s*[:=：]\s*(.*[^=\s].*)$/.exec(lines[i]);
    if (m) { put(m[1], m[2]); continue; }
    if (Object.values(want).some((re) => re.test(norm(lines[i]))) && i + 1 < lines.length) { put(lines[i], lines[i + 1]); i++; continue; }
    bare.push(lines[i]);
  }
  if (broker === "longbridge" && !Object.keys(out).length && bare.length === 3) {
    const [k, sc, tk] = [...bare].sort((a, b) => a.length - b.length);
    out.appKey = k; out.appSecret = sc; out.accessToken = tk;
  }
  return out;
}

export function planView(d, s, items, conv) {
  const plan = d.plan || { targets: {}, cash: null, band: 5, rel: 25 };
  const targets = plan.targets || {};
  const active = Object.keys(targets).length > 0 || Number.isFinite(plan.cash);
  const tot = s.total;
  const tolOf = (t) => driftTolerance(t, plan);
  const held = new Map(s.rows.map((r) => [r.symbol, r]));
  const rows = [];
  for (const [sym, tgt] of Object.entries(targets)) {
    const h = held.get(sym), it = items.get(sym);
    const price = h ? h.price : d.quotes[sym];
    const cur = h && Number.isFinite(h.value) && tot ? h.value / tot * 100 : 0;
    const zone = h ? h.zone : zoneFor(it, price);
    const currency = h ? h.currency : currencyOfSymbol(sym);
    const tol = tolOf(tgt), drift = cur - tgt;
    const status = driftStatus(!!h, cur, tgt, tol);
    const action = driftAction(status, zone);
    const trade = (tgt - cur) / 100 * tot;
    const px = price > 0 ? conv(price, currency) : NaN;
    const shares = Number.isFinite(px) && px > 0 ? Math.round(trade / px) : NaN;
    rows.push({
      symbol: sym,
      name: (it && it.name) || (h && (h.boardName || h.name)) || sym.slice(2).toUpperCase(),
      ticker: it ? it.ticker : "",
      cur, tgt, tol, drift, status, zone, action, trade, shares, currency,
    });
  }
  const untargeted = active ? s.rows.filter((r) => !(r.symbol in targets) && Number.isFinite(r.value) && r.value > 0)
    .map((r) => ({ symbol: r.symbol, name: r.boardName || r.name || r.symbol, cur: tot ? r.value / tot * 100 : 0, zone: r.zone })) : [];
  let cash = null;
  if (Number.isFinite(plan.cash)) {
    const cur = tot ? s.cashValue / tot * 100 : 0, tol = tolOf(plan.cash), drift = cur - plan.cash;
    cash = { cur, tgt: plan.cash, tol, drift, status: drift > tol ? "over" : drift < -tol ? "under" : "ok", trade: (plan.cash - cur) / 100 * tot };
  }
  const rank = (r) => (r.status === "over" || r.status === "under" ? 0 : r.status === "build" ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || Math.abs(b.drift) - Math.abs(a.drift));
  const allocated = Object.values(targets).reduce((a, b) => a + b, 0) + (Number.isFinite(plan.cash) ? plan.cash : 0);
  const offCount = rows.filter((r) => r.status === "over" || r.status === "under").length + (cash && cash.status !== "ok" ? 1 : 0);
  return { plan, active, rows, untargeted, cash, allocated, offCount };
}

// 每只持仓：市值 / 成本 / 今日涨跌都换算成 base；同一标的跨账户合并成一行
export function summarizePortfolio(d, { macroData = null, lang = "zh" } = {}) {
  const zh = lang !== "en";
  const zoneNames = zh ? ["击球区", "低估", "合理", "高估", "泡沫区"] : ["Strike zone", "Undervalued", "Fair", "Overvalued", "Bubble"];
  const noneName = zh ? "未估值" : "Not valued";
  const allocName = zh ? "配置型" : "Allocation";
  const cashLabel = zh ? "现金" : "Cash";

  const accName = new Map(d.accounts.map((a) => [a.id, a.name]));
  const fx = d.fx || {};
  const missingFx = new Set();
  const conv = (v, cur) => { const r = fx[cur]; if (!(r > 0)) { missingFx.add(cur); return NaN; } return v * r; };
  const bySym = new Map();
  let noPrice = 0;
  for (const h of d.holdings) {
    const price = d.quotes[h.symbol], prev = d.prevClose[h.symbol];
    if (!(price > 0)) noPrice++;
    const row = bySym.get(h.symbol) || { symbol: h.symbol, name: h.name, currency: h.currency, market: h.market, qty: 0, value: 0, cost: 0, costKnown: true, day: 0, price, accounts: new Set(), byAcc: {} };
    row.qty += h.quantity;
    const hv = price > 0 ? conv(h.quantity * price, h.currency) : NaN;
    row.value += hv;
    const an = accName.get(h.accountId) || "";
    if (Number.isFinite(hv)) row.byAcc[an] = (row.byAcc[an] || 0) + hv;
    if (Number.isFinite(h.costPrice) && h.costPrice > 0) row.cost += conv(h.quantity * h.costPrice, h.currency); else row.costKnown = false;
    if (price > 0 && prev > 0) row.day += conv(h.quantity * (price - prev), h.currency);
    row.accounts.add(accName.get(h.accountId) || "");
    if (!row.name && h.name) row.name = h.name;
    bySym.set(h.symbol, row);
  }
  const items = new Map(d.items.map((it) => [it.symbol, it]));
  const planObj = d.plan || {};
  const assetClass = planObj.assetClass || {};
  const bucketNames = new Map((planObj.buckets || []).map((b) => [b.id, b.name]));
  const rows = [...bySym.values()].map((r) => {
    const it = items.get(r.symbol);
    const bid = assetClass[r.symbol] || "";
    return {
      ...r, zone: zoneFor(it, r.price), onBoard: !!it, ticker: it ? it.ticker : "", boardName: it ? it.name : "",
      allocOnly: isAllocOnly(planObj, r.symbol), bucketId: bid, bucketName: bucketNames.get(bid) || "",
    };
  }).sort((a, b) => (b.value || 0) - (a.value || 0));
  const holdValue = rows.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0);
  const cashRows = new Map();
  for (const c of d.cash) cashRows.set(c.currency, (cashRows.get(c.currency) || 0) + c.amount);
  let cashValue = 0;
  for (const [cur, amt] of cashRows) { const v = conv(amt, cur); if (Number.isFinite(v)) cashValue += v; }
  const pnlRows = rows.filter((r) => r.costKnown && Number.isFinite(r.value) && r.cost > 0);
  const pnl = pnlRows.reduce((s, r) => s + r.value - r.cost, 0), pnlCost = pnlRows.reduce((s, r) => s + r.cost, 0);
  const day = rows.reduce((s, r) => s + (Number.isFinite(r.day) ? r.day : 0), 0);
  const total = holdValue + cashValue;
  const zones = [
    ...ZONES.map((z, i) => ({ i, key: z.key, name: zoneNames[i], color: z.hex, value: 0, count: 0 })),
    { i: -2, key: "alloc", name: allocName, color: "#a39e93", value: 0, count: 0 },
    { i: -1, key: "none", name: noneName, color: "", value: 0, count: 0 },
  ];
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    const zi = r.zone >= 0 ? r.zone : (r.allocOnly ? -2 : -1);
    const z = zones.find((x) => x.i === zi);
    z.value += r.value; z.count++;
  }
  const byMarket = new Map(), byCur = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    const mk = r.symbol.slice(0, 2) === "us" ? "US" : r.symbol.slice(0, 2) === "hk" ? "HK" : "CN";
    byMarket.set(mk, (byMarket.get(mk) || 0) + r.value);
    byCur.set(r.currency, (byCur.get(r.currency) || 0) + r.value);
  }
  if (cashValue) byMarket.set(cashLabel, cashValue);
  for (const [cur, amt] of cashRows) { const v = conv(amt, cur); if (Number.isFinite(v)) byCur.set(cur, (byCur.get(cur) || 0) + v); }
  const zoneOf = new Map(rows.map((r) => [r.symbol, r.zone]));
  const nameOf = new Map(rows.map((r) => [r.symbol, r.boardName || r.name || r.symbol.slice(2).toUpperCase()]));
  const perAcc = new Map(d.accounts.map((a) => [a.id, { value: 0, cash: 0, zones: new Map(), top: null }]));
  for (const h of d.holdings) {
    const p = d.quotes[h.symbol]; const v = p > 0 ? conv(h.quantity * p, h.currency) : NaN; const A = perAcc.get(h.accountId);
    if (!A || !Number.isFinite(v)) continue;
    A.value += v;
    const z = zoneOf.get(h.symbol); A.zones.set(z, (A.zones.get(z) || 0) + v);
    if (!A.top || v > A.top.value) A.top = { name: nameOf.get(h.symbol), value: v };
  }
  for (const c of d.cash) { const A = perAcc.get(c.accountId); const v = conv(c.amount, c.currency); if (A && Number.isFinite(v)) { A.cash += v; A.value += v; } }
  const byAccount = new Map(d.accounts.map((a) => [a.name, perAcc.get(a.id).value]));
  const s0 = { rows, holdValue, cashValue, total };
  const buckets = computeBucketSummary({ rows, cashValue, total, plan: planObj, items });
  const signalAlerts = evaluateSignalAlerts(planObj.signalAlerts, macroData, planObj.profiles);
  const schedule = computeScheduleStatus(planObj.schedule);
  return {
    ...s0,
    plan: planView(d, s0, items, conv),
    buckets, signalAlerts, schedule, items, conv,
    pnl, pnlPct: pnlCost ? pnl / pnlCost * 100 : NaN,
    day, dayPct: total - day ? day / (total - day) * 100 : NaN,
    zones, byMarket, byCur, byAccount, perAcc,
    missingFx: [...missingFx], noPrice,
  };
}
