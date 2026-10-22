/**
 * field-meta.js — 估值参数的「估值提示(guide)」内容 + 「参考数据(fieldReference)」计算。
 * 纯模块，无 DOM。模型字段通过 meta:"<tag>" 关联到这里。
 */

// 各字段的提示文案与参考标签（ref 为空=仅提示无数据参考）
export const FIELD_META = {
  revenue: { guide: { zh: "公司总营收（非每股）。已用最近年报预填，可改成你的预期口径。", en: "Total company revenue (not per share). Prefilled from the latest annual report; adjust to your estimate." } },
  netIncome: { guide: { zh: "公司净利润总额（非每股）。已用最近年报预填。", en: "Total net income (not per share). Prefilled from the latest annual report." } },
  netDebt: { guide: { zh: "有息负债−现金。已用最近年报预填；负值=净现金。", en: "Interest-bearing debt minus cash. Prefilled; negative means net cash." } },
  dps: { guide: { zh: "每股股利。已按近一年（过去 12 个月除息）的每股股息合计预填，可改成你预期的每股分红。", en: "Dividend per share. Prefilled with dividends per share paid over the last 12 months (by ex-date); adjust to your expected payout." } },
  eps: { guide: { zh: "每股收益，已用 TTM 预填。", en: "Earnings per share, prefilled with TTM." } },
  bps: { guide: { zh: "每股净资产，已用最近年报预填。", en: "Book value per share, prefilled from the latest annual report." } },
  ebitda: { guide: { zh: "息税折旧摊销前利润。接口无此项，请手填（≈营业利润+折旧摊销）。", en: "EBITDA. Not provided by the API — enter manually (≈ operating income + D&A)." } },
  growthYears: { guide: { zh: "护城河能维持超额增长的年数，通常 5–10 年；优势越强可越长。", en: "Years the moat sustains excess growth — usually 5–10; longer for stronger advantages." } },
  forecastYears: { guide: { zh: "预测到第几年的盈利来套目标倍数，常 3–5 年。", en: "How many years out you project earnings before applying the target multiple — usually 3–5." } },
  fcf: { guide: { zh: "公司自由现金流总额（经营现金流−资本支出，非每股）。已用最近年报预填，可选近4季 TTM。", en: "Total free cash flow (operating CF − capex, not per share). Prefilled from the latest annual report; TTM also available." } },
  revGrowth: { ref: "revGrowth", guide: { zh: "自上而下：市场空间(TAM)×渗透率提升×份额变化；高增速随规模向行业/GDP 收敛，勿长期外推峰值。", en: "Top-down: TAM × penetration × share. High growth fades toward industry/GDP as scale grows — don't extrapolate peaks." } },
  fcfGrowth: { ref: "fcfGrowth", guide: { zh: "自由现金流增速；与营收增速、利润率改善、资本开支节奏有关，长期会向营收增速收敛。", en: "FCF growth — tied to revenue growth, margin expansion and capex cadence; converges toward revenue growth long-run." } },
  niGrowth: { ref: "niGrowth", guide: { zh: "由营收增速 + 利润率变化（经营杠杆）共同驱动；成熟后向营收增速靠拢。", en: "Driven by revenue growth plus margin change (operating leverage); converges to revenue growth at maturity." } },
  epsGrowth: { ref: "epsGrowth", guide: { zh: "用未来 3–5 年 EPS 复合增速；留意回购会抬高每股增速。", en: "Use forward 3–5y EPS CAGR; buybacks inflate per-share growth." } },
  divGrowth: { guide: { zh: "由盈利增速与分红率共同决定；成熟分红股通常低个位数。", en: "Set by earnings growth and payout ratio; mature payers are usually low single digits." } },
  ebitdaGrowth: { guide: { zh: "通常略低于营收增速，受利润率变化影响。", en: "Usually a bit below revenue growth, shaped by margin change." } },
  opMargin: { ref: "opMargin", guide: { zh: "成熟期可持续的经营利润率；看毛利率−费用率趋势与规模效应，别取单年峰值。", en: "Sustainable mature operating margin; read gross-minus-opex trend and scale effects, not a peak year." } },
  netMargin: { ref: "netMargin", guide: { zh: "长期可持续净利率中枢，剔除一次性项目与税率扰动，别用单年高点。", en: "Long-run sustainable net margin; strip one-offs and tax noise, avoid peak years." } },
  reinvest: { ref: "reinvest", guide: { zh: "支撑增长所需留存 ≈ 增速÷ROE（可持续增长）；参考 1−自由现金流/净利。", en: "Retention needed to fund growth ≈ growth ÷ ROE; reference is 1 − FCF/net income." } },
  taxRate: { guide: { zh: "永续期用法定/边际税率（美≈21%、中≈25%）；或参考近年有效税率。", en: "Use statutory/marginal rate for the terminal phase (US≈21%, CN≈25%), or recent effective rate." } },
  salesToCap: { guide: { zh: "每 1 元新增投资带来的营收 = 营收/投入资本；轻资产高、重资产低，参考历史与同业。", en: "Revenue per unit of new investment = revenue/invested capital; higher for asset-light, lower for asset-heavy." } },
  wacc: { guide: { zh: "加权资本成本 = 股权成本×权重 + 税后债务成本×权重；股权成本=无风险利率+β×股权风险溢价（美股约 8–10%）。", en: "WACC = cost of equity×weight + after-tax cost of debt×weight; cost of equity = risk-free + β×ERP (~8–10% for US equities)." } },
  costOfEquity: { guide: { zh: "无风险利率(10Y 国债)+ β×股权风险溢价(~4.5–5.5%)；稳定大盘股约 8–9%。", en: "Risk-free (10Y) + β×equity risk premium (~4.5–5.5%); ~8–9% for stable large caps." } },
  termGrowth: { guide: { zh: "≤ 长期名义 GDP/无风险利率(通常 2–3%)，且必须 < 折现率；代表进入永续稳定期。", en: "≤ long-run nominal GDP/risk-free (~2–3%) and must be < discount rate; the perpetual steady state." } },
  targetPE: { ref: "pe", guide: { zh: "参照历史与可比公司，统一盈利期间，并解释增长、风险、派息和再投资回报差异；不能直接把增速当作合理 PE。", en: "Compare history and peers on aligned earnings periods, explaining growth, risk, payout and reinvestment returns; growth alone does not determine fair P/E." } },
  targetPB: { ref: "pb", guide: { zh: "与 ROE 强相关（高 ROE 配高 PB）；周期股参考历史 PB 区间。", en: "Tightly linked to ROE (higher ROE warrants higher PB); use the historical PB band for cyclicals." } },
  targetPS: { ref: "ps", guide: { zh: "适合未盈利/低利润期；最终应能回推到合理净利率下的 PE，别脱离盈利能力。", en: "For pre-profit/low-margin firms; must still map back to a sane PE at a normal net margin." } },
  peg: { guide: { zh: "PEG = PE ÷ 预期 EPS 增速百分数。目标值需参考可比公司的风险与增长质量，1 或 1–2 不是通用合理标准；亏损、低增长和强周期企业不宜机械使用。", en: "PEG = P/E divided by expected EPS growth in percentage points. Compare peer risk and growth quality; neither 1 nor 1–2 is universally fair. Avoid mechanical use for losses, low growth or cyclical earnings." } },
  targetMultiple: { guide: { zh: "参考同业与历史；资本密集/高增长行业差异大。", en: "Reference peers and history; varies widely by capital intensity and growth." } },
};

