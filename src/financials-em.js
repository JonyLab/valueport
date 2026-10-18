// 东方财富 F10 财报 —— 长桥财报(financial-reports)取不到时的免费兜底(A股 / 港股 / 美股,免鉴权)。
// 输出与 longbridge.parseFinancials 同形:{ IS:[Acct], BS:[Acct], CF:[Acct] } | null,
// Acct = { field, name, currency, values:[{ year, fpEnd, period, value, yoy }] }(最新期在前,各科目期数对齐)。
// 字段名沿用长桥(OperatingRevenue / NetProfit / NetDebt / NetFreeCashFlow …),前端无需改动。
//
// 口径(与长桥不完全一致,仅作兜底):
//  - 金额统一换算成「报价币种」(A股 CNY / 港股 HKD / 美股 USD),与长桥一致;汇率取 Frankfurter 当前价(各年同一汇率)。
//  - NetFreeCashFlow = 经营现金流 − 资本支出(长桥用自家口径,数值会有差异)。
//  - NetDebt = 有息负债(短/长期借款、应付债券、一年内到期非流动负债、租赁负债)− 现金及短期投资。
//  - ROE = 归母净利 / 平均归母权益;季报 ROE = 近 4 季归母净利 / 期末归母权益。
//  - 季报为单季值:A股/港股由累计值相减得到;港股只出半年报的公司没有季报(返回 null)。
// 失败一律返回 null,不抛。

const EM_BASE = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
const EM_HEADERS = { "User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/" };
const ANNUAL_YEARS = 10, QUARTERS = 12;

/* ---------- 市场 / 代码 ---------- */
export function emMarket(symbol) {
  const s = String(symbol || "");
  let m = /^(sh|sz|bj)(\d{6})$/i.exec(s);
  if (m) return { market: "A", secucode: `${m[2]}.${m[1].toUpperCase()}`, quoteCurrency: "CNY" };
  m = /^hk(\d{1,5})$/i.exec(s);
  if (m) return { market: "HK", secucode: `${m[1].padStart(5, "0")}.HK`, quoteCurrency: "HKD" };
  m = /^us([A-Za-z][A-Za-z0-9.\-]*)$/.exec(s);
  if (m) return { market: "US", ticker: m[1].toUpperCase(), quoteCurrency: "USD" };
  return null;
}

/* ---------- 小工具 ---------- */
const num = (x) => (x === null || x === undefined || x === "" ? NaN : Number(x));
const fin = (x) => Number.isFinite(x);
const day = (s) => (typeof s === "string" ? s.slice(0, 10) : "");
const absOr = (x) => (fin(x) ? Math.abs(x) : NaN);
// 若干项求和:全缺 → NaN;部分缺 → 按 0 计
function sumOf(vals) {
  const f = vals.filter(fin);
  return f.length ? f.reduce((a, b) => a + b, 0) : NaN;
}
function addMonths(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}
// 两日期间隔的季度数(四舍五入):START_DATE → REPORT_DATE
function quartersBetween(start, end) {
  const a = new Date(start + "T00:00:00Z"), b = new Date(end + "T00:00:00Z");
  return Math.round(((b - a) / 86400000 + 1) / 91.31);
}
// 财年标签:期末日 + 本期为财年第 fq 季 → 财年结束所在年份(Apple 2026-06-27 Q3 → FY2026)
function fiscalYearOf(end, fq) {
  const d = addMonths(end, (4 - fq) * 3);
  d.setUTCDate(d.getUTCDate() - 10); // 52/53 周财年的期末可能落在下月初
  return d.getUTCFullYear();
}
const CUR_MAP = { "人民币": "CNY", "港币": "HKD", "港元": "HKD", "美元": "USD" };

