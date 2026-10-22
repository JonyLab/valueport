import { describe, it, expect } from 'vitest';
import { MODELS, modeFields, runModel, runScenario } from '../public/shared/valuation/index.js';
import { optionCall } from '../public/shared/valuation/extended.js';
import { sotpValues } from '../public/shared/valuation/sotp.js';
import { midpointForm } from '../public/shared/valuation/workbench.js';
const model = key => MODELS.find(m=>m.key===key);
const ctx={shares:100};
const scenarioForm=(key,values)=>Object.fromEntries(Object.entries(values).map(([k,v])=>[k,modeFields(model(key),values._mode,values).find(f=>f.k===k)?.col==='dual'?{c:v,o:v}:v]));
const apv={fcf:100,n:2,growth:0,unleveredCost:10,termGrowth:0,debtAmount:100,debtMarketValue:100,debtYears:2,debtRate:10,taxRate:25,shieldUse:100,shieldDiscount:0,distressPV:0,financingPV:0,excessCash:0,otherClaims:0};
describe('APV with separate financing effects',()=>{
 it('matches a perpetuity plus finite declining tax shields',()=>{expect(model('apv').compute(apv,ctx)).toBeCloseTo(9.0375,8);});
 it('uses opening balance for bullet debt and stops shielding at maturity',()=>{expect(model('apv').compute({...apv,_mode:'constant'},ctx)).toBeCloseTo(9.05,8);});
 it('tax losses can eliminate shields; distress costs and cash bridge exactly once',()=>{expect(model('apv').compute({...apv,shieldUse:0,distressPV:20,excessCash:30,otherClaims:5},ctx)).toBeCloseTo(9.05,8);});
 it('rejects invalid rate, maturity and tax assumptions',()=>{for(const bad of [{termGrowth:10},{debtYears:0},{n:2.5},{taxRate:101},{shieldUse:-1},{debtMarketValue:-1},{growth:-100}])expect(model('apv').compute({...apv,...bad},ctx)).toBeNull();});
});
const call={underlying:100,exercise:100,expiry:1,volatility:20,riskFree:5,yieldRate:0};
describe('contingent claims',()=>{
 it('matches the standard Black–Scholes reference call',()=>{expect(optionCall(call)).toBeCloseTo(10.45058357,4);});
 it('handles expiry, zero volatility, free exercise and worthless assets',()=>{
  expect(optionCall({...call,expiry:0,underlying:120})).toBe(20);
  expect(optionCall({...call,volatility:0})).toBeCloseTo(100-100*Math.exp(-.05),8);
  expect(optionCall({...call,exercise:0})).toBe(100);
  expect(optionCall({...call,underlying:0})).toBe(0);
  expect(optionCall({...call,expiry:-1})).toBeNull();
 });
 it('distressed equity is the call itself, without a second debt subtraction',()=>{expect(model('options').compute({...call,_mode:'distressed',netDebt:100},ctx)).toBeCloseTo(.10450584,6);});
 it('adds only the attributable project option to business value',()=>{expect(model('options').compute({...call,_mode:'project',baseValue:500,ownership:50,netDebt:100,otherClaims:10},ctx)).toBeCloseTo(3.9522529,6);});
});
const liq={cash:100,receivables:200,inventory:300,fixedAssets:400,otherAssets:100,receivableRecovery:50,inventoryRecovery:40,fixedRecovery:50,otherRecovery:30,totalLiabilities:250,seniorClaims:10,closureCosts:50,delay:1,discount:10};
describe('asset values and additional multiples',()=>{
 it('discounts delayed liquidation proceeds net of costs and deducts all claims',()=>{expect(model('liquidation').compute(liq,ctx)).toBeCloseTo(2.036363636,8);});
 it('floors liquidation equity at zero but retains the deficit in the breakdown',()=>{const v={...liq,totalLiabilities:1000};expect(model('liquidation').compute(v,ctx)).toBe(0);expect(model('liquidation').breakdown(v).find(x=>x.key==='residual').value).toBeLessThan(0);});
 it('NCAV subtracts long-term liabilities too and exposes raw negative NCAV',()=>{const v={currentAssets:1000,totalLiabilities:400,seniorClaims:100,ncavFactor:80};expect(model('ncav').compute(v,ctx)).toBe(4);expect(model('ncav').compute({...v,totalLiabilities:2000},ctx)).toBe(0);});
 it('EV/Sales subtracts net debt and other claims once',()=>{expect(model('evsales').compute({revenue:500,targetEVSales:2,netDebt:100,otherClaims:50},ctx)).toBe(8.5);});
 it('operating Q prices replacement cost, not book equity',()=>{expect(model('tobinq').compute({replacementCost:500,targetQ:1.2,netDebt:100,otherClaims:0},ctx)).toBe(5);});
 it('sector multiples distinguish enterprise and equity numerators',()=>{
  expect(model('sector').compute({_mode:'users',quantity:10000,unitValue:5,netDebt:10000,otherClaims:0},ctx)).toBe(400);
  expect(model('sector').compute({_mode:'gmv',quantity:10000,unitValue:.2,netDebt:10000},ctx)).toBe(20);
  expect(model('sector').compute({_mode:'reserves',quantity:10000,unitValue:5,netDebt:10000,otherClaims:0},ctx)).toBe(400);
 });
 it('rejects missing facts instead of coercing null to zero',()=>{expect(model('ncav').compute({currentAssets:null,totalLiabilities:0,seniorClaims:0,ncavFactor:100},ctx)).toBeNull();expect(model('evsales').compute({revenue:500,targetEVSales:-1,netDebt:0,otherClaims:0},ctx)).toBeNull();});
});
const sotp={_parts:[{id:'p1',name:'Hardware',method:'pe'},{id:'p2',name:'Cars',method:'evsales'}],groupNetDebt:200,nonOperatingAssets:50,corporateCostsPV:100,groupClaims:0,holdingDiscount:10,
 p1_netIncome:100,p1_n:1,p1_growth:10,p1_targetPE:10,p1_ownership:50,p1_fx:2,p1_equityDiscount:10,
 p2_revenue:500,p2_targetEVSales:2,p2_netDebt:100,p2_otherClaims:0,p2_ownership:100,p2_fx:1};
