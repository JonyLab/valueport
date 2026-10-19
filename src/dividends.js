// 东方财富数据中心 · 逐年每股现金分红历史（A股 / 港股 / 美股，免费、无鉴权）。
// 统一返回 { currency, years:[{year, perShare}]（升序）} | null。调用方按日缓存；失败一律返回 null，不抛。
// A股取数值字段 PRETAX_BONUS_RMB（每10股税前派息）；港股/美股从 PLAN_EXPLAIN 文本解析金额。

const EM_BASE = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
const EM_HEADERS = { "User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/" };

// 本项目代码 → 东财 SECUCODE（A股：688981.SH；港股：00883.HK）；美股单独走 ticker。
export function emSecucode(symbol) {
  const a = /^(sh|sz|bj)(\d{4,6})$/i.exec(symbol || "");
  if (a) return `${a[2]}.${a[1].toUpperCase()}`;
  const h = /^hk(\d{1,5})$/i.exec(symbol || "");
  if (h) return `${h[1].padStart(5, "0")}.HK`;
  return null;
}
export function usDivTicker(symbol) {
  const m = /^us(.+)$/i.exec(symbol || "");
  return m ? m[1].toUpperCase() : null;
}

// "每股派港币0.55元" / "每1股派0.27美元股息" → { amount, currency } | null（未派/送转无现金 → null）
export function parsePlanExplain(text) {
  if (typeof text !== "string" || !text) return null;
  if (/未派|不派|不分配|无派/.test(text)) return null;
  const m = text.match(/派[^\d]*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  let amount = parseFloat(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  let currency = "";
  if (/美元|美金/.test(text)) currency = "USD";
  else if (/港币|港元|港仙/.test(text)) currency = "HKD";
  else if (/人民币|元/.test(text)) currency = "CNY";
  if (/美分|港仙/.test(text)) amount /= 100; // 分/仙 → 元
  return { amount, currency };
}

// A股 RPT_SHAREBONUS_DET → { currency, byYear }；按 REPORT_DATE 年份累加现金派息（每10股→每股）
export function aggregateAShare(rows) {
  const byYear = {}, pays = [];
  for (const r of rows || []) {
    const cash = Number(r && r.PRETAX_BONUS_RMB);
    const y = typeof (r && r.REPORT_DATE) === "string" ? Number(r.REPORT_DATE.slice(0, 4)) : NaN;
    if (!Number.isFinite(cash) || cash <= 0 || !Number.isFinite(y)) continue;
    byYear[y] = (byYear[y] || 0) + cash / 10;
    addPay(pays, r, cash / 10);
  }
  return { currency: "CNY", byYear, pays };
}

// 港股 RPT_HKF10_MAIN_DIVBASIC → 按 YEAR（财年）累加 PLAN_EXPLAIN 金额
export function aggregateHK(rows) {
  const byYear = {}, pays = []; let currency = "";
  for (const r of rows || []) {
    const p = parsePlanExplain(r && r.PLAN_EXPLAIN);
    const y = Number(r && r.YEAR);
    if (!p || !Number.isFinite(y)) continue;
    byYear[y] = (byYear[y] || 0) + p.amount;
    addPay(pays, r, p.amount);
    if (p.currency) currency = p.currency;
  }
  return { currency: currency || "HKD", byYear, pays };
}

// 美股 RPT_USF10_INFO_DIVIDEND → 按 ASSIGN_PERIOD 年份累加 PLAN_EXPLAIN 金额
export function aggregateUS(rows) {
  const byYear = {}, pays = []; let currency = "";
  for (const r of rows || []) {
    const p = parsePlanExplain(r && r.PLAN_EXPLAIN);
    const mm = typeof (r && r.ASSIGN_PERIOD) === "string" ? r.ASSIGN_PERIOD.match(/(\d{4})/) : null;
    const y = mm ? Number(mm[1]) : NaN;
    if (!p || !Number.isFinite(y)) continue;
    byYear[y] = (byYear[y] || 0) + p.amount;
    addPay(pays, r, p.amount);
    if (p.currency) currency = p.currency;
  }
  return { currency: currency || "USD", byYear, pays };
}

// { currency, byYear } → { currency, years:[{year, perShare}] 升序 } | null
export function normalizeDividends(agg, now = Date.now()) {
  if (!agg || !agg.byYear) return null;
  const years = Object.keys(agg.byYear).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
    .map((y) => ({ year: y, perShare: Math.round(agg.byYear[y] * 1e4) / 1e4 }))
    .filter((x) => x.perShare > 0);
  return years.length ? { currency: agg.currency, years, ttm: trailingDividends(agg.pays, now) } : null;
}

// 近一年每股股息：除息日落在过去 365 天内的各次现金派息之和（还没到除息日的不算）→ { perShare, count, from, to } | null
export function trailingDividends(pays, now = Date.now()) {
  const end = new Date(now).toISOString().slice(0, 10), start = new Date(now - 365 * 86400000).toISOString().slice(0, 10);
  const hit = (pays || []).filter((p) => p.date > start && p.date <= end);
  if (!hit.length) return null;
  const sum = hit.reduce((a, p) => a + p.amount, 0);
  const dates = hit.map((p) => p.date).sort();
  return { perShare: Math.round(sum * 1e4) / 1e4, count: hit.length, from: dates[0], to: dates[dates.length - 1] };
}
// 每次派息的日期：优先除息日，没有就用派息日 / 公告日（港股未宣派的行常没有除息日）
function addPay(pays, r, amount) {
  const d = [r && r.EX_DIVIDEND_DATE, r && r.DIVIDEND_DATE, r && r.BONUS_PAY_DATE, r && r.NOTICE_DATE].find((x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x));
  if (d && Number.isFinite(amount) && amount > 0) pays.push({ date: d.slice(0, 10), amount });
}

async function emGet(reportName, secucode, source) {
  const url = `${EM_BASE}?reportName=${reportName}&columns=ALL`
    + `&filter=(SECUCODE%3D%22${encodeURIComponent(secucode)}%22)&pageSize=60&source=${source}&client=PC`;
  const res = await fetch(url, { headers: EM_HEADERS });
  if (!res.ok) return null;
  const j = await res.json();
  return (j && j.success && j.result && Array.isArray(j.result.data)) ? j.result.data : null;
}

// 逐年每股现金分红历史。非支持市场 / 失败 / 无派息 → null。
export async function fetchDividendHistory(symbol) {
  const sym = (symbol || "").toLowerCase();
  try {
    if (/^(sh|sz|bj)\d/.test(sym)) {
      const secu = emSecucode(symbol);
      if (!secu) return null;
      return normalizeDividends(aggregateAShare(await emGet("RPT_SHAREBONUS_DET", secu, "HSF10")));
    }
    if (/^hk\d/.test(sym)) {
      const secu = emSecucode(symbol);
      if (!secu) return null;
      return normalizeDividends(aggregateHK(await emGet("RPT_HKF10_MAIN_DIVBASIC", secu, "F10")));
    }
    if (/^us/.test(sym)) {
      const ticker = usDivTicker(symbol);
      if (!ticker) return null;
      for (const sfx of ["O", "N", "A"]) { // 交易所后缀未知，依次试 NASDAQ/NYSE/AMEX
        const rows = await emGet("RPT_USF10_INFO_DIVIDEND", `${ticker}.${sfx}`, "F10");
        if (rows && rows.length) return normalizeDividends(aggregateUS(rows));
      }
    }
  } catch { return null; }
  return null;
}