/* ---------- 东财数据中心 ---------- */
// paged:false —— RPT_CUSTOM_* 汇总类报表带分页参数(或列不含 REPORT_TYPE)会返回「数据为空」
export function emUrl(reportName, filter, { pageNumber = 1, pageSize = 500, columns = "ALL", sort = true, paged = true } = {}) {
  return `${EM_BASE}?reportName=${reportName}&columns=${columns}&quoteColumns=&filter=${encodeURIComponent(filter)}`
    + (paged ? `&pageNumber=${pageNumber}&pageSize=${pageSize}` : "") + (sort ? "&sortColumns=REPORT_DATE&sortTypes=-1" : "")
    + "&source=F10&client=PC";
}
async function emRows(fetchImpl, reportName, filter, opts = {}) {
  const maxPages = opts.maxPages || 1;
  const out = [];
  for (let p = 1; p <= maxPages; p++) {
    const res = await fetchImpl(emUrl(reportName, filter, { ...opts, pageNumber: p }), { headers: EM_HEADERS });
    if (!res.ok) throw new Error(`eastmoney ${reportName} http ${res.status}`);
    const j = await res.json();
    if (!j || !j.result || !Array.isArray(j.result.data)) { if (p === 1 && j && j.code === 9201) return []; break; } // 9201 = 无数据
    out.push(...j.result.data);
    if (!(j.result.pages > p)) break;
  }
  return out;
}
const sinceDate = (years) => `${new Date().getUTCFullYear() - years}-01-01`;

/* ---------- 各市场 → 统一期记录 ----------
 * Rec = { end, fq, flowQuarters, single, cur, v:{ rev, gross, opInc, np, eps, shares, ta, tl, te, pe, cash, debt, ocf, icf, ffcf, capex, div, repay } }
 *  flowQuarters:利润/现金流量覆盖的季度数(累计口径:1/2/3/4;单季口径:1 且 single=true)
 */

// A股:宽表(列名固定),累计口径,财年=自然年
export function recordsFromAShare({ income = [], balance = [], cashflow = [] }) {
  const byDate = new Map();
  const get = (d) => { if (!byDate.has(d)) byDate.set(d, { end: d, cur: "CNY", v: {} }); return byDate.get(d); };
  for (const r of income) {
    const rec = get(day(r.REPORT_DATE)); if (r.CURRENCY) rec.cur = r.CURRENCY;
    const rev = fin(num(r.OPERATE_INCOME)) ? num(r.OPERATE_INCOME) : num(r.TOTAL_OPERATE_INCOME);
    Object.assign(rec.v, {
      rev, gross: fin(rev) && fin(num(r.OPERATE_COST)) ? rev - num(r.OPERATE_COST) : NaN,
      opInc: num(r.OPERATE_PROFIT), np: num(r.PARENT_NETPROFIT), eps: num(r.BASIC_EPS),
    });
  }
  for (const r of balance) {
    const rec = get(day(r.REPORT_DATE));
    Object.assign(rec.v, {
      ta: num(r.TOTAL_ASSETS), tl: num(r.TOTAL_LIABILITIES), te: num(r.TOTAL_EQUITY), pe: num(r.TOTAL_PARENT_EQUITY),
      shares: num(r.SHARE_CAPITAL), // A股面值 1 元:股本(元)= 股数
      cash: sumOf([num(r.MONETARYFUNDS), num(r.TRADE_FINASSET), num(r.TRADE_FINASSET_NOTFVTPL)]),
      debt: sumOf([num(r.SHORT_LOAN), num(r.LONG_LOAN), num(r.BOND_PAYABLE), num(r.SHORT_BOND_PAYABLE), num(r.NONCURRENT_LIAB_1YEAR), num(r.LEASE_LIAB)]),
    });
  }
  for (const r of cashflow) {
    const rec = get(day(r.REPORT_DATE));
    Object.assign(rec.v, {
      ocf: num(r.NETCASH_OPERATE), icf: num(r.NETCASH_INVEST), ffcf: num(r.NETCASH_FINANCE),
      capex: absOr(num(r.CONSTRUCT_LONG_ASSET)), div: absOr(num(r.ASSIGN_DIVIDEND_PORFIT)), repay: absOr(num(r.PAY_DEBT_CASH)),
    });
  }
  const out = [];
  for (const rec of byDate.values()) {
    const mo = Number(rec.end.slice(5, 7));
    if (![3, 6, 9, 12].includes(mo)) continue;
    rec.fq = mo / 3; rec.flowQuarters = mo / 3; rec.single = false; rec.start = `${rec.end.slice(0, 4)}-01-01`;
    out.push(rec);
  }
  return out;
}

