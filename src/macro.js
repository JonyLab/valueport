// 宏观看板（MVP）：只量「水位」与「引力」，不预测天气（设计见 docs/macro-design.md）。
// 数据按月：每周最多刷新一次（每日 cron 里顺带检查；首次访问库里没数据时当场拉一次），存 D1 的 macro_series。
// 每个指标看它在自己历史里的百分位；一个市场的「水位」= 各指标「贵的程度」百分位的平均，映射到钟摆五区间：
//   0–10 击球区 · 10–30 低估 · 30–70 合理 · 70–90 高估 · 90–100 泡沫区
//
// 数据源（都免费、无需 Key）：
//   multpl.com 月度表：Shiller CAPE（1871 年起）、10 年国债（1871 年起）、10 年实际利率（2003 年起）
//   FRED 公开 CSV：NCBEILQ027S（非金融企业股权市值，百万美元，季度）、GDP（十亿美元，季度）——只用于市值 / GDP，拿不到就缺这一项
//   东方财富：中国 10 年国债（RPTA_WEB_TREASURYYIELD.EMM00166466）、全 A 股 PE(TTM) 与总市值（RPT_VALUEMARKET，代码 000300，2017 年起）

const FRED = (id) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
const MULTPL = (p) => `https://www.multpl.com/${p}/table/by-month`;
const EM = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const REFRESH_DAYS = 7;

