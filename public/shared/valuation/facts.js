/**
 * valuation/facts.js — 从财报算出「已核实的事实」，交给 AI 当判断依据，避免它凭印象编（如把不分红的公司说成「分红稳定」）。
 * 纯函数，浏览器与 node 测试共用。
 * verifiedFacts({ financials, dividends, dps, lang }) → string[]
 *   financials：长桥年报 { IS:[{field, values:[{year, value}]}], BS, CF }（values 最新在前）
 *   dividends：{ years:[{year, perShare}], currency } | null（null 可能是不分红，也可能是没查到）
 *   dps：行情里的每股股利（拿不到为 NaN）
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
const span = (s) => `${s[0].year}–${s[s.length - 1].year}`;

export function verifiedFacts({ financials, dividends, dps, lang = "zh" } = {}) {
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
    const v = cv(vals);
    const stable = !losses.length && !drops.length && v < 0.35;
    const recent = NI.slice(-3), recentProfit = recent.length === 3 && recent.every((x) => x.value > 0);
    if (recentProfit) out.push(zh ? `最近三年（${recent[0].year}–${recent[2].year}）均盈利` : `Profitable in each of the last three years (${recent[0].year}–${recent[2].year})`);
    out.push(zh
      ? `净利润 ${span(NI)}：最低 ${money(Math.min(...vals))}、最高 ${money(Math.max(...vals))}` + (losses.length ? `；${losses.join("、")} 年亏损` : "") + (drops.length ? `；${drops.join("、")} 年较上年腰斩以上` : "") + `。判断：盈利${stable ? "较稳定" : "波动较大，不能说稳定"}`
      : `Net income ${span(NI)}: min ${money(Math.min(...vals))}, max ${money(Math.max(...vals))}` + (losses.length ? `; losses in ${losses.join(", ")}` : "") + (drops.length ? `; fell by over half in ${drops.join(", ")}` : "") + `. Verdict: earnings ${stable ? "fairly stable" : "volatile — not stable"}`);
  }

  if (FCF.length >= 3) {
    const vals = FCF.map((x) => x.value), neg = FCF.filter((x) => x.value < 0).map((x) => x.year);
    const v = cv(vals);
    const stable = !neg.length && v < 0.4;
    let ratio = "";
    const pairs = FCF.filter((f) => NI.some((x) => x.year === f.year));
    const sumF = pairs.reduce((a, f) => a + f.value, 0), sumN = pairs.reduce((a, f) => a + NI.find((x) => x.year === f.year).value, 0);
    if (pairs.length >= 3 && sumN > 0) ratio = zh ? `；累计自由现金流 / 净利润 = ${(sumF / sumN).toFixed(2)}` : `; cumulative FCF / net income = ${(sumF / sumN).toFixed(2)}`;
    out.push(zh
      ? `自由现金流 ${span(FCF)}：最低 ${money(Math.min(...vals))}、最高 ${money(Math.max(...vals))}` + (neg.length ? `；${neg.join("、")} 年为负` : "；各年均为正") + ratio + `。判断：现金流${stable ? "较稳定、可预测" : "不稳定，不能说「现金流稳定」"}`
      : `Free cash flow ${span(FCF)}: min ${money(Math.min(...vals))}, max ${money(Math.max(...vals))}` + (neg.length ? `; negative in ${neg.join(", ")}` : "; positive every year") + ratio + `. Verdict: cash flow ${stable ? "fairly stable and predictable" : "unstable — do not call it stable"}`);
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

  // 分红：历史记录与行情每股股利都没有 → 视为不分红（别说「分红稳定」）
  const years = dividends && Array.isArray(dividends.years) ? dividends.years.filter((y) => y.perShare > 0) : [];
  if (years.length) {
    let streak = 0, prev = null;
    for (let i = years.length - 1; i >= 0; i--) { if (prev === null || years[i].year === prev - 1) { streak++; prev = years[i].year; } else break; }
    const lastY = years[years.length - 1];
    out.push(zh ? `有现金分红记录：最近 ${lastY.year} 年每股 ${lastY.perShare}${dividends.currency ? " " + dividends.currency : ""}，连续派息 ${streak} 年`
      : `Pays cash dividends: ${lastY.perShare}${dividends.currency ? " " + dividends.currency : ""} per share in ${lastY.year}, ${streak} consecutive years`);
  } else if (Number.isFinite(dps) && dps > 0) {
    out.push(zh ? `有现金分红：最近每股股利约 ${dps}（没有完整历史，无法判断是否稳定）` : `Pays a dividend of ~${dps} per share (no full history, so stability is unknown)`);
  } else {
    out.push(zh ? "没有查到现金分红记录：视为不分红，不要说它「分红稳定」，也不要推荐股息折现（DDM）" : "No cash dividend record found: treat it as a non-payer; do not call its dividends stable or recommend DDM");
  }
  return out;
}