// 港股:长表(STD_ITEM_NAME / AMOUNT),累计口径(START_DATE 起算)。按名称取科目,兼容一般企业 / 银行 / 保险的不同科目表。
const HK_NAMES = {
  rev: ["营运收入", "经营收入总额", "营业额", "营业收入"],
  gross: ["毛利"],
  opInc: ["经营溢利"],
  np: ["股东应占溢利"],
  eps: ["每股基本盈利"],
  ta: ["总资产"], tl: ["总负债"], te: ["总权益", "股东权益合计", "净资产"], pe: ["股东权益", "归属于母公司股东权益"],
  ocf: ["经营业务现金净额"], icf: ["投资业务现金净额"], ffcf: ["融资业务现金净额"],
  capex: ["购建固定资产"], div: ["已付股息(融资)", "已付股息"],
};
const HK_SUM = {
  cash: ["现金及等价物", "短期存款", "受限制存款及现金", "指定以公允价值记账之金融资产(流动)"],
  debt: ["短期贷款", "长期贷款", "应付票据(非流动)", "可换股票据及债券", "融资租赁负债(流动)", "融资租赁负债(非流动)"],
  repay: ["偿还借款", "赎回债券", "偿还融资租赁"],
};
function pickByNames(items, names) {
  for (const n of names) if (items.has(n) && fin(items.get(n))) return items.get(n);
  return NaN;
}
function groupLong(rows) { // → Map(date → { start, fiscal, items: Map(name → amount) })
  const g = new Map();
  for (const r of rows || []) {
    const d = day(r.REPORT_DATE); if (!d) continue;
    if (!g.has(d)) g.set(d, { start: day(r.START_DATE), dateType: r.DATE_TYPE_CODE, items: new Map() });
    const e = g.get(d);
    if (!e.start && r.START_DATE) e.start = day(r.START_DATE);
    const name = r.STD_ITEM_NAME || r.ITEM_NAME;
    if (name && !e.items.has(name)) e.items.set(name, num(r.AMOUNT));
  }
  return g;
}
// 东财港股金额:报告币种为人民币的公司保持人民币,其余(美元/欧元/港币…)统一已折算为港币
// 取不到报告币种 → null(上游据此放弃,不输出可能错币种的数字)
export function hkAmountCurrency(reportCurrencyName) {
  if (!reportCurrencyName) return null;
  return reportCurrencyName === "人民币" ? "CNY" : "HKD";
}
export function recordsFromHK({ income = [], balance = [], cashflow = [], currencies = {} }) {
  const gi = groupLong(income), gb = groupLong(balance), gc = groupLong(cashflow);
  const dates = new Set([...gi.keys(), ...gb.keys(), ...gc.keys()]);
  const out = [];
  for (const d of dates) {
    const i = gi.get(d), b = gb.get(d), c = gc.get(d);
    const start = (i && i.start) || (c && c.start);
    if (!start) continue;
    const q = quartersBetween(start, d);
    if (q < 1 || q > 4) continue;
    const v = {};
    if (i) for (const k of ["rev", "gross", "opInc", "np", "eps"]) v[k] = pickByNames(i.items, HK_NAMES[k]);
    if (b) {
      for (const k of ["ta", "tl", "te", "pe"]) v[k] = pickByNames(b.items, HK_NAMES[k]);
      for (const k of ["cash", "debt"]) v[k] = sumOf(HK_SUM[k].map((n) => b.items.get(n)));
    }
    if (c) {
      for (const k of ["ocf", "icf", "ffcf"]) v[k] = pickByNames(c.items, HK_NAMES[k]);
      v.capex = absOr(pickByNames(c.items, HK_NAMES.capex));
      v.div = absOr(pickByNames(c.items, HK_NAMES.div));
      v.repay = sumOf(HK_SUM.repay.map((n) => absOr(c.items.get(n))));
    }
    // 股数 = 归母净利 / 基本每股收益(同一币种,比值与币种无关);每股收益过小时不可靠 → 不算
    if (fin(v.np) && fin(v.eps) && Math.abs(v.eps) >= 0.01) { const sh = v.np / v.eps; if (sh > 0) v.shares = sh; }
    out.push({ end: d, fq: q, flowQuarters: q, single: false, start, cur: hkAmountCurrency(currencies[d] || currencies._latest), v });
  }
  return out;
}