const TX = {
  zh: { latest: "最新年报", avg5: "近5年报均", now: "当前", own5y: "自身5年均", indMed: "行业中位", qoy: "最新季同比", q: "最新季", ttm: "近4季 TTM", latestQ: "最新季报", fy: "最新财年" },
  en: { latest: "Latest FY", avg5: "5Y avg", now: "Now", own5y: "5y avg", indMed: "Industry median", qoy: "Latest Q YoY", q: "Latest Q", ttm: "TTM (4Q)", latestQ: "Latest Q", fy: "Latest FY" },
};

function ser(data, kind, field) {
  const acc = data && data.financials && data.financials[kind] && data.financials[kind].find((a) => a.field === field);
  return acc ? acc.values.map((v) => v.value) : [];
}
// 季报（单季）序列：最新在前
function serQ(data, kind, field) {
  const acc = data && data.financialsQ && data.financialsQ[kind] && data.financialsQ[kind].find((a) => a.field === field);
  return acc ? acc.values.map((v) => v.value) : [];
}
// 最新季单季同比：本季 vs 去年同季（s[0] vs s[4]）
function qYoY(s) {
  return (s.length >= 5 && Number.isFinite(s[0]) && Number.isFinite(s[4]) && s[4] !== 0) ? (s[0] - s[4]) / Math.abs(s[4]) * 100 : null;
}
// 给参考对象追加一个「季报口径」筹码（带 q:true，套用区间会忽略它）
function withQ(ref, label, value, unit) {
  if (!Number.isFinite(value)) return ref;
  const chip = { label, value, q: true };
  if (!ref) return { unit, chips: [chip] };
  ref.chips.push(chip); return ref;
}
// money 字段的最新财年值：营收/净利 → 最新年报；净负债 → 最新年报余额
export function moneyAnnualRef(metaTag, data, lang) {
  const t = TX[lang] || TX.zh;
  const v0 = (kind, field) => ser(data, kind, field)[0];
  let v = null;
  if (metaTag === "revenue") v = v0("IS", "OperatingRevenue");
  else if (metaTag === "netIncome") v = v0("IS", "NetProfit");
  else if (metaTag === "netDebt") v = v0("BS", "NetDebt");
  else if (metaTag === "fcf") v = v0("CF", "NetFreeCashFlow");
  return Number.isFinite(v) ? { label: t.fy, value: v } : null;
}
// money 字段的季报口径估值：营收/净利 → 近4季 TTM 求和；净负债 → 最新季报余额
export function moneyQuarterRef(metaTag, data, lang) {
  const t = TX[lang] || TX.zh;
  const sum4 = (kind, field) => { const s = serQ(data, kind, field).slice(0, 4).filter(Number.isFinite); return s.length === 4 ? s.reduce((a, b) => a + b, 0) : null; };
  if (metaTag === "revenue") { const v = sum4("IS", "OperatingRevenue"); return Number.isFinite(v) ? { label: t.ttm, value: v } : null; }
  if (metaTag === "netIncome") { const v = sum4("IS", "NetProfit"); return Number.isFinite(v) ? { label: t.ttm, value: v } : null; }
  if (metaTag === "fcf") { const v = sum4("CF", "NetFreeCashFlow"); return Number.isFinite(v) ? { label: t.ttm, value: v } : null; }
  if (metaTag === "netDebt") { const s = serQ(data, "BS", "NetDebt"); return Number.isFinite(s[0]) ? { label: t.latestQ, value: s[0] } : null; }
  return null;
}
function yoyLatest(s) {
  return (s.length >= 2 && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] !== 0) ? (s[0] - s[1]) / Math.abs(s[1]) * 100 : null;
}
function yoyAvg(s) {
  const ys = [];
  for (let i = 0; i < Math.min(5, s.length - 1); i++) {
    if (Number.isFinite(s[i]) && Number.isFinite(s[i + 1]) && s[i + 1] !== 0) ys.push((s[i] - s[i + 1]) / Math.abs(s[i + 1]) * 100);
  }
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
}
function avgN(s, n) {
  const a = s.slice(0, n).filter(Number.isFinite);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}
