import { INTRINSIC } from './intrinsic.js';
import { RELATIVE } from './relative.js';
import { EXTENDED, field } from './extended.js';
const finite = Number.isFinite;
const money = (k,zh,en,col='single',initial) => ({...field(k,zh,en,col,'',initial),money:true});
const modelByKey = new Map([...INTRINSIC,...RELATIVE,...EXTENDED].map(m=>[m.key,m]));
export const PART_METHODS = [
  {key:'pe',zh:'P/E · 净利润',en:'P/E · net income',mode:'netIncome',future:true},
  {key:'ps',zh:'P/S · 股权收入倍数',en:'P/S · equity sales',future:true},
  {key:'evebitda',zh:'EV/EBITDA',en:'EV/EBITDA',future:true},
  {key:'evsales',zh:'EV/Sales',en:'EV/Sales'},
  {key:'fcff',zh:'FCFF · 经营驱动',en:'FCFF · operating drivers'},
  {key:'fcf',zh:'FCFF · 直接现金流',en:'FCFF · direct cash flow'},
  {key:'liquidation',zh:'清算价值',en:'Liquidation value'},
  {key:'ncav',zh:'NCAV',en:'NCAV'},
  {key:'fcfe',zh:'FCFE · 股权现金流',en:'FCFE · equity cash flow'},
  {key:'ddm',zh:'DDM · 分部股息总额',en:'DDM · total segment dividends'},
  {key:'pb',zh:'P/B · 分部净资产',en:'P/B · segment equity'},
  {key:'apv',zh:'APV · 等额还本',en:'APV · amortizing debt',mode:'amortizing'},
  {key:'options',zh:'项目 / 专利期权',en:'Project / patent option',mode:'project'},
  {key:'tobinq',zh:'Tobin’s Q',en:'Tobin’s Q'},
  {key:'manualEquity',zh:'已评估股权现值',en:'Appraised equity PV'},
  {key:'manualEV',zh:'已评估企业现值',en:'Appraised enterprise PV'},
];
export const MAX_PARTS=12;
export const defaultParts = () => [{id:'p1',name:'',method:'pe'}];
export function validParts(parts) {
  return Array.isArray(parts)&&parts.length>0&&parts.length<=MAX_PARTS&&new Set(parts.map(p=>p?.id)).size===parts.length
    &&parts.every(p=>p&&/^p[a-z0-9]{1,20}$/.test(p.id)&&typeof p.name==='string'&&p.name.length<=80&&PART_METHODS.some(m=>m.key===p.method));
}
function baseFields(part) {
  if(part.method==='manualEquity')return[money('value','股权现值','Equity present value','dual')];
  if(part.method==='manualEV')return[money('value','企业现值','Enterprise present value','dual'),money('netDebt','分部净负债','Segment net debt','single',0)];
  const model=modelByKey.get(part.method),mode=PART_METHODS.find(m=>m.key===part.method)?.mode;
  const fields=model?.modes ? model.modes.find(m=>m.key===(mode||model.defaultMode))?.fields||model.fields : model?.fields||[];
  return fields.map(f=>part.method==='ddm'&&f.k==='dps'?{...f,money:true,label:{zh:'分部年度股息总额',en:'Total annual segment dividends'}}:part.method==='pb'&&f.k==='bps'?{...f,money:true,label:{zh:'分部净资产总额',en:'Total segment book equity'}}:part.method==='evebitda'&&f.k==='netDebt'?{...f,label:{zh:'预测期末分部净负债',en:'Segment net debt at forecast horizon'}}:f);
}
const GROUP_FIELDS=[money('groupNetDebt','未分配给分部的集团净负债','Unallocated group net debt','single',0),money('nonOperatingAssets','未计入分部的非经营资产现值','Unallocated non-operating assets PV','dual',0),money('corporateCostsPV','未分摊总部成本现值','Unallocated corporate costs PV','dual',0),money('groupClaims','未计入分部的其他索偿','Other unallocated claims','single',0),field('holdingDiscount','集团层面折价（需依据）','Holding discount (justify)','dual','%',0)];
const MONEY_META=new Set(['revenue','netIncome','fcf','netDebt','ebitda']);
export function sotpFields(form={}) {
  const parts=form._parts===undefined?defaultParts():form._parts;
  if(!validParts(parts))return GROUP_FIELDS;
  return [...GROUP_FIELDS,...parts.flatMap((p,i)=>{
    const label={zh:p.name||`业务 ${i+1}`,en:p.name||`Business ${i+1}`};
    const fields=[...baseFields(p),field('ownership','持股比例','Ownership','single','%',100),field('fx','换算至报价币种的汇率','FX into quoted currency','single','',1)];
    if(PART_METHODS.find(m=>m.key===p.method)?.future)fields.push(field('equityDiscount','预测价格折现率','Discount rate for future equity price','dual','%',10));
    return fields.map(f=>{
      const {prefill,meta,...rest}=f;
      return {...rest,k:`${p.id}_${f.k}`,partId:p.id,baseLabel:f.label,label:{zh:`${label.zh} · ${f.label.zh}`,en:`${label.en} · ${f.label.en}`},money:!!f.money||MONEY_META.has(meta),
        hint:f.hint||{zh:'该分部自身数据，禁止填集团总数',en:'Segment-specific input; never use group totals'}};
    });
  })];
}
export function sotpValues(v) {
  if(!validParts(v._parts)||![v.groupNetDebt,v.nonOperatingAssets,v.corporateCostsPV,v.groupClaims,v.holdingDiscount].every(finite)||v.corporateCostsPV<0||v.groupClaims<0||v.holdingDiscount<0||v.holdingDiscount>=100)return null;
  const parts=[];
  for(const [i,p] of v._parts.entries()) {
    const data=Object.fromEntries(baseFields(p).map(f=>[f.k,v[`${p.id}_${f.k}`]]));
    if(!Object.values(data).every(finite))return null;
    const own=v[`${p.id}_ownership`],fx=v[`${p.id}_fx`],meta=PART_METHODS.find(m=>m.key===p.method);
    if(!finite(own)||own<0||own>100||!finite(fx)||fx<=0)return null;
    let value;
    if(p.method==='manualEquity')value=data.value;
    else if(p.method==='manualEV')value=data.value-data.netDebt;
    else {
      if(data.n!==undefined&&(!Number.isInteger(data.n)||data.n<0||data.n>100))return null;
      if(data.growth!==undefined&&data.growth<=-100)return null;
      if(['netIncome','revenue','ebitda','bps','dps'].some(k=>data[k]!==undefined&&data[k]<0)&&['pe','ps','evebitda','pb','ddm'].includes(p.method))return null;
      if(['targetPE','targetPS','targetPB','targetMultiple'].some(k=>data[k]!==undefined&&data[k]<0))return null;
      value=modelByKey.get(p.method).compute({...data,...(meta.mode?{_mode:meta.mode}:{})},{shares:1});
    }
    if(!finite(value))return null;
    if(meta.future){const rate=v[`${p.id}_equityDiscount`];if(!finite(rate)||rate<0)return null;value/=(1+rate/100)**data.n;}
    const attributed=value*own/100*fx;
    if(!finite(attributed))return null;
    parts.push({id:p.id,name:p.name||`Business ${i+1}`,value:attributed});
  }
  const sum=parts.reduce((s,p)=>s+p.value,0),beforeDiscount=sum+v.nonOperatingAssets-v.corporateCostsPV-v.groupNetDebt-v.groupClaims;
  const discount=Math.max(0,beforeDiscount)*v.holdingDiscount/100, equity=beforeDiscount-discount;
  return finite(equity)?{parts,sum,beforeDiscount,discount,equity}:null;
}
export const SOTP={key:'sotp',group:'combination',label:{zh:'SOTP 分部加总',en:'SOTP'},fields:GROUP_FIELDS,fieldsFor:sotpFields,
  guidance:{zh:'先添加业务并选择各自的方法；金额使用该分部币种，汇率=1单位分部币种对应的报价币种。分部先转股权现值，再按持股比例与汇率加总。集团净负债仅填未在分部扣除的余额；总部成本、非经营资产和其他索偿也只调整一次。含预测年数的倍数分部会折现到今天，EV/EBITDA 的净负债应为预测期末值；手填值必须是现值。集团折价默认0，不能重复反映已计入分部的风险。',en:'Add businesses and choose their methods. Amounts use each segment currency; FX is quote currency per segment currency unit. Convert each to present equity value, then apply ownership and FX. Group debt, corporate costs, non-operating assets and other claims must only include unallocated amounts. Future multiple prices are discounted to today; appraised inputs must already be present values. Holding discount defaults to zero; avoid double-counting risk.'},
  compute(v,c){const x=sotpValues(v);return x&&finite(c?.shares)&&c.shares>0?x.equity/c.shares:null;},
  breakdown(v){const x=sotpValues(v);if(!x)return[];const row=(key,zh,en,value)=>({key,label:{zh,en},value,kind:'money'});return [...x.parts.map((p,i)=>row(p.id,v._parts[i].name||`业务 ${i+1}`,p.name,p.value)),row('sum','归属股权现值合计','Attributable equity PV',x.sum),row('discount','集团折价金额','Holding discount amount',x.discount),row('equity','集团股权价值','Group equity value',x.equity)];}
};