// 美股:长表(STD_ITEM_CODE / ITEM_NAME),年报(001)+ 单季报(003/008/006/007 = Q1..Q4),资产负债表按期末日对齐
const US_SINGLE_Q = { "003": 1, "008": 2, "006": 3, "007": 4 };
const US_BS_FQ = { "003": 1, "002": 2, "004": 3, "001": 4 };
const US_CODES = {
  rev: ["004001999", "004001001"], gross: ["004005999"], opInc: ["004009999"], np: ["004015999", "004013999"],
  eps: ["004017003", "004017001"], shares: ["004017007", "004017005"],
  ta: ["004005999"], tl: ["004011999"], te: ["004017999"], pe: ["004013999"],
  ocf: ["003999"], icf: ["005999"], ffcf: ["007999"], capex: ["005002"], div: ["007005"],
};
const US_SUM = {
  cash: ["004001001", "004001003", "004001016"],
  debt: ["004007003", "004007007", "004007008", "004007009", "004009005", "004009011"],
  repay: ["007004"],
};
function groupUS(rows, keyOf) {
  const g = new Map();
  for (const r of rows || []) {
    const k = keyOf(r); if (!k) continue;
    if (!g.has(k)) g.set(k, { end: day(r.REPORT_DATE), dateType: r.DATE_TYPE_CODE, cur: r.CURRENCY_ABBR || "", items: new Map() });
    const e = g.get(k);
    if (r.STD_ITEM_CODE && !e.items.has(r.STD_ITEM_CODE)) e.items.set(r.STD_ITEM_CODE, num(r.AMOUNT));
  }
  return g;
}
const pickCodes = (items, codes) => { for (const c of codes) if (items.has(c) && fin(items.get(c))) return items.get(c); return NaN; };
export function recordsFromUS({ income = [], balance = [], cashflow = [] }) {
  const key = (r) => (r.DATE_TYPE_CODE === "001" || US_SINGLE_Q[r.DATE_TYPE_CODE]) ? `${day(r.REPORT_DATE)}|${r.DATE_TYPE_CODE === "001" ? "FY" : "Q"}` : null;
  const gi = groupUS(income, key), gc = groupUS(cashflow, key);
  const gb = groupUS(balance, (r) => (US_BS_FQ[r.DATE_TYPE_CODE] ? day(r.REPORT_DATE) : null));
  const out = [];
  for (const k of new Set([...gi.keys(), ...gc.keys()])) {
    const i = gi.get(k), c = gc.get(k), first = i || c;
    const [end, kind] = k.split("|");
    const fq = kind === "FY" ? 4 : US_SINGLE_Q[first.dateType];
    const v = {};
    if (i) for (const f of ["rev", "gross", "opInc", "np", "eps", "shares"]) v[f] = pickCodes(i.items, US_CODES[f]);
    if (c) {
      for (const f of ["ocf", "icf", "ffcf"]) v[f] = pickCodes(c.items, US_CODES[f]);
      v.capex = absOr(pickCodes(c.items, US_CODES.capex));
      v.div = absOr(pickCodes(c.items, US_CODES.div));
      v.repay = sumOf(US_SUM.repay.map((x) => absOr(c.items.get(x))));
    }
    const b = gb.get(end);
    if (b) {
      for (const f of ["ta", "tl", "te", "pe"]) v[f] = pickCodes(b.items, US_CODES[f]);
      for (const f of ["cash", "debt"]) v[f] = sumOf(US_SUM[f].map((x) => b.items.get(x)));
    }
    out.push({ end, fq, flowQuarters: kind === "FY" ? 4 : 1, single: kind !== "FY", cur: first.cur || (b && b.cur) || "USD", v });
  }
  return out;
}

