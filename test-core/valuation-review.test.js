import { describe, it, expect } from 'vitest';
import { REVIEW_VERSION, scopeReviewFields, reviewValue, buildReviewEvidence, cleanReviewEvidence, reviewNeedsUpdate, constrainReview } from '../public/shared/valuation/review.js';
const account = (field, rows) => ({ field, values: rows.map(([year, value]) => ({ year, value })).reverse() });
const fields = [
  { k:'growth', label:'营收增速', meta:'revGrowth', col:'dual', unit:'%', value:{c:36.38,o:99} },
  { k:'margin', label:'净利率', meta:'netMargin', col:'dual', unit:'%', value:{c:6.88,o:50} },
  { k:'pe', label:'目标PE', meta:'targetPE', col:'dual', value:{c:20,o:80} },
  { k:'revenue', label:'当前营收', meta:'revenue', col:'single', money:true, value:200 },
];
const financials = { IS:[account('OperatingRevenue',[[2022,100],[2023,120],[2024,150],[2025,200]]),account('NetProfit',[[2025,13.756]])] };
const evidence = (overrides={}) => buildReviewEvidence({fields,scenarioMode:'single',financials,financialsSource:'longbridge',valuationRefs:{pe:{current:30.1,own5y:170.6,industryMedian:17.4}},...overrides});
describe('valuation review evidence and scope',()=>{
 it('uses only the main case and preserves future-assumption identity',()=>{
  const f=scopeReviewFields(fields,'single');
  expect(f[0]).toMatchObject({col:'single',value:36.38,assumption:true});
  expect(reviewValue(f[0])).toBe('36.38%');
  expect(scopeReviewFields(f,'single')).toEqual(f);
  expect(reviewValue(scopeReviewFields(fields,'range')[0])).toBe('保守 36.38% / 乐观 99.00%');
  expect(evidence()[0].expected).not.toContain('99');
 });
 it('compares at displayed precision and identifies periods and sources',()=>{
  const e=evidence();
  expect(e[1]).toMatchObject({observed:'6.88%',expected:'6.88%',relation:'equal',comparison:'按显示精度基本一致',period:'FY2025 · 全年利润率',source:'长桥财报接口'});
  expect(e[0]).toMatchObject({kind:'forecast',period:'FY2022–FY2025 · 三年复合增速',relation:'below'});
  expect(e[0].note).toContain('不能单独证明未来假设成立或失效');
  expect(e[2]).toMatchObject({kind:'multiple',observed:'30.10'});
  expect(e[3]).toMatchObject({kind:'baseline',relation:'equal'});
 });
 it('does not turn two equal range assumptions into single mode',()=>{
  const e=evidence({scenarioMode:'range',fields:[{...fields[1],value:{c:6.88,o:6.88}}]})[0];
  expect(e.expected).toBe('保守 6.88% / 乐观 6.88%'); expect(e.relation).toBe('equal');
 });
 it('does not infer a three-year CAGR from a gap or compare unmatched fiscal years',()=>{
  const e=evidence({financials:{IS:[account('OperatingRevenue',[[2020,100],[2021,110],[2024,150],[2025,200]]),account('NetProfit',[[2026,15]])]}});
  expect(e[0].kind).toBe('missing'); expect(e[1].kind).toBe('missing');
  expect(e[0].source).toBe('');
 });
 it('caps conclusions based only on historical performance, multiples or missing data',()=>{
  const r=constrainReview({overall:'broken',summary:'失效',checks:[{k:'growth',status:'broken',reason:'历史低于预测，所以失效'},{k:'pe',status:'ok',reason:'低于历史倍数，所以合理'},{k:'unknown',status:'ok',reason:'成立'}]},evidence());
  expect(r.overall).toBe('watch');expect(r.checks.map(c=>c.status)).toEqual(['watch','watch','watch']);
  expect(r.summary).not.toContain('失效');expect(r.checks[1].reason).toContain('仅供参照');
  const mixed=constrainReview({overall:'broken',summary:'起点偏离',checks:[{k:'revenue',status:'broken'},{k:'unknown',status:'ok'}]},evidence().map(e=>e.k==='revenue'?{...e,relation:'below'}:e));
  expect(mixed.overall).toBe('broken');
 });
 it('recognizes old versions, changed cases and changed inputs as stale',()=>{
  const c={scenarioMode:'single',updatedAt:'2026-10-21T00:00:00Z'};
  c.review={version:REVIEW_VERSION,scenarioMode:'single',valuedAt:c.updatedAt,at:'2026-10-21T01:00:00Z'};
  expect(reviewNeedsUpdate(c)).toBe(false);
  for(const changes of [{version:undefined},{scenarioMode:'range'},{valuedAt:'2026-10-20'}])expect(reviewNeedsUpdate({...c,review:{...c.review,...changes}})).toBe(true);
 });
 it('bounds persisted evidence and removes duplicate or unknown fields',()=>{
  const e=evidence();expect(cleanReviewEvidence(e,fields)).toEqual(e);
  expect(cleanReviewEvidence([e[0],e[0],{...e[1],k:'unknown'}],fields)).toEqual([e[0]]);
 });
});