// ---------- 解析 ----------
// FRED CSV：observation_date,SERIES；缺值写成 "."
export function parseFredCsv(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/).slice(1)) {
    const [d, v] = line.split(",");
    const n = Number(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v !== "." && Number.isFinite(n)) out.push({ date: d, value: n });
  }
  return out;
}
const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
// multpl 表格：<td>Oct 16, 2026</td><td>&#x2002; 40.54 </td>（最新在前；当月可能有月中一行）
export function parseMultplTable(html) {
  const out = [];
  const re = /<td>\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s*<\/td>\s*<td>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const n = Number(m[4].replace(/&#x?[0-9a-f]+;|&[a-z]+;|[^0-9.\-]/gi, ""));
    if (MONTHS[m[1]] && Number.isFinite(n) && n > 0) out.push({ date: `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, "0")}`, value: n });
  }
  return out;
}
// 按月归并：每月取最后一个观测值 → [{ date: "YYYY-MM", value }]，按时间升序
export function monthly(points) {
  const map = new Map();
  for (const p of [...points].sort((a, b) => (a.date < b.date ? -1 : 1))) map.set(p.date.slice(0, 7), p.value);
  return [...map.entries()].map(([date, value]) => ({ date, value }));
}
// 当前值在自身历史里的百分位（≤ 当前值的占比，0–100）
export function percentile(values, current) {
  const v = values.filter(Number.isFinite);
  if (!v.length || !Number.isFinite(current)) return NaN;
  return v.filter((x) => x <= current).length / v.length * 100;
}
// 两个月度序列按月对齐后逐月运算
export function combine(a, b, fn) {
  const mb = new Map(b.map((p) => [p.date, p.value]));
  const out = [];
  for (const p of a) { const y = mb.get(p.date); if (y === undefined) continue; const v = fn(p.value, y); if (Number.isFinite(v)) out.push({ date: p.date, value: v }); }
  return out;
}
// 季度序列向后填充到每个月（市值 / GDP 是季度数据，和月度指标对齐用）
function quarterlyRatio(eq, gdp) {
  const g = new Map(gdp.map((p) => [p.date, p.value]));
  return eq.filter((p) => g.has(p.date)).map((p) => ({ date: p.date, value: p.value / 1000 / g.get(p.date) * 100 })); // 百万美元 → 十亿；% of GDP
}

// ---------- 抓取 ----------
// 每个请求有超时、失败重试一次：一个源卡住不能拖住整个刷新（拉失败的序列保留旧数据）
// quick：可有可无的源（FRED），10 秒超时、不重试
async function fetchText(fetchImpl, url, { quick = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < (quick ? 1 : 2); attempt++) {
    try {
      const r = await fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0 (ValuePort macro)" }, signal: AbortSignal.timeout(quick ? 10000 : 20000) });
      if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
      return await r.text();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function eastmoneyAll(fetchImpl, params, dateKey, valueKey, filter) {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const q = new URLSearchParams({ reportName: params, columns: `${dateKey},${valueKey}`, sortColumns: dateKey, sortTypes: "1", pageSize: "500", pageNumber: String(page), ...(filter ? { filter } : {}) });
    const j = JSON.parse(await fetchText(fetchImpl, `${EM}?${q}`));
    const rows = (j && j.result && j.result.data) || [];
    for (const r of rows) { const n = Number(r[valueKey]); if (r[dateKey] && r[valueKey] !== null && Number.isFinite(n)) out.push({ date: String(r[dateKey]).slice(0, 10), value: n }); }
    if (!j.result || page >= j.result.pages) break;
  }
  return out;
}
// 拉全部原始序列 → { 序列名: 月度点[] }；任一源失败只影响它自己
export async function fetchMacro(fetchImpl = fetch) {
  const jobs = {
    // 10 年国债与实际利率用 multpl（FRED 的 CSV 在 Workers 运行时里偶发拿不到）；市值 / GDP 只有 FRED 有，拿不到就只缺这一项
    US_10Y: async () => monthly(parseMultplTable(await fetchText(fetchImpl, MULTPL("10-year-treasury-rate")))),
    US_REAL10Y: async () => monthly(parseMultplTable(await fetchText(fetchImpl, MULTPL("10-year-real-interest-rate")))),
    US_EQUITY: async () => monthly(parseFredCsv(await fetchText(fetchImpl, FRED("NCBEILQ027S"), { quick: true }))),
    US_GDP: async () => monthly(parseFredCsv(await fetchText(fetchImpl, FRED("GDP"), { quick: true }))),
    US_CAPE: async () => monthly(parseMultplTable(await fetchText(fetchImpl, MULTPL("shiller-pe")))),
    CN_10Y: async () => monthly(await eastmoneyAll(fetchImpl, "RPTA_WEB_TREASURYYIELD", "SOLAR_DATE", "EMM00166466", "(SOLAR_DATE>='2002-01-01')")),
    CN_PE: async () => monthly(await eastmoneyAll(fetchImpl, "RPT_VALUEMARKET", "TRADE_DATE", "PE_TTM_AVG", '(TRADE_MARKET_CODE="000300")')),
  };
  const out = {}, errors = {};
  const run = async (k) => { try { out[k] = await jobs[k](); } catch (e) { errors[k] = String(e && e.message || e).slice(0, 200); } };
  // FRED 对同时发起的多个新连接会限流（偶发卡住），它的 4 个序列一个个拉；其他源并行
  const fred = ["US_EQUITY", "US_GDP"];
  await Promise.all([
    (async () => { for (const k of fred) await run(k); })(),
    ...Object.keys(jobs).filter((k) => !fred.includes(k)).map(run),
  ]);
  return { series: out, errors };
}

// ---------- 存取 ----------
async function saveSeries(db, series) {
  const stmts = [];
  for (const [id, pts] of Object.entries(series)) {
    if (!pts || !pts.length) continue; // 拉失败的保留旧数据
    stmts.push(db.prepare("DELETE FROM macro_series WHERE series=?").bind(id));
    for (let i = 0; i < pts.length; i += 30) { // D1 单条语句最多 100 个绑定参数：30 行 × 3 = 90
      const chunk = pts.slice(i, i + 30);
      stmts.push(db.prepare(`INSERT INTO macro_series (series, date, value) VALUES ${chunk.map(() => "(?,?,?)").join(",")}`).bind(...chunk.flatMap((p) => [id, p.date, p.value])));
    }
  }
  stmts.push(db.prepare("INSERT INTO macro_meta (key, value) VALUES ('fetched_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(new Date().toISOString()));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}
async function loadSeries(db) {
  const { results } = await db.prepare("SELECT series, date, value FROM macro_series ORDER BY series, date").all();
  const out = {};
  for (const r of results || []) (out[r.series] = out[r.series] || []).push({ date: r.date, value: r.value });
  return out;
}
async function fetchedAt(db) {
  try { const r = await db.prepare("SELECT value FROM macro_meta WHERE key='fetched_at'").first(); return r ? r.value : null; } catch { return null; }
}
// 同一个 isolate 里并发的刷新合并成一次（首次访问时多个请求同时进来，不要每个都去拉一遍）
let inflight = null;
export function refreshMacro(env, fetchImpl = fetch) {
  if (inflight) return inflight;
  inflight = (async () => {
    const { series, errors } = await fetchMacro(fetchImpl);
    await saveSeries(env.DB, series);
    if (Object.keys(errors).length) console.error("macro fetch errors:", JSON.stringify(errors));
    return { saved: Object.keys(series).filter((k) => series[k] && series[k].length), errors };
  })().finally(() => { inflight = null; });
  return inflight;
}
// 每日 cron 里调用：超过 REFRESH_DAYS 天没刷新才真正去拉
export async function refreshIfStale(env, fetchImpl = fetch) {
  const at = await fetchedAt(env.DB);
  if (at && Date.now() - Date.parse(at) < REFRESH_DAYS * 86400000) return null;
  return refreshMacro(env, fetchImpl);
}

// ---------- 计算 ----------
const last = (s) => (s && s.length ? s[s.length - 1] : null);
// 一个指标：当前值、日期、自身历史里的百分位；cheapHigh = 数值越高越便宜（如风险溢价），「贵的程度」取反
function indicator(key, series, { unit = "", cheapHigh = false, digits = 1 } = {}) {
  const cur = last(series);
  if (!cur) return null;
  const pct = percentile(series.map((p) => p.value), cur.value);
  return { key, value: Math.round(cur.value * 10 ** digits) / 10 ** digits, unit, date: cur.date, since: series[0].date, pct: Math.round(pct), expensive: Math.round(cheapHigh ? 100 - pct : pct), cheapHigh };
}
const zoneOf = (p) => (p < 10 ? 0 : p < 30 ? 1 : p < 70 ? 2 : p < 90 ? 3 : 4);
function market(key, indicators) {
  const list = indicators.filter(Boolean);
  if (!list.length) return { key, pending: true };
  const level = Math.round(list.reduce((a, x) => a + x.expensive, 0) / list.length);
  return { key, level, zone: zoneOf(level), indicators: list };
}
const pairs = (s, from) => s.filter((p) => !from || p.date >= from).map((p) => [p.date, Math.round(p.value * 100) / 100]);

export function buildMacro(series, updatedAt) {
  const s = (k) => series[k] || [];
  const usBuffett = quarterlyRatio(s("US_EQUITY"), s("US_GDP"));
  const usEY = s("US_CAPE").map((p) => ({ date: p.date, value: 100 / p.value }));          // CAPE 盈利收益率 %
  const usERP = combine(usEY, s("US_REAL10Y"), (ey, r) => ey - r);                          // 盈利收益率 − 实际利率
  const cnEY = s("CN_PE").map((p) => ({ date: p.date, value: 100 / p.value }));
  const cnERP = combine(cnEY, s("CN_10Y"), (ey, y) => ey - y);                               // 股债性价比
  return {
    updatedAt,
    markets: [
      market("us", [
        indicator("buffett", usBuffett, { unit: "%", digits: 0 }),
        indicator("cape", s("US_CAPE"), { digits: 1 }),
        indicator("us_erp", usERP, { unit: "pp", cheapHigh: true, digits: 2 }),
      ]),
      market("hk", []), // 港股：恒指长历史估值尚未接入
      market("cn", [
        indicator("cn_pe", s("CN_PE"), { digits: 1 }),
        indicator("cn_erp", cnERP, { unit: "pp", cheapHigh: true, digits: 2 }),
      ]),
    ],
    // 引力：股票盈利收益率 vs 10 年国债（美股另有实际利率），月度长线
    gravity: {
      us: { ey: pairs(usEY, "1990-01"), y10: pairs(s("US_10Y"), "1990-01"), real: pairs(s("US_REAL10Y"), "1990-01") },
      cn: { ey: pairs(cnEY), y10: pairs(s("CN_10Y"), cnEY.length ? cnEY[0].date : "") },
    },
  };
}

export function registerMacro(app, { fetchImpl } = {}) {
  // 公开数据，不区分用户；库里没有就当场拉一次（之后由 cron 每周刷新）
  app.get("/api/macro", async (c) => {
    let at = await fetchedAt(c.env.DB);
    if (!at) {
      try { await refreshMacro(c.env, fetchImpl || fetch); at = await fetchedAt(c.env.DB); }
      catch (e) { return c.json({ error: "macro_unavailable", detail: String(e && e.message || e).slice(0, 200) }, 503); }
    } else if (Date.now() - Date.parse(at) > REFRESH_DAYS * 86400000) {
      try { c.executionCtx.waitUntil(refreshMacro(c.env, fetchImpl || fetch).catch(() => {})); } catch { /* 测试环境没有 executionCtx */ }
    }
    const series = await loadSeries(c.env.DB);
    c.header("Cache-Control", "public, max-age=600"); // 数据按周刷新，客户端缓存 10 分钟足够
    return c.json(buildMacro(series, at));
  });
}