/* ---------- 期记录 → 年报 / 单季序列 ---------- */
const FLOW = ["rev", "gross", "opInc", "np", "eps", "ocf", "icf", "ffcf", "capex", "div", "repay"];

export function annualPeriods(recs) {
  return recs.filter((r) => r.flowQuarters === 4 && !r.single)
    .sort((a, b) => (a.end < b.end ? 1 : -1))
    .slice(0, ANNUAL_YEARS)
    .map((r) => ({ ...r, label: `FY ${fiscalYearOf(r.end, 4)}`, year: fiscalYearOf(r.end, 4) }));
}

// 单季:已是单季的直接用;累计口径 = 本期累计 − 同财年上一期累计(缺上一期 → 跳过该期)
export function quarterPeriods(recs) {
  const out = [];
  const cum = recs.filter((r) => !r.single);
  for (const r of recs) {
    let v;
    if (r.single) v = { ...r.v };
    else if (r.flowQuarters === 1) v = { ...r.v };
    else {
      const prev = cum.find((p) => p.flowQuarters === r.flowQuarters - 1 && p.start && p.start === r.start);
      if (!prev) continue;
      v = { ...r.v };
      for (const k of FLOW) v[k] = fin(r.v[k]) && fin(prev.v[k]) ? r.v[k] - prev.v[k] : NaN;
    }
    out.push({ ...r, v, single: true, label: `Q${r.fq} ${fiscalYearOf(r.end, r.fq)}`, year: fiscalYearOf(r.end, r.fq) });
  }
  return out.sort((a, b) => (a.end < b.end ? 1 : -1)).slice(0, QUARTERS);
}

/* ---------- 期序列 → { IS, BS, CF } ---------- */
const ACCOUNTS = {
  IS: [
    ["EPS", "每股收益", true], ["ROE", "ROE", false], ["OperatingRevenue", "营业收入", true], ["NetProfit", "净利润", true],
    ["OperatingIncome", "营业利润", true], ["GrossMgn", "毛利率", false], ["NetProfitMargin", "净利率", false],
  ],
  BS: [
    ["TotalAssets", "总资产", true], ["TotalLiability", "总负债", true], ["Leverage", "权益乘数", false],
    ["BPS", "每股净资产", true], ["CashSTInvest", "现金及短期投资", true], ["NetDebt", "净债务", true],
  ],
  CF: [
    ["NetOperateCashFlow", "经营现金流", true], ["NetInvestCashFlow", "投资现金流", true], ["NetFinanceCashFlow", "融资现金流", true],
    ["NetFreeCashFlow", "自由现金流", true], ["OCFCoverage", "经营现金流/(资本支出+分红+偿债）", false], ["CapEx", "资本支出", true],
  ],
};

