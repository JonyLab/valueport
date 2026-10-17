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

/**
 * latestMetrics({ financials, financialsQ, valuationRefs, valuedAt, lang }) → string[]
 * 「AI 复核」用的最新实际数据，拿来对照估值卡里当初的假设：营收 / 净利润同比与三年复合增速、自由现金流同比、
 * 营业利润率与净利率（最新 vs 三年均值）、最新季度同比、当前 P/E / P/B / P/S 对比自身五年中位，以及最新年报是否晚于估值日期。
 */
export function latestMetrics({ financials, financialsQ, valuationRefs, valuedAt, lang = "zh" } = {}) {
  const zh = lang !== "en";
  const out = [];
  const pct = (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
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
    out.push(zh ? `${zhName}：最新 ${l.toFixed(1)}%` + (Number.isFinite(avg) ? `，前三年均值 ${avg.toFixed(1)}%` : "")
      : `${enName}: latest ${l.toFixed(1)}%` + (Number.isFinite(avg) ? `, prior 3-year average ${avg.toFixed(1)}%` : ""));
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
    out.push(zh ? `当前 ${name} ${r.current.toFixed(1)}` + (Number.isFinite(r.own5y) ? `，自身五年中位 ${r.own5y.toFixed(1)}` : "") + (Number.isFinite(r.industryMedian) ? `，行业中位 ${r.industryMedian.toFixed(1)}` : "")
      : `Current ${name} ${r.current.toFixed(1)}` + (Number.isFinite(r.own5y) ? `, own 5-year median ${r.own5y.toFixed(1)}` : "") + (Number.isFinite(r.industryMedian) ? `, industry median ${r.industryMedian.toFixed(1)}` : ""));
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
