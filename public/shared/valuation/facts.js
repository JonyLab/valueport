/**
 * valuation/facts.js — 从财报算出「已核实的事实」，交给 AI 当判断依据，避免它凭印象编（如把不分红的公司说成「分红稳定」）。
 * 纯函数，浏览器与 node 测试共用。
 * verifiedFacts({ financials, dividends, dps, price, eps, lang }) → string[]
 *   financials：长桥年报 { IS:[{field, values:[{year, value}]}], BS, CF }（values 最新在前）
 *   dividends：{ years:[{year, perShare}], currency } | null（null 可能是不分红，也可能是没查到）
 *   dps / price / eps：行情里的每股股利、现价、每股收益 TTM（同一报价币种，用来算股息率与分红率；拿不到为 NaN）
 */

function series(financials, kind, field) {
  const a = financials && financials[kind] && financials[kind].find((x) => x.field === field);
  if (!a || !Array.isArray(a.values)) return [];
  return a.values.filter((v) => Number.isFinite(v.value) && Number.isFinite(v.year)).map((v) => ({ year: v.year, value: v.value })).reverse(); // 年份升序
}
function money(n) {
  const s = n < 0 ? "-" : "", a = Math.abs(n);
  if (a >= 1e12) return s + (a / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return s + (a / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + "M";
  return s + a.toFixed(0);
}
// 变异系数：标准差 / |均值|，衡量波动（均值≈0 时无意义，返回 Infinity）
function cv(vals) {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (Math.abs(m) < 1e-9) return Infinity;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
  return sd / Math.abs(m);
}
// 围绕趋势判断稳定性（调用方已排除亏损 / 腰斩 / 负值这些硬伤）：
// 整段变异系数会把逐年增长的公司（如微软）误判成「波动大」，所以先看同比：七成以上年份同比不差于 -10% 视为稳步向上；
// 否则退回看去趋势后的波动（对数线性拟合的残差，约等于偏离趋势的百分比）。
// growing：至少 5 年数据、年复合增速 ≥5% 且稳步向上，才说「稳定增长」。
function trendStability(vals, threshold) {
  if (cv(vals) < threshold) return { stable: true, growing: trendGrowing(vals) };
  if (trendGrowing(vals)) return { stable: true, growing: true };
  return { stable: detrendedCv(vals) < threshold, growing: false };
}
function mostlyUp(vals) {
  const yoy = vals.slice(1).map((v, i) => (vals[i] > 0 ? v / vals[i] - 1 : NaN)).filter(Number.isFinite);
  return yoy.length > 0 && yoy.filter((g) => g >= -0.1).length / yoy.length >= 0.7;
}
function trendGrowing(vals) {
  const n = vals.length - 1, first = vals[0], last = vals[n];
  if (vals.length < 5 || !(first > 0) || !(last > 0)) return false;
  return Math.pow(last / first, 1 / n) - 1 >= 0.05 && mostlyUp(vals);
}
function detrendedCv(vals) {
  if (!vals.every((v) => v > 0)) return Infinity;
  const y = vals.map(Math.log), n = y.length, mx = (n - 1) / 2, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  y.forEach((v, i) => { sxy += (i - mx) * (v - my); sxx += (i - mx) ** 2; });
  const b = sxx ? sxy / sxx : 0;
  return Math.sqrt(y.reduce((a, v, i) => a + (v - (my + b * (i - mx))) ** 2, 0) / n);
}
const span = (s) => `${s[0].year}–${s[s.length - 1].year}`;

export function verifiedFacts({ financials, dividends, dps, price, eps, financial = false, lang = "zh" } = {}) {
  const zh = lang !== "en";
  const out = [];
  const REV = series(financials, "IS", "OperatingRevenue");
  const NI = series(financials, "IS", "NetProfit");
  const FCF = series(financials, "CF", "NetFreeCashFlow");
  const CAP = series(financials, "CF", "CapEx");
  const ND = series(financials, "BS", "NetDebt");

  if (REV.length >= 3) {
    const first = REV[0], last = REV[REV.length - 1], n = last.year - first.year;
    const cagr = first.value > 0 && last.value > 0 && n > 0 ? (Math.pow(last.value / first.value, 1 / n) - 1) * 100 : NaN;
    const down = REV.slice(1).filter((x, i) => x.value < REV[i].value).map((x) => x.year);
    out.push(zh
      ? `营收 ${span(REV)}：${money(first.value)} → ${money(last.value)}` + (Number.isFinite(cagr) ? `，年复合增速约 ${cagr.toFixed(1)}%` : "") + (down.length ? `；${down.join("、")} 年营收同比下滑` : "；期间营收逐年增长")
      : `Revenue ${span(REV)}: ${money(first.value)} → ${money(last.value)}` + (Number.isFinite(cagr) ? `, CAGR ~${cagr.toFixed(1)}%` : "") + (down.length ? `; declined YoY in ${down.join(", ")}` : "; grew every year"));
  }

  if (NI.length >= 3) {
    const vals = NI.map((x) => x.value), losses = NI.filter((x) => x.value < 0).map((x) => x.year);
    const drops = NI.slice(1).filter((x, i) => NI[i].value > 0 && x.value < NI[i].value * 0.5).map((x) => x.year);
    const t = !losses.length && !drops.length ? trendStability(vals, 0.35) : { stable: false, growing: false };
    const stable = t.stable;
    const recent = NI.slice(-3), recentProfit = recent.length === 3 && recent.every((x) => x.value > 0);
    if (recentProfit) out.push(zh ? `最近三年（${recent[0].year}–${recent[2].year}）均盈利` : `Profitable in each of the last three years (${recent[0].year}–${recent[2].year})`);
    out.push(zh
      ? `净利润 ${span(NI)}：最低 ${money(Math.min(...vals))}、最高 ${money(Math.max(...vals))}` + (losses.length ? `；${losses.join("、")} 年亏损` : "") + (drops.length ? `；${drops.join("、")} 年较上年腰斩以上` : "") + `。判断：盈利${t.growing ? "稳定增长" : stable ? "较稳定" : "波动较大，不能说稳定"}`
      : `Net income ${span(NI)}: min ${money(Math.min(...vals))}, max ${money(Math.max(...vals))}` + (losses.length ? `; losses in ${losses.join(", ")}` : "") + (drops.length ? `; fell by over half in ${drops.join(", ")}` : "") + `. Verdict: earnings ${t.growing ? "growing steadily" : stable ? "fairly stable" : "volatile — not stable"}`);
  }

  // 银行、保险、券商的经营现金流里混着存款、保费和投资往来，自由现金流不能说明经营质量，只提示不作判断
  if (financial && FCF.length >= 3) out.push(zh ? "这是金融企业：自由现金流受存款、保费与投资往来影响，不能用来判断经营质量或现金流稳定性" : "Financial company: free cash flow is driven by deposits, premiums and investment flows, so it says little about operating quality or cash-flow stability");
  else if (FCF.length >= 3) {
    const vals = FCF.map((x) => x.value), neg = FCF.filter((x) => x.value < 0).map((x) => x.year);
    const t = !neg.length ? trendStability(vals, 0.4) : { stable: false, growing: false };
    const stable = t.stable;
    let ratio = "";
    const pairs = FCF.filter((f) => NI.some((x) => x.year === f.year));
    const sumF = pairs.reduce((a, f) => a + f.value, 0), sumN = pairs.reduce((a, f) => a + NI.find((x) => x.year === f.year).value, 0);
    if (pairs.length >= 3 && sumN > 0) ratio = zh ? `；累计自由现金流 / 净利润 = ${(sumF / sumN).toFixed(2)}` : `; cumulative FCF / net income = ${(sumF / sumN).toFixed(2)}`;
    out.push(zh
      ? `自由现金流 ${span(FCF)}：最低 ${money(Math.min(...vals))}、最高 ${money(Math.max(...vals))}` + (neg.length ? `；${neg.join("、")} 年为负` : "；各年均为正") + ratio + `。判断：现金流${t.growing ? "稳定增长、可预测" : stable ? "较稳定、可预测" : "不稳定，不能说「现金流稳定」"}`
      : `Free cash flow ${span(FCF)}: min ${money(Math.min(...vals))}, max ${money(Math.max(...vals))}` + (neg.length ? `; negative in ${neg.join(", ")}` : "; positive every year") + ratio + `. Verdict: cash flow ${t.growing ? "growing steadily and predictable" : stable ? "fairly stable and predictable" : "unstable — do not call it stable"}`);
  }

  if (CAP.length >= 4) {
    const abs = CAP.map((x) => Math.abs(x.value)), last = abs[abs.length - 1], prev = abs.slice(-4, -1), avg = prev.reduce((a, b) => a + b, 0) / prev.length;
    if (avg > 0 && last > avg * 1.5) out.push(zh
      ? `资本开支明显上升：${CAP[CAP.length - 1].year} 年 ${money(last)}，约为前三年均值的 ${(last / avg).toFixed(1)} 倍（可能在扩产或进入新业务）`
      : `Capex rising sharply: ${money(last)} in ${CAP[CAP.length - 1].year}, ~${(last / avg).toFixed(1)}× the prior 3-year average (expansion or a new business)`);
  }

  if (ND.length) {
    const last = ND[ND.length - 1];
    out.push(zh ? (last.value < 0 ? `${last.year} 年末净现金 ${money(-last.value)}（现金多于有息负债）` : `${last.year} 年末净负债 ${money(last.value)}`)
      : (last.value < 0 ? `Net cash of ${money(-last.value)} at end of ${last.year}` : `Net debt of ${money(last.value)} at end of ${last.year}`));
  }

  // 分红：是否派息、派多少（分红率 / 股息率）、是否主要靠回购。分红率低的公司不适合用股息折现做主方法
  const years = dividends && Array.isArray(dividends.years) ? dividends.years.filter((y) => y.perShare > 0) : [];
  const cur = dividends && dividends.currency ? " " + dividends.currency : "";
  // 当年还没派完的不算「最近一年」：取最后一个完整年度
  const thisYear = new Date().getUTCFullYear();
  const full = years.filter((y) => y.year < thisYear);
  const lastFull = full.length ? full[full.length - 1] : years[years.length - 1];
  // 分红率：优先用行情里同币种的每股股利 / EPS；没有时只在美元派息时用年报 EPS（港股常见年报人民币、派息港币，直接相除会错）
  let payout = NaN, yieldPct = NaN;
  if (Number.isFinite(dps) && dps > 0 && Number.isFinite(eps) && eps > 0) payout = dps / eps * 100;
  else if (lastFull && dividends && dividends.currency === "USD") {
    const e = series(financials, "IS", "EPS").find((x) => x.year === lastFull.year);
    if (e && e.value > 0) payout = lastFull.perShare / e.value * 100;
  }
  if (Number.isFinite(dps) && dps > 0 && Number.isFinite(price) && price > 0) yieldPct = dps / price * 100;
  // 回购：流通股数 ≈ 净利润 / EPS（同一份年报，币种一致）
  const EPS = series(financials, "IS", "EPS");
  const SH = NI.map((x) => { const e = EPS.find((y) => y.year === x.year); return e && e.value > 0 && x.value > 0 ? { year: x.year, value: x.value / e.value } : null; }).filter(Boolean);
  if (SH.length >= 4) {
    const a = SH[Math.max(0, SH.length - 6)], b = SH[SH.length - 1], d = (b.value / a.value - 1) * 100;
    if (Math.abs(d) >= 3) out.push(zh ? `流通股数 ${a.year}–${b.year} ${d < 0 ? "减少" : "增加"} ${Math.abs(d).toFixed(0)}%（${d < 0 ? "持续回购" : "有增发稀释"}）` : `Share count ${d < 0 ? "fell" : "rose"} ${Math.abs(d).toFixed(0)}% over ${a.year}–${b.year} (${d < 0 ? "buybacks" : "dilution"})`);
  }
  if (years.length || (Number.isFinite(dps) && dps > 0)) {
    let streak = 0, prev = null;
    for (let i = full.length - 1; i >= 0; i--) { if (prev === null || full[i].year === prev - 1) { streak++; prev = full[i].year; } else break; }
    const parts = [];
    if (lastFull) parts.push(zh ? `最近完整年度 ${lastFull.year} 每股 ${lastFull.perShare}${cur}` : `${lastFull.perShare}${cur} per share in ${lastFull.year}`);
    else if (Number.isFinite(dps)) parts.push(zh ? `每股股利约 ${dps}（没有完整历史）` : `~${dps} per share (no full history)`);
    if (streak) parts.push(zh ? `连续派息 ${streak} 年` : `${streak} consecutive years`);
    if (Number.isFinite(yieldPct)) parts.push(zh ? `股息率约 ${yieldPct.toFixed(1)}%` : `yield ~${yieldPct.toFixed(1)}%`);
    if (Number.isFinite(payout)) parts.push(zh ? `分红率（股息 / 每股收益）约 ${payout.toFixed(0)}%` : `payout ratio ~${payout.toFixed(0)}%`);
    const low = (Number.isFinite(payout) && payout < 30) || (Number.isFinite(yieldPct) && yieldPct < 1.5);
    const core = Number.isFinite(payout) && payout >= 40 && streak >= 5 && !(Number.isFinite(yieldPct) && yieldPct < 2);
    const verdict = low
      ? (zh ? "判断：分红只占盈利的一小部分，股东回报主要靠回购或再投资，股息折现（DDM）不适合做主方法，最多作参考" : "Verdict: dividends are a small share of earnings — returns come mainly from buybacks or reinvestment, so DDM is not suitable as the primary method")
      : core ? (zh ? "判断：分红是股东回报的主要方式且长期稳定，股息折现（DDM）可以作为主方法" : "Verdict: dividends are the main, long-running form of shareholder return, so DDM can be a primary method")
      : (zh ? "判断：有分红，但分红率 / 股息率不足以说明分红是主要回报方式，DDM 只宜作交叉验证" : "Verdict: pays dividends, but not enough to make DDM the primary method; use it only as a cross-check");
    out.push((zh ? "有现金分红：" : "Pays cash dividends: ") + parts.join(zh ? "，" : ", ") + (zh ? "。" : ". ") + verdict);
  } else {
    out.push(zh ? "没有查到现金分红记录：视为不分红，不要说它「分红稳定」，也不要推荐股息折现（DDM）" : "No cash dividend record found: treat it as a non-payer; do not call its dividends stable or recommend DDM");
  }
  return out;
}

/**
 * latestMetrics({ financials, financialsQ, valuationRefs, valuedAt, lang }) → string[]
 * 「AI 复核」用的最新实际数据，拿来对照估值卡里当初的假设：营收 / 净利润同比与三年复合增速、自由现金流同比、
 * 营业利润率与净利率（最新 vs 三年均值）、最新季度同比、当前 P/E / P/B / P/S 对比自身五年中位，以及最新年报是否晚于估值日期。
 */
export function latestMetrics({ financials, financialsQ, valuationRefs, valuedAt, lang = "zh" } = {}) {
  const zh = lang !== "en";
  const out = [];
  const pct = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const yoy = (s) => (s.length >= 2 && s[s.length - 2].value > 0 ? (s[s.length - 1].value / s[s.length - 2].value - 1) * 100 : NaN);
  const cagr3 = (s) => { if (s.length < 4) return NaN; const a = s[s.length - 4].value, b = s[s.length - 1].value; return a > 0 && b > 0 ? (Math.pow(b / a, 1 / 3) - 1) * 100 : NaN; };
  const REV = series(financials, "IS", "OperatingRevenue"), NI = series(financials, "IS", "NetProfit");
  const FCF = series(financials, "CF", "NetFreeCashFlow"), OI = series(financials, "IS", "OperatingIncome");
  const last = REV.length ? REV[REV.length - 1].year : NI.length ? NI[NI.length - 1].year : null;
  if (last) {
    const vy = /^\d{4}/.test(valuedAt || "") ? Number(valuedAt.slice(0, 4)) : NaN;
    out.push(zh ? `最新年报：FY${last}` + (Number.isFinite(vy) ? (last >= vy ? `（估值做于 ${valuedAt.slice(0, 10)}，之后可能已有新年报）` : `（估值做于 ${valuedAt.slice(0, 10)}）`) : "")
      : `Latest annual report: FY${last}` + (Number.isFinite(vy) ? ` (valuation made on ${valuedAt.slice(0, 10)})` : ""));
  }
  const growthLine = (s, zhName, enName) => {
    const y = yoy(s), c = cagr3(s);
    if (!Number.isFinite(y) && !Number.isFinite(c)) return;
    const parts = [];
    if (Number.isFinite(y)) parts.push(zh ? `最新年同比 ${pct(y)}` : `latest YoY ${pct(y)}`);
    if (Number.isFinite(c)) parts.push(zh ? `近三年复合 ${pct(c)}` : `3-year CAGR ${pct(c)}`);
    out.push((zh ? zhName + "增速：" : enName + " growth: ") + parts.join(zh ? "，" : ", "));
  };
  growthLine(REV, "营收", "Revenue");
  growthLine(NI, "净利润", "Net income");
  growthLine(FCF, "自由现金流", "FCF");
  const margin = (num, den) => num.map((x) => { const d = den.find((y) => y.year === x.year); return d && d.value > 0 ? { year: x.year, value: x.value / d.value * 100 } : null; }).filter(Boolean);
  const mLine = (s, zhName, enName) => {
    if (!s.length) return;
    const l = s[s.length - 1].value, prev = s.slice(-4, -1), avg = prev.length ? prev.reduce((a, b) => a + b.value, 0) / prev.length : NaN;
    out.push(zh ? `${zhName}：最新 ${l.toFixed(2)}%` + (Number.isFinite(avg) ? `，前三年均值 ${avg.toFixed(2)}%` : "")
      : `${enName}: latest ${l.toFixed(2)}%` + (Number.isFinite(avg) ? `, prior 3-year average ${avg.toFixed(2)}%` : ""));
  };
  mLine(margin(OI, REV), "营业利润率", "Operating margin");
  mLine(margin(NI, REV), "净利率", "Net margin");
  // 最新季度：用报表自带的同比
  const q = (field) => { const a = financialsQ && financialsQ.IS && financialsQ.IS.find((x) => x.field === field); return a && a.values && a.values[0]; };
  const qr = q("OperatingRevenue"), qn = q("NetProfit");
  const qy = (v) => (v && Number.isFinite(Number(v.yoy)) ? Number(v.yoy) : NaN);
  if (qr && (Number.isFinite(qy(qr)) || Number.isFinite(qy(qn)))) {
    const parts = [];
    if (Number.isFinite(qy(qr))) parts.push(zh ? `营收同比 ${pct(qy(qr))}` : `revenue YoY ${pct(qy(qr))}`);
    if (Number.isFinite(qy(qn))) parts.push(zh ? `净利润同比 ${pct(qy(qn))}` : `net income YoY ${pct(qy(qn))}`);
    out.push((zh ? `最新季度 ${qr.period || ""}：` : `Latest quarter ${qr.period || ""}: `) + parts.join(zh ? "，" : ", "));
  }
  // 当前估值倍数 vs 自身五年中位
  for (const [k, name] of [["pe", "P/E"], ["pb", "P/B"], ["ps", "P/S"]]) {
    const r = valuationRefs && valuationRefs[k];
    if (!r || !Number.isFinite(r.current)) continue;
    out.push(zh ? `当前 ${name} ${r.current.toFixed(2)}` + (Number.isFinite(r.own5y) ? `，自身五年中位 ${r.own5y.toFixed(2)}` : "") + (Number.isFinite(r.industryMedian) ? `，行业中位 ${r.industryMedian.toFixed(2)}` : "")
      : `Current ${name} ${r.current.toFixed(2)}` + (Number.isFinite(r.own5y) ? `, own 5-year median ${r.own5y.toFixed(2)}` : "") + (Number.isFinite(r.industryMedian) ? `, industry median ${r.industryMedian.toFixed(2)}` : ""));
  }
  return out;
}

/**
 * assumptionChecks({ fields, financials, financialsQ, valuationRefs, dividends, lang }) → string[]
 * 把能对照的假设逐项和最新实际值比好（落在保守以下 / 两档之间 / 乐观以上），交给 AI 当结论依据——
 * 开源模型做数字比较常出错（如把 18.1 说成「低于 15 / 25」），比较由这里算，AI 只负责解释。
 * fields：[{ k, label, meta, col, unit, value }]，value 为数字或 { c, o }。
 */
export function assumptionChecks({ fields, financials, financialsQ, valuationRefs, dividends, lang = "zh" } = {}) {
  const zh = lang !== "en";
  const out = [];
  const REV = series(financials, "IS", "OperatingRevenue"), NI = series(financials, "IS", "NetProfit");
  const FCF = series(financials, "CF", "NetFreeCashFlow"), OI = series(financials, "IS", "OperatingIncome");
  const cagr = (s, n) => { if (s.length < n + 1) return NaN; const a = s[s.length - 1 - n].value, b = s[s.length - 1].value; return a > 0 && b > 0 ? (Math.pow(b / a, 1 / n) - 1) * 100 : NaN; };
  const marginLast = (num) => { const n = num[num.length - 1]; const d = n && REV.find((x) => x.year === n.year); return n && d && d.value > 0 ? n.value / d.value * 100 : NaN; };
  const lastOf = (s) => (s.length ? s[s.length - 1].value : NaN);
  const divs = dividends && Array.isArray(dividends.years) ? dividends.years.filter((y) => y.perShare > 0).map((y) => ({ year: y.year, value: y.perShare })) : [];
  const ref = (k) => valuationRefs && valuationRefs[k];
  const f1 = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
  const where = (actual, c, o) => {
    const lo = Math.min(c, o), hi = Math.max(c, o);
    return actual < lo ? (zh ? "低于两档" : "below both cases") : actual > hi ? (zh ? "高于两档" : "above both cases") : (zh ? "落在两档之间" : "between the two cases");
  };
  for (const f of fields || []) {
    const v = f.value, name = `${f.k}（${f.label || f.k}）`;
    const dual = f.col === "dual" && v && Number.isFinite(v.c) && Number.isFinite(v.o);
    const said = dual ? (zh ? `当初 保守 ${v.c} / 乐观 ${v.o}` : `was ${v.c} / ${v.o}`) : "";
    let actual = NaN, what = "", extra = "";
    switch (f.meta) {
      case "revGrowth": actual = cagr(REV, 3); what = zh ? "营收近三年复合增速" : "revenue 3-year CAGR"; break;
      case "niGrowth": case "epsGrowth": actual = cagr(NI, 3); what = zh ? "净利润近三年复合增速" : "net income 3-year CAGR"; break;
      case "fcfGrowth": actual = cagr(FCF, 3); what = zh ? "自由现金流近三年复合增速" : "FCF 3-year CAGR"; break;
      case "opMargin": actual = marginLast(OI); what = zh ? "最新营业利润率" : "latest operating margin"; break;
      case "netMargin": actual = marginLast(NI); what = zh ? "最新净利率" : "latest net margin"; break;
      case "divGrowth": actual = cagr(divs, 3); what = zh ? "每股股息近三年复合增速" : "DPS 3-year CAGR"; break;
      case "targetPE": case "targetPB": case "targetPS": {
        const r = ref({ targetPE: "pe", targetPB: "pb", targetPS: "ps" }[f.meta]);
        if (r && Number.isFinite(r.current)) { actual = r.current; what = zh ? "当前倍数" : "current multiple"; if (Number.isFinite(r.own5y)) extra = zh ? `；自身五年中位 ${f1(r.own5y)}（${where(r.own5y, v && v.c, v && v.o)}）` : `; own 5-year median ${f1(r.own5y)} (${where(r.own5y, v && v.c, v && v.o)})`; }
        break;
      }
      case "revenue": case "netIncome": case "fcf": {
        const s = { revenue: REV, netIncome: NI, fcf: FCF }[f.meta], last = lastOf(s);
        if (Number.isFinite(last) && Number.isFinite(v) && v !== 0) {
          const d = (last / v - 1) * 100;
          out.push(zh ? `${name}：当初填 ${money(v)}，最新年报 ${money(last)}（${d >= 0 ? "高" : "低"} ${Math.abs(d).toFixed(1)}%）` : `${name}: was ${money(v)}, latest annual ${money(last)} (${d >= 0 ? "+" : ""}${d.toFixed(1)}%)`);
        }
        continue;
      }
      default: continue;
    }
    if (!dual || !Number.isFinite(actual)) continue;
    out.push(zh ? `${name}：${said}；${what} ${f1(actual)}${f.unit === "%" ? "%" : ""} → ${where(actual, v.c, v.o)}${extra}`
      : `${name}: ${said}; ${what} ${f1(actual)}${f.unit === "%" ? "%" : ""} → ${where(actual, v.c, v.o)}${extra}`);
  }
  return out;
}

/**
 * marketViews({ research, financials, price, market, lang }) → string[]
 * 市场投研：分析师评级分布、目标价区间（与目标价同币种的昨收比）、一致预期 EPS（与年报 EPS 同为报告币种，算增速）。
 * research 来自 /api/research：{ rating:{buy,over,hold,under,sell,total,targetHigh,targetLow,prevClose,industry}, forecastEps:{median,mean,low,high} }
 * market："us" 时价格与报表同为美元，才算远期市盈率。
 */
export function marketViews({ research, financials, price, market, lang = "zh" } = {}) {
  const zh = lang !== "en";
  const out = [];
  const r = research && research.rating, f = research && research.forecastEps;
  if (r && r.total > 0) {
    const bull = r.buy + r.over, bear = r.under + r.sell;
    let line = zh ? `分析师评级（${r.total} 家）：看多 ${bull}（买入 ${r.buy}、增持 ${r.over}），中性 ${r.hold}，看空 ${bear}（看多占 ${Math.round(bull / r.total * 100)}%）`
      : `Analyst ratings (${r.total}): ${bull} bullish (${r.buy} buy, ${r.over} overweight), ${r.hold} hold, ${bear} bearish (${Math.round(bull / r.total * 100)}% bullish)`;
    if (Number.isFinite(r.targetHigh) && Number.isFinite(r.targetLow) && r.targetHigh > 0) {
      const mid = (r.targetHigh + r.targetLow) / 2, ref = Number.isFinite(r.prevClose) && r.prevClose > 0 ? r.prevClose : price;
      const vs = ref > 0 ? (mid / ref - 1) * 100 : NaN;
      line += zh ? `；目标价 ${r.targetLow}–${r.targetHigh}，中值 ${mid.toFixed(2)}` + (Number.isFinite(vs) ? `（较现价 ${vs >= 0 ? "+" : ""}${vs.toFixed(1)}%）` : "")
        : `; target range ${r.targetLow}–${r.targetHigh}, midpoint ${mid.toFixed(2)}` + (Number.isFinite(vs) ? ` (${vs >= 0 ? "+" : ""}${vs.toFixed(1)}% vs price)` : "");
    }
    out.push(line);
  }
  if (f && Number.isFinite(f.median)) {
    const EPS = series(financials, "IS", "EPS"), last = EPS[EPS.length - 1];
    let line = zh ? `一致预期 EPS 中位 ${f.median}` + (Number.isFinite(f.low) && Number.isFinite(f.high) ? `（区间 ${f.low}–${f.high}）` : "")
      : `Consensus EPS median ${f.median}` + (Number.isFinite(f.low) && Number.isFinite(f.high) ? ` (range ${f.low}–${f.high})` : "");
    if (last && last.value > 0) {
      const g = (f.median / last.value - 1) * 100;
      line += zh ? `，较最新年报 EPS ${last.value}（FY${last.year}）${g >= 0 ? "增长" : "下降"} ${Math.abs(g).toFixed(1)}%` : `, ${g >= 0 ? "+" : ""}${g.toFixed(1)}% vs latest annual EPS ${last.value} (FY${last.year})`;
    }
    if (market === "us" && price > 0 && f.median > 0) line += zh ? `；远期市盈率约 ${(price / f.median).toFixed(1)}` : `; forward P/E ~${(price / f.median).toFixed(1)}`;
    out.push(line);
  }
  if (out.length) out.push(zh ? "（卖方观点普遍偏乐观，只作参考，不能替代自己的判断）" : "(Sell-side views tend to be optimistic — reference only)");
  return out;
}

/**
 * masterLenses({ financials, research, price, eps, bps, lang }) → string[]
 * 按投资大师公开的方法论算一遍（不代表大师本人对这只股的看法）：
 *   格雷厄姆：PE ≤ 15、PB ≤ 1.5、PE × PB ≤ 22.5；格雷厄姆数 √(22.5 × EPS × BPS)
 *   林奇：PEG = PE / 盈利增速（优先用一致预期 EPS 增速，否则净利润三年复合）；辅助比较，不据固定阈值判定贵贱
 *   巴菲特式：所有者收益率 ≈ 自由现金流 / 净利润 × 盈利收益率（EPS / 价格），近五年 ROE 是否持续 > 15%，有无净现金
 * price / eps / bps 来自行情（同一报价币种）；跨币种的量只用无单位的比值。
 */
export function masterLenses({ financials, research, price, eps, bps, lang = "zh" } = {}) {
  const zh = lang !== "en";
  const out = [];
  const pe = price > 0 && eps > 0 ? price / eps : NaN, pb = price > 0 && bps > 0 ? price / bps : NaN;
  if (Number.isFinite(pe) && Number.isFinite(pb)) {
    const gn = Math.sqrt(22.5 * eps * bps), ok = pe <= 15 && pb <= 1.5 && pe * pb <= 22.5;
    out.push(zh ? `按格雷厄姆的方法：PE ${pe.toFixed(1)}、PB ${pb.toFixed(1)}，PE×PB = ${(pe * pb).toFixed(0)}（标准 ≤ 22.5）；格雷厄姆数 ${gn.toFixed(2)}，${price / gn >= 2 ? `现价是它的 ${(price / gn).toFixed(1)} 倍` : `现价${price > gn ? "高于" : "低于"}它 ${(Math.abs(price / gn - 1) * 100).toFixed(0)}%`}。${ok ? "满足防御型投资者的标准" : "不满足（这套标准针对低估值的防御型股票，对高 ROE 的轻资产公司偏严）"}`
      : `By Graham's method: P/E ${pe.toFixed(1)}, P/B ${pb.toFixed(1)}, P/E×P/B = ${(pe * pb).toFixed(0)} (limit 22.5); Graham number ${gn.toFixed(2)} vs price ${price}. ${ok ? "Meets the defensive-investor criteria" : "Fails them (the criteria target cheap defensive stocks and are harsh on high-ROE, asset-light firms)"}`);
  }
  // 林奇：增速优先用一致预期（与年报 EPS 同币种），否则净利润三年复合
  const EPS = series(financials, "IS", "EPS"), NI = series(financials, "IS", "NetProfit");
  let g = NaN, gSrc = "";
  const f = research && research.forecastEps, lastEps = EPS[EPS.length - 1];
  if (f && Number.isFinite(f.median) && lastEps && lastEps.value > 0) { g = (f.median / lastEps.value - 1) * 100; gSrc = zh ? "一致预期 EPS 增速" : "consensus EPS growth"; }
  else if (NI.length >= 4 && NI[NI.length - 4].value > 0 && NI[NI.length - 1].value > 0) { g = (Math.pow(NI[NI.length - 1].value / NI[NI.length - 4].value, 1 / 3) - 1) * 100; gSrc = zh ? "净利润近三年复合增速" : "3-year net income CAGR"; }
  if (Number.isFinite(pe) && Number.isFinite(g)) {
    if (g > 0) {
      const peg = pe / g;
      out.push(zh ? `按林奇的方法：PEG = PE ${pe.toFixed(1)} ÷ ${gSrc} ${g.toFixed(1)}% = ${peg.toFixed(2)}（仅作增长校准参考，需比较风险、再投资和增长质量；不设统一合理阈值）`
        : `By Lynch's method: PEG = P/E ${pe.toFixed(1)} ÷ ${gSrc} ${g.toFixed(1)}% = ${peg.toFixed(2)} (growth-adjusted reference only; compare risk, reinvestment and growth quality, with no universal fair threshold)`);
    } else out.push(zh ? `按林奇的方法：${gSrc} 为 ${g.toFixed(1)}%，不增长，PEG 不适用` : `By Lynch's method: ${gSrc} is ${g.toFixed(1)}%, so PEG doesn't apply`);
  }
  // 巴菲特式：所有者收益率、ROE 持续性、净现金
  const FCF = series(financials, "CF", "NetFreeCashFlow"), ROE = series(financials, "IS", "ROEDf").length ? series(financials, "IS", "ROEDf") : series(financials, "IS", "ROE");
  const parts = [];
  const pairs = FCF.slice(-3).filter((x) => NI.some((y) => y.year === x.year));
  const sumF = pairs.reduce((a, x) => a + x.value, 0), sumN = pairs.reduce((a, x) => a + NI.find((y) => y.year === x.year).value, 0);
  if (Number.isFinite(pe) && pairs.length && sumN > 0) {
    const oy = sumF / sumN / pe * 100;
    parts.push(zh ? `所有者收益率约 ${oy.toFixed(1)}%（自由现金流 / 市值，近三年口径）` : `owner-earnings yield ~${oy.toFixed(1)}% (FCF / market cap, 3-year basis)`);
  }
  const r5 = ROE.slice(-5).map((x) => x.value);
  if (r5.length >= 3) {
    const min = Math.min(...r5), avg = r5.reduce((a, b) => a + b, 0) / r5.length;
    parts.push(zh ? `近 ${r5.length} 年 ROE 均值 ${avg.toFixed(0)}%、最低 ${min.toFixed(0)}%（${min > 15 ? "持续高于 15%" : "没能持续高于 15%"}）` : `ROE averaged ${avg.toFixed(0)}% over ${r5.length} years, min ${min.toFixed(0)}% (${min > 15 ? "consistently above 15%" : "not consistently above 15%"})`);
  }
  const ND = series(financials, "BS", "NetDebt"), nd = ND[ND.length - 1];
  if (nd) parts.push(zh ? (nd.value < 0 ? "账上净现金" : "有净负债") : (nd.value < 0 ? "net cash" : "net debt"));
  if (parts.length) out.push((zh ? "按巴菲特看重的：" : "By Buffett's yardsticks: ") + parts.join(zh ? "，" : ", "));
  if (out.length) out.push(zh ? "（以上是按大师公开的方法论计算，不代表他们本人对这只股票的看法）" : "(Computed from the masters' published methods; not their own views on this stock)");
  return out;
}

/**
 * businessFacts({ research, lang }) → string[]
 * 生意本身：经营范围 / 业务描述、按业务与地区的收入构成（含同比）、所属行业。给 AI 先看懂「怎么赚钱」再选估值方法。
 */
export function businessFacts({ research, lang = "zh" } = {}) {
  const zh = lang !== "en";
  const out = [];
  const p = research && research.profile, sg = research && research.segments, ind = research && research.rating && research.rating.industry;
  if (ind && ind.name) out.push(zh ? `所属行业：${ind.name}` : `Industry: ${ind.name}`);
  if (p && p.profile) { const t = p.profile.length > 260 ? p.profile.slice(0, 260) + "…" : p.profile; out.push((zh ? "业务描述：" : "Business: ") + t + (p.employees ? (zh ? `（员工约 ${p.employees} 人）` : ` (~${p.employees} employees)`) : "")); }
  const mix = (arr) => arr.slice(0, 6).map((x) => `${x.name} ${x.percent.toFixed(1)}%` + (Number.isFinite(x.yoy) && x.yoy !== 0 ? (zh ? `（同比 ${x.yoy >= 0 ? "+" : ""}${x.yoy.toFixed(1)}%）` : ` (${x.yoy >= 0 ? "+" : ""}${x.yoy.toFixed(1)}% YoY)`) : "")).join(zh ? "、" : ", ");
  if (sg && sg.business && sg.business.length) out.push((zh ? `收入构成（${sg.period}，按业务）：` : `Revenue mix (${sg.period}, by business): `) + mix(sg.business));
  if (sg && sg.regions && sg.regions.length) out.push((zh ? `收入构成（${sg.period}，按地区）：` : `Revenue mix (${sg.period}, by region): `) + mix(sg.regions));
  if (out.length && research.companySource) out.push(zh ? `以上公司资料来自同一公司的 H 股（${research.companySource}）` : `Company information above comes from the same company's H-share listing (${research.companySource})`);
  return out;
}

const FINANCIAL_RE = /银行|保险|证券|券商|信托|期货|bank|insur|brokerage|securities/i;
// 是否金融企业：看行业名与业务构成名称。拿不到资料时按非金融处理（保持原有判断）。
export function isFinancialCompany(research) {
  if (!research) return false;
  // 行业名直接判断；业务构成里金融类合计过半才算（只有一小块「证券投资」「期货」业务的制造企业不算）
  if (FINANCIAL_RE.test(research.rating?.industry?.name || "")) return true;
  const share = (research.segments?.business || []).filter((x) => FINANCIAL_RE.test(x.name || "")).reduce((sum, x) => sum + (Number(x.percent) || 0), 0);
  return share >= 50;
}