// periods:最新在前;quarterly 决定 ROE 口径。fx:报告币种 → 目标币种的乘数表。
export function buildStatements(periods, { quarterly = false, currency, fx = {} } = {}) {
  if (!periods.length) return null;
  const rows = periods.map((p, idx) => {
    const k = p.cur === currency ? 1 : fx[p.cur];
    const m = (x) => (fin(x) && fin(k) ? x * k : NaN);
    const v = p.v;
    const te = fin(v.te) ? v.te : (fin(v.ta) && fin(v.tl) ? v.ta - v.tl : NaN);
    const pe = fin(v.pe) ? v.pe : te;
    let roe = NaN;
    if (quarterly) {
      const last4 = periods.slice(idx, idx + 4);
      if (last4.length === 4 && last4.every((q) => fin(q.v.np)) && fin(pe) && pe > 0) roe = last4.reduce((a, q) => a + q.v.np, 0) / pe * 100;
    } else {
      const prev = periods[idx + 1], ppe = prev && (fin(prev.v.pe) ? prev.v.pe : NaN);
      const avg = fin(ppe) && ppe > 0 ? (pe + ppe) / 2 : pe;
      if (fin(v.np) && fin(avg) && avg > 0) roe = v.np / avg * 100;
    }
    const outflow = sumOf([v.capex, v.div, v.repay]);
    return {
      EPS: m(v.eps), ROE: roe, OperatingRevenue: m(v.rev), NetProfit: m(v.np), OperatingIncome: m(v.opInc),
      GrossMgn: fin(v.gross) && v.rev ? v.gross / v.rev * 100 : NaN,
      NetProfitMargin: fin(v.np) && v.rev ? v.np / v.rev * 100 : NaN,
      TotalAssets: m(v.ta), TotalLiability: m(v.tl), Leverage: fin(v.ta) && te > 0 ? v.ta / te : NaN,
      BPS: fin(pe) && v.shares > 0 ? m(pe / v.shares) : NaN,
      CashSTInvest: m(v.cash), NetDebt: fin(v.debt) || fin(v.cash) ? m((fin(v.debt) ? v.debt : 0) - (fin(v.cash) ? v.cash : 0)) : NaN,
      NetOperateCashFlow: m(v.ocf), NetInvestCashFlow: m(v.icf), NetFinanceCashFlow: m(v.ffcf),
      NetFreeCashFlow: fin(v.ocf) && fin(v.capex) ? m(v.ocf - v.capex) : NaN,
      OCFCoverage: fin(v.ocf) && outflow > 0 ? v.ocf / outflow * 100 : NaN,
      CapEx: fin(v.capex) ? m(-v.capex) : NaN,
    };
  });
  const out = {};
  let any = false;
  for (const kind of Object.keys(ACCOUNTS)) {
    out[kind] = ACCOUNTS[kind].map(([field, name, money]) => ({
      field, name: money ? `${name}(${currency})` : name, currency,
      values: periods.map((p, i) => {
        const value = rows[i][field];
        if (fin(value)) any = true;
        return { year: p.year, fpEnd: p.end, period: p.label, value: fin(value) ? Math.round(value * 1e4) / 1e4 : NaN, yoy: "" };
      }),
    }));
  }
  return any ? out : null;
}

