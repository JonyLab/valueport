import { reviewNeedsUpdate, reviewMode, scopeReviewFields, reviewValue } from './review.js';
const el = (tag, cls, value) => { const n = document.createElement(tag); if (cls) n.className = cls; if (value !== undefined) n.textContent = value; return n; };
export function reviewElement(card, { fields = [], lang = 'zh', onEdit, onFinancials, loadTrend } = {}) {
  const r = card.review, zh = lang !== 'en', t = (a, b) => zh ? a : b, stale = reviewNeedsUpdate(card);
  const overall = stale ? 'stale' : r.overall;
  const labels = { hold: t('暂未见明显偏离', 'No clear deviation'), watch: t('待验证 / 需关注', 'Verify / watch'), broken: t('发现明确偏离', 'Evidence of deviation'), stale: t('待重新复核', 'Review needed') };
  const statuses = { ok: t('暂未见偏离', 'No clear deviation'), watch: t('待验证', 'Needs verification'), broken: t('明确偏离', 'Clear deviation') };
  const box = el('div', 'vrev ' + overall), top = el('div', 'vrev-top');
  top.append(el('span', 'vrev-badge ' + overall, labels[overall]), el('span', 'vrev-when', t('AI 复核 · ', 'AI review · ') + (r.at ? r.at.slice(0, 10) : ''))); box.append(top);
  if (stale) box.append(el('p', 'vrev-stale', t('这份复核使用旧口径，或估值假设已变化。请重新复核；旧结论仅保留作记录。', 'This review uses an older assessment method or changed assumptions. Re-run it; the previous conclusion is retained only as a record.')));
  const details = el('details', 'vcard-details');
  details.append(el('summary', '', stale ? t('旧复核记录（已过期）', 'Previous review (outdated)') : t('复核依据', 'Review evidence'))); box.append(details);
  if (r.summary) details.append(el('p', 'vrev-sum', r.summary));
  const current = new Map(scopeReviewFields(fields, reviewMode(card)).map((f) => [f.k, f]));
  const evidence = new Map((r.evidence || []).map((e) => [e.k, e]));
  const list = el('div', 'vrev-checks');
  for (const check of r.checks || []) {
    const f = current.get(check.k), e = evidence.get(check.k), row = el('section', 'vrev-row');
    const heading = el('div', 'vrev-row-head');
    heading.append(el('strong', 'vrev-k', f?.label || check.k), el('span', 'vrev-state ' + (stale ? '' : check.status), stale ? t('旧判断', 'Previous assessment') : statuses[check.status])); row.append(heading);
    if (!stale) {
      const data = el('dl', 'vrev-data');
      const add = (name, value) => { const line = el('div', ''); line.append(el('dt', '', name), el('dd', '', value)); data.append(line); };
      add(t('原假设', 'Assumption'), e?.expected || (f ? reviewValue(f, lang) : '—'));
      add(t('可比数据', 'Comparable data'), e ? [e.observed, e.period].filter(Boolean).join(' · ') : t('暂无可比数据', 'No comparable data'));
      if (e?.comparison && e.kind !== 'multiple') add(t('数值对照', 'Comparison'), e.comparison);
      row.append(data);
    }
    row.append(el('p', 'vrev-why', check.reason || statuses[check.status]));
    if (!stale && check.condition) row.append(el('p', 'vrev-condition', t('验证条件：', 'To verify: ') + check.condition));
    if (!stale && e?.note) row.append(el('p', 'vrev-note', e.note));
    if (!stale && e?.source) row.append(el('p', 'vrev-source', t('来源：', 'Source: ') + e.source));
    // Put trends below the explanation so they do not squeeze long Chinese paragraphs.
    if (!stale && check.metric && loadTrend) Promise.resolve(loadTrend(check.metric)).then((trend) => {
      if (!trend?.element) return;
      const foot = el('div', 'vrev-trend'); foot.append(trend.element, el('span', '', trend.label)); row.append(foot);
    }).catch(() => {});
    list.append(row);
  }
  details.append(list);
  if (!stale && (r.evidence || []).some((e) => e.source)) details.append(el('p', 'vrev-source', t('以上接口数据未附报告原文页码。', 'These feed records do not include original report page references.')));
  if (!stale && onFinancials) { const b = el('button', 'vrev-go', t('查看财报数据', 'View financial data')); b.type = 'button'; b.onclick = onFinancials; details.append(b); }
  if (!stale && r.overall !== 'hold' && onEdit) { const b = el('button', 'vrev-go', t('查看并调整假设', 'Review and edit assumptions')); b.type = 'button'; b.onclick = onEdit; box.append(b); }
  return box;
}