describe('SOTP mixed methods',()=>{
 it('aligns dates, ownership, FX and residual group debt before discount',()=>{const result=sotpValues(sotp);expect(result.parts[0].value).toBeCloseTo(1000,8);expect(result.parts[1].value).toBe(900);expect(result.equity).toBe(1485);expect(model('sotp').compute(sotp,ctx)).toBe(14.85);});
 it('does not silently drop a segment with missing inputs or unknown method',()=>{expect(model('sotp').compute({...sotp,p2_revenue:undefined},ctx)).toBeNull();expect(model('sotp').compute({...sotp,_parts:[{id:'p1',name:'Bad',method:'unknown'}]},ctx)).toBeNull();expect(model('sotp').compute({...sotp,_parts:[]},ctx)).toBeNull();});
 it('rejects duplicate ids, invalid ownership, FX and discount',()=>{for(const bad of [{p1_ownership:101},{p2_fx:0},{holdingDiscount:100},{_parts:[sotp._parts[0],sotp._parts[0]]}])expect(model('sotp').compute({...sotp,...bad},ctx)).toBeNull();});
 it('keeps case identity even when the optimistic value is lower',()=>{const f=scenarioForm('sotp',sotp);f.p2_targetEVSales={c:2,o:1};expect(runScenario(model('sotp'),f,ctx,'c')).toBe(14.85);expect(runScenario(model('sotp'),f,ctx,'o')).toBe(10.35);expect(runModel(model('sotp'),f,ctx)).toEqual({low:10.35,high:14.85});});
 it('survives JSON persistence and computes midpoint breakdowns with structure',()=>{const f=JSON.parse(JSON.stringify(scenarioForm('sotp',sotp)));expect(runModel(model('sotp'),f,ctx)).toEqual({low:14.85,high:14.85});const mid=midpointForm(model('sotp'),null,f);expect(model('sotp').breakdown(mid).find(x=>x.key==='equity').value).toBe(1485);});
 it('never prefills each segment with group financials',()=>{for(const f of modeFields(model('sotp'),null,sotp).filter(f=>f.partId))expect(f.prefill).toBeUndefined();});
 it('supports DCF and manual enterprise/equity present values',()=>{const v={...sotp,_parts:[{id:'p1',name:'Operations',method:'fcf'},{id:'p2',name:'Equity stake',method:'manualEquity'}],p1_fcf:100,p1_n:2,p1_growth:0,p1_discount:10,p1_termGrowth:0,p1_netDebt:100,p1_ownership:100,p1_fx:1,p2_value:100,p2_ownership:50,p2_fx:2,groupNetDebt:0,nonOperatingAssets:0,corporateCostsPV:0,holdingDiscount:0};expect(model('sotp').compute(v,ctx)).toBeCloseTo(10,8);const manual={...v,_parts:[{id:'p1',name:'EV',method:'manualEV'}],p1_value:1000};expect(model('sotp').compute(manual,ctx)).toBe(9);});
});


describe('zero equity research records', () => {
 it('retains narrow research ranges without assigning equal rounded gauge endpoints', async () => {
  const { valuationChange, usableValuationRange } = await import('../public/shared/valuation/save.js');
  const value={method:'pe',scenarioMode:'range',low:10.001,high:10.004,inputs:{}};
  const cfg={valuations:[],fairLow:0,fairHigh:0,selectedValuationId:null};
  const saved=valuationChange(cfg,null,value,'narrow','now');
  expect(saved.valuations[0].high).toBe(10.004);
  expect(saved.selectedValuationId).toBeNull();
  expect(usableValuationRange(value)).toBe(false);
  expect(usableValuationRange({...value,scenarioMode:'single',high:value.low})).toBe(true);
 });
 it('saves zero liquidation results without assigning a zero pendulum', async () => {
  const { valuationChange } = await import('../public/shared/valuation/save.js');
  const value={method:'liquidation',scenarioMode:'single',low:0,high:0,inputs:{}};
  const cfg={valuations:[],fairLow:0,fairHigh:0,selectedValuationId:null};
  const saved=valuationChange(cfg,null,value,'zero','now');
  expect(saved.valuations[0].low).toBe(0); expect(saved.selectedValuationId).toBeNull(); expect(saved.fairHigh).toBe(0);
  const original={...cfg,valuations:[{...value,id:'v1',low:10,high:10}],selectedValuationId:'v1',fairLow:10,fairHigh:10};
  expect(valuationChange(original,'v1',value).selectedValuationId).toBeNull();
  expect(valuationChange(original,'v1',value).fairLow).toBe(0);
  expect(()=>valuationChange(cfg,null,{...value,low:-1,high:-1})).toThrow();
 });
});