/* ---------- 汇率(Frankfurter / ECB,免 key) ---------- */
async function fxMultipliers(fetchImpl, from, to) {
  const need = [...new Set(from)].filter((c) => c && c !== to);
  const out = {};
  if (!need.length) return out;
  const res = await fetchImpl(`https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(to)}&to=${need.map(encodeURIComponent).join(",")}`, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error("fx http " + res.status);
  const j = await res.json();
  for (const c of need) if (j && j.rates && j.rates[c] > 0) out[c] = 1 / j.rates[c]; // 1 单位 c = ? 单位 to
  return out;
}

/* ---------- 拉取 ---------- */
async function rawAShare(fetchImpl, secucode, quarterly) {
  const f = quarterly ? `(SECUCODE="${secucode}")(REPORT_DATE>='${sinceDate(4)}')` : `(SECUCODE="${secucode}")(REPORT_TYPE="年报")`;
  const o = { pageSize: quarterly ? 20 : ANNUAL_YEARS + 1 };
  const [income, balance, cashflow] = await Promise.all([
    emRows(fetchImpl, "RPT_F10_FINANCE_GINCOME", f, o),
    emRows(fetchImpl, "RPT_F10_FINANCE_GBALANCE", f, o),
    emRows(fetchImpl, "RPT_F10_FINANCE_GCASHFLOW", f, o),
  ]);
  return { income, balance, cashflow };
}
async function rawHK(fetchImpl, secucode, quarterly) {
  const since = quarterly ? sinceDate(4) : sinceDate(ANNUAL_YEARS + 1);
  const f = `(SECUCODE="${secucode}")` + (quarterly ? "" : `(DATE_TYPE_CODE="001")`) + `(REPORT_DATE>='${since}')`;
  const o = { maxPages: 3 };
  const [income, balance, cashflow, summary] = await Promise.all([
    emRows(fetchImpl, "RPT_HKF10_FN_INCOME_PC", f, o),
    emRows(fetchImpl, "RPT_HKF10_FN_BALANCE_PC", f, o),
    emRows(fetchImpl, "RPT_HKF10_FN_CASHFLOW_PC", f, o),
    emRows(fetchImpl, "RPT_CUSTOM_HKF10_APPFN_INCOME_SUMMARY", `(SECUCODE="${secucode}")`, { columns: "SECUCODE,REPORT_DATE,CURRENCY,REPORT_TYPE", sort: false, paged: false }).catch(() => []),
  ]);
  const currencies = {};
  const list = (summary[0] && summary[0].REPORT_LIST) || [];
  for (const r of list) { if (r.REPORT_DATE) currencies[day(r.REPORT_DATE)] = r.CURRENCY; }
  if (list[0]) currencies._latest = list[0].CURRENCY;
  return { income, balance, cashflow, currencies };
}
async function rawUS(fetchImpl, ticker, quarterly) {
  const since = quarterly ? sinceDate(4) : sinceDate(ANNUAL_YEARS + 1);
  const t = `(SECURITY_CODE="${ticker}")(REPORT_DATE>='${since}')`;
  const flow = t + (quarterly ? `(DATE_TYPE_CODE in ("003","008","006","007"))` : `(DATE_TYPE_CODE="001")`);
  const bal = t + (quarterly ? "" : `(DATE_TYPE_CODE="001")`);
  const o = { maxPages: 3 };
  const [income, balance, cashflow] = await Promise.all([
    emRows(fetchImpl, "RPT_USF10_FN_INCOME", flow, o),
    emRows(fetchImpl, "RPT_USF10_FN_BALANCE", bal, o),
    emRows(fetchImpl, "RPT_USSK_FN_CASHFLOW", flow, o),
  ]);
  return { income, balance, cashflow };
}

// 主入口:report = "af"(年报) | "qf"(单季)。失败 / 无数据 / 需要汇率但取不到 → null。
export async function fetchEastmoneyFinancials(symbol, report, { fetchImpl = fetch } = {}) {
  const mk = emMarket(symbol);
  if (!mk) return null;
  const quarterly = report === "qf";
  try {
    let recs;
    if (mk.market === "A") recs = recordsFromAShare(await rawAShare(fetchImpl, mk.secucode, quarterly));
    else if (mk.market === "HK") recs = recordsFromHK(await rawHK(fetchImpl, mk.secucode, quarterly));
    else recs = recordsFromUS(await rawUS(fetchImpl, mk.ticker, quarterly));
    const periods = quarterly ? quarterPeriods(recs) : annualPeriods(recs);
    if (!periods.length) return null;
    const curs = periods.map((p) => p.cur);
    const fx = await fxMultipliers(fetchImpl, curs, mk.quoteCurrency);
    if (curs.some((c) => c !== mk.quoteCurrency && !(fx[c] > 0))) return null; // 汇率缺失时不返回错币种的数字
    return buildStatements(periods, { quarterly, currency: mk.quoteCurrency, fx });
  } catch (e) {
    console.error("eastmoney financials failed:", symbol, e && e.message);
    return null;
  }
}
