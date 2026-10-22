// Shared review contract: scenario scope, comparable data and saved-review freshness.
export const REVIEW_VERSION = 2;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const text = (s, max = 240) => typeof s === 'string' ? s.slice(0, max) : '';
export const reviewMode = (value) => value?.scenarioMode === 'single' ? 'single' : 'range';
export function reviewNeedsUpdate(card) {
  const r = card?.review;
  return !!r && (r.version !== REVIEW_VERSION || r.scenarioMode !== reviewMode(card) || r.valuedAt !== (card.updatedAt || '') || (card.updatedAt && r.at && card.updatedAt > r.at));
}
export function scopeReviewFields(fields, mode) {
  return (fields || []).map((f) => ({ ...f, assumption: f.assumption === true || f.col === 'dual',
    ...(mode === 'single' && f.col === 'dual' ? { col: 'single', value: finite(f.value?.c) ? f.value.c : null } : {}) }));
}
export function reviewValue(f, lang = 'zh') {
  const one = (v) => {
    if (!finite(v)) return '—';
    if (f.money) {
      const [scale, suffix] = Math.abs(v) >= 1e12 ? [1e12, 'T'] : Math.abs(v) >= 1e9 ? [1e9, 'B'] : Math.abs(v) >= 1e6 ? [1e6, 'M'] : [1, ''];
      return (v / scale).toFixed(2) + suffix;
    }
    return v.toFixed(2) + (f.unit === '%' ? '%' : '');
  };
  return f.col === 'dual' ? `${lang === 'en' ? 'Conservative' : '保守'} ${one(f.value?.c)} / ${lang === 'en' ? 'Optimistic' : '乐观'} ${one(f.value?.o)}` : one(f.value);
}
function series(financials, kind, field) {
  return (financials?.[kind]?.find((a) => a.field === field)?.values || [])
    .filter((v) => finite(v.value) && Number.isInteger(v.year)).slice().sort((a, b) => a.year - b.year);
}
export function buildReviewEvidence({ fields, scenarioMode = 'range', financials, valuationRefs, dividends, financialsSource, lang = 'zh' } = {}) {
  const zh = lang !== 'en', t = (a, b) => zh ? a : b;
  const rev = series(financials, 'IS', 'OperatingRevenue'), ni = series(financials, 'IS', 'NetProfit'), fcf = series(financials, 'CF', 'NetFreeCashFlow'), oi = series(financials, 'IS', 'OperatingIncome');
  const source = ({ longbridge: t('长桥财报接口', 'Longbridge financial reports'), eastmoney: t('东方财富财报接口', 'Eastmoney financial reports') })[financialsSource] || t('财报接口（来源未注明）', 'Financial feed (provider unspecified)');
  return scopeReviewFields(fields, scenarioMode).map((f) => {
    let actual = null, period = '', kind = f.assumption ? 'forecast' : 'baseline', origin = source, extra = '';
    const grow = ({ revGrowth: rev, niGrowth: ni, epsGrowth: ni, fcfGrowth: fcf, divGrowth: (dividends?.years || []).filter((v) => finite(v.perShare) && Number.isInteger(v.year)).map((v) => ({ year: v.year, value: v.perShare })).sort((a, b) => a.year - b.year) })[f.meta];
    if (grow) {
      const end = grow.at(-1), start = end && grow.find((v) => v.year === end.year - 3);
      if (start?.value > 0 && end.value > 0) { actual = (Math.pow(end.value / start.value, 1 / 3) - 1) * 100; period = `FY${start.year}–FY${end.year} · ` + t('三年复合增速', '3-year CAGR'); }
      kind = 'forecast';
      if (f.meta === 'epsGrowth') extra = t('净利润增速代理，未计入股数变化。', 'Net-income growth proxy; share-count changes excluded.');
      if (f.meta === 'divGrowth') origin = t('股息历史接口', 'Dividend-history feed');
    } else if (['opMargin', 'netMargin'].includes(f.meta)) {
      const numerator = (f.meta === 'opMargin' ? oi : ni).at(-1), denominator = numerator && rev.find((v) => v.year === numerator.year);
      if (denominator?.value > 0) { actual = numerator.value / denominator.value * 100; period = `FY${numerator.year} · ` + t('全年利润率', 'annual margin'); }
      kind = 'forecast';
    } else if (['targetPE', 'targetPB', 'targetPS'].includes(f.meta)) {
      const r = valuationRefs?.[({ targetPE: 'pe', targetPB: 'pb', targetPS: 'ps' })[f.meta]];
      actual = finite(r?.current) ? r.current : null; kind = 'multiple'; period = t('当前市场倍数', 'Current market multiple'); origin = t('长桥估值参考接口', 'Longbridge valuation-reference feed');
      extra = [finite(r?.own5y) ? t('自身五年中位 ', 'Own 5-year median ') + r.own5y.toFixed(2) : '', finite(r?.industryMedian) ? t('行业中位 ', 'Industry median ') + r.industryMedian.toFixed(2) : ''].filter(Boolean).join('；');
    } else {
      const end = ({ revenue: rev, netIncome: ni, fcf })[f.meta]?.at(-1);
      if (end) { actual = end.value; period = `FY${end.year} · ` + t('全年金额', 'annual amount'); }
    }
    let comparison = '', relation = 'missing';
    const expected = reviewValue(f, lang);
    if (finite(actual)) {
      // Compare at the same precision shown to users. Differences below 0.01 percentage point cannot become a warning.
      const vals = (f.col === 'dual' ? [f.value?.c, f.value?.o] : [f.value]).filter(finite);
      const scale = f.money ? (Math.abs(actual) >= 1e12 ? 1e12 : Math.abs(actual) >= 1e9 ? 1e9 : Math.abs(actual) >= 1e6 ? 1e6 : 1) : 1;
      const round = (v) => Math.round((v / scale + Number.EPSILON) * 100);
      if (vals.length === (f.col === 'dual' ? 2 : 1)) {
        const a = round(actual), low = Math.min(...vals.map(round)), high = Math.max(...vals.map(round));
        relation = a < low ? 'below' : a > high ? 'above' : low === high ? 'equal' : 'within';
        comparison = ({ below: t('低于假设', 'Below assumption'), above: t('高于假设', 'Above assumption'), equal: t('按显示精度基本一致', 'Equal at displayed precision'), within: t('处于假设区间内', 'Within assumption range') })[relation];
      }
    } else { kind = 'missing'; origin = ''; period = ''; }
    const observed = finite(actual) ? reviewValue({ ...f, col: 'single', value: actual }, lang) : t('暂无可比数据', 'No comparable data');
    const caveat = kind === 'forecast' ? t('历史表现仅供参照，不能单独证明未来假设成立或失效。', 'Historical performance alone cannot validate or invalidate a forecast.') : kind === 'multiple' ? t('市场与历史倍数仅供参照，目标倍数还需盈利质量与风险依据。', 'Market and historical multiples alone do not justify the target multiple.') : '';
    return { k: f.k, expected, observed, period, source: origin, kind, relation, comparison, note: [extra, caveat].filter(Boolean).join(' ') };
  });
}
export function cleanReviewEvidence(raw, fields) {
  const known = fields ? new Set(fields.map((f) => f.k)) : null, seen = new Set();
  return (Array.isArray(raw) ? raw : []).slice(0, 240).filter((e) => {
    if (!e || typeof e.k !== 'string' || (known && !known.has(e.k)) || seen.has(e.k) || !['baseline', 'forecast', 'multiple', 'missing'].includes(e.kind)) return false;
    seen.add(e.k); return true;
  }).map((e) => ({ k: text(e.k, 80), expected: text(e.expected), observed: text(e.observed), period: text(e.period, 120), source: text(e.source, 120), kind: e.kind,
    relation: ['below', 'above', 'equal', 'within', 'missing'].includes(e.relation) ? e.relation : 'missing', comparison: text(e.comparison), note: text(e.note, 400) }));
}
export function constrainReview(review, evidence, lang = 'zh') {
  const byKey = new Map(evidence.map((e) => [e.k, e]));
  let changed = false;
  const checks = review.checks.map((check) => {
    const e = byKey.get(check.k);
    const limited = !e || e.kind === 'missing' || e.kind === 'multiple' || (e.kind === 'forecast' && check.status === 'broken') || (e.relation === 'equal' && check.status === 'broken');
    if (!limited || check.status === 'watch') return check;
    changed = true;
    return { ...check, status: 'watch', reason: e?.note || (lang === 'en' ? 'Comparable evidence is insufficient to settle this assumption.' : '目前的可比证据不足以确认这项假设。'), condition: check.condition || (lang === 'en' ? 'Verify the operating assumptions with comparable evidence; reference values alone do not settle them.' : '需要可比的经营证据验证假设，参考数值本身不足以作出确认。') };
  });
  // Do not preserve a definitive headline after its underlying checks were downgraded.
  const mustWatch = checks.some((c) => c.status === 'watch');
  const overall = checks.some((c) => c.status === 'broken') ? 'broken' : !checks.length || changed || mustWatch || review.overall !== 'hold' ? 'watch' : 'hold';
  return { ...review, checks, overall, ...(changed || overall !== review.overall ? { summary: overall === 'broken' ? (lang === 'en' ? 'Comparable data shows a clear deviation; other assumptions still need verification.' : '可比数据存在明确偏离，其他部分假设仍待验证，请逐项核对。') : (lang === 'en' ? 'Some assumptions still need verification. Review the comparable data and conditions below.' : '部分假设仍待验证，请结合下列可比数据与条件核对。') } : {}) };
}