function pair(latest, avg, unit, t) {
  const chips = [];
  if (Number.isFinite(latest)) chips.push({ label: t.latest, value: latest });
  if (Number.isFinite(avg)) chips.push({ label: t.avg5, value: avg });
  return chips.length ? { unit, chips } : null;
}

// fieldReference(refTag, data, ctx, lang) → { unit:"%"|"x", chips:[{label,value}] } | null
export function fieldReference(refTag, data, ctx, lang) {
  const t = TX[lang] || TX.zh;
  switch (refTag) {
    case "revGrowth": { const s = ser(data, "IS", "OperatingRevenue"); return withQ(pair(yoyLatest(s), yoyAvg(s), "%", t), t.qoy, qYoY(serQ(data, "IS", "OperatingRevenue")), "%"); }
    case "fcfGrowth": { const s = ser(data, "CF", "NetFreeCashFlow"); return withQ(pair(yoyLatest(s), yoyAvg(s), "%", t), t.qoy, qYoY(serQ(data, "CF", "NetFreeCashFlow")), "%"); }
    case "niGrowth": { const s = ser(data, "IS", "NetProfit"); return withQ(pair(yoyLatest(s), yoyAvg(s), "%", t), t.qoy, qYoY(serQ(data, "IS", "NetProfit")), "%"); }
    case "epsGrowth": { const s = ser(data, "IS", "EPS"); return withQ(pair(yoyLatest(s), yoyAvg(s), "%", t), t.qoy, qYoY(serQ(data, "IS", "EPS")), "%"); }
    case "netMargin": { const s = ser(data, "IS", "NetProfitMargin"); return withQ(pair(s[0], avgN(s, 5), "%", t), t.q, serQ(data, "IS", "NetProfitMargin")[0], "%"); }
    case "opMargin": {
      const oi = ser(data, "IS", "OperatingIncome"), or = ser(data, "IS", "OperatingRevenue");
      const m = oi.map((v, i) => (Number.isFinite(v) && or[i]) ? v / or[i] * 100 : NaN);
      const qoi = serQ(data, "IS", "OperatingIncome"), qor = serQ(data, "IS", "OperatingRevenue");
      const qm = (Number.isFinite(qoi[0]) && qor[0]) ? qoi[0] / qor[0] * 100 : NaN;
      return withQ(pair(m[0], avgN(m, 5), "%", t), t.q, qm, "%");
    }
    case "reinvest": {
      const fcf = ser(data, "CF", "NetFreeCashFlow"), ni = ser(data, "IS", "NetProfit");
      const r = ni.map((v, i) => (Number.isFinite(fcf[i]) && v > 0) ? (1 - fcf[i] / v) * 100 : NaN);
      return pair(Number.isFinite(r[0]) ? r[0] : NaN, avgN(r, 5), "%", t);
    }
    case "pe": case "pb": case "ps": {
      const vr = data && data.valuationRefs && data.valuationRefs[refTag];
      if (!vr) return null;
      const chips = [];
      if (Number.isFinite(vr.current)) chips.push({ label: t.now, value: vr.current });
      if (Number.isFinite(vr.own5y)) chips.push({ label: t.own5y, value: vr.own5y });
      if (Number.isFinite(vr.industryMedian)) chips.push({ label: t.indMed, value: vr.industryMedian });
      return chips.length ? { unit: "x", chips } : null;
    }
    default: return null;
  }
}

// AI 助手的「倍数对比」组件：当前 vs 自身 5 年均值 vs 行业中位（来自 /api/financials 的 valuationRefs）。
// 只取正的有限值；当前值缺失或可比项不足两个时返回 null（组件不显示）。pct = 相对最大值的长度，画横条用
export function multipleCompare(data, multiple, lang) {
  const t = TX[lang] || TX.zh;
  const vr = data && data.valuationRefs && data.valuationRefs[multiple];
  if (!vr) return null;
  const ok = (v) => Number.isFinite(v) && v > 0;
  if (!ok(vr.current)) return null;
  const items = [["current", t.now, vr.current], ["own5y", t.own5y, vr.own5y], ["industryMedian", t.indMed, vr.industryMedian]]
    .filter(([, , v]) => ok(v)).map(([key, label, value]) => ({ key, label, value }));
  if (items.length < 2) return null;
  const max = Math.max(...items.map((x) => x.value));
  return { unit: "x", items: items.map((x) => ({ ...x, pct: x.value / max })) };
}
