// Additional valuation calculators. Amounts use the quoted share currency;
// rates are percentage points. No market multiples or source facts are invented.
import { blackScholesCall } from './resource.js';
export const num = Number.isFinite;
const pos = x => num(x) && x > 0;
const nonneg = x => num(x) && x >= 0;
const pct = x => num(x) && x >= 0 && x <= 100;
const years = x => Number.isInteger(x) && x >= 1 && x <= 100;
const shareValue = (value, ctx) => num(value) && pos(ctx?.shares) ? value / ctx.shares : null;
export const field = (k, zh, en, col = 'single', unit = '', initial, hint) => ({ k, label: { zh, en }, col, unit,
  ...(initial !== undefined ? { default: initial } : {}), ...(hint ? { hint: { zh: hint[0], en: hint[1] } } : {}) });
const money = (k, zh, en, col = 'single', initial, hint) => ({ ...field(k, zh, en, col, '', initial, hint), money: true });
const row = (key, zh, en, value, kind = 'money') => ({ key, label: { zh, en }, value: num(value) ? value : null, kind });
const nd = () => ({ ...money('netDebt', '净负债', 'Net debt', 'single', 0), meta: 'netDebt', prefill: c => num(c?.netDebt) ? c.netDebt : 0 });

function apvValues(v) {
  const { fcf, n, growth, unleveredCost, termGrowth, debtAmount, debtYears, debtRate, shieldDiscount, taxRate, shieldUse, distressPV, financingPV, debtMarketValue, excessCash, otherClaims } = v;
  if (![fcf,growth,unleveredCost,termGrowth,debtAmount,debtRate,shieldDiscount,taxRate,shieldUse,distressPV,financingPV,debtMarketValue,excessCash,otherClaims].every(num)
    || !years(n) || !years(debtYears) || growth <= -100 || termGrowth <= -100 || unleveredCost <= 0 || unleveredCost <= termGrowth || shieldDiscount < 0
    || ![debtAmount,debtRate,distressPV,debtMarketValue,excessCash,otherClaims].every(nonneg) || !pct(taxRate) || !pct(shieldUse)) return null;
  let operations = 0, shield = 0;
  const rows = [];
  for (let t = 1; t <= n; t++) {
    const cf = fcf * (1 + growth / 100) ** t, pv = cf / (1 + unleveredCost / 100) ** t;
    operations += pv; rows.push({ year: t, cf, pv });
  }
  const terminalPv = fcf * (1 + growth / 100) ** n * (1 + termGrowth / 100) / ((unleveredCost - termGrowth) / 100) / (1 + unleveredCost / 100) ** n;
  operations += terminalPv;
  for (let t = 1; t <= debtYears; t++) {
    const openingDebt = debtAmount * (v._mode === 'constant' ? 1 : 1 - (t - 1) / debtYears);
    shield += openingDebt * debtRate / 100 * taxRate / 100 * shieldUse / 100 / (1 + shieldDiscount / 100) ** t;
  }
  const enterprise = operations + shield + financingPV - distressPV;
  const equity = enterprise - debtMarketValue + excessCash - otherClaims;
  return [operations,shield,enterprise,equity,terminalPv].every(num) ? { operations, shield, enterprise, equity, rows, terminalPv } : null;
}
const APV_FIELDS = [
  money('fcf','当前无杠杆自由现金流','Current unlevered free cash flow','single',undefined,['扣再投资、未扣利息的企业现金流','After reinvestment, before interest']),
  field('n','经营预测年数','Operating forecast years','single','',5),
  field('growth','现金流增速','Cash-flow growth','dual','%',5),
  field('unleveredCost','无杠杆资本成本','Unlevered cost of capital','dual','%',10),
  field('termGrowth','永续增速','Terminal growth','dual','%',2),
  money('debtAmount','期初计息债务本金','Opening interest-bearing principal'),
  money('debtMarketValue','债务市场价值','Market value of debt'),
  field('debtYears','债务偿还年限','Debt maturity in years','single','',5),
  field('debtRate','债务利率','Interest rate on debt','dual','%',5),
  field('taxRate','边际税率','Marginal tax rate','single','%',25),
  field('shieldUse','可利用税盾比例','Usable tax shield','dual','%',100),
  field('shieldDiscount','税盾折现率','Tax-shield discount rate','dual','%',5),
  money('financingPV','其他融资效应现值','Other financing effects PV','dual',0,['含续借税盾时须单独估计，勿重复计算','Estimate refinancing benefits separately; avoid double counting']),
  money('distressPV','预期财务困境成本现值','Expected distress costs PV','dual',0),
  money('excessCash','非经营现金','Non-operating cash','single',0),
  money('otherClaims','其他优先索偿','Other senior claims','single',0),
];
const APV = { key:'apv', group:'intrinsic', label:{zh:'APV 调整现值',en:'APV'}, fields:APV_FIELDS, defaultMode:'amortizing',
  modes:[{key:'amortizing',label:{zh:'等额偿还本金',en:'Equal principal repayments'},fields:APV_FIELDS},{key:'constant',label:{zh:'到期一次偿还',en:'Bullet repayment'},fields:APV_FIELDS}],
  guidance:{zh:'经营现金流按无杠杆资本成本折现；税盾按期初债务逐年计算，偿债期结束后不再产生税盾。先算含融资效应的企业价值，再扣债务市场价值。',en:'Discount operations at the unlevered cost of capital. Tax shields use annual opening debt and end at maturity. Subtract debt market value after adding financing effects.'},
  compute(v,c){return shareValue(apvValues(v)?.equity,c);},
  schedule(v){const x=apvValues(v);return x?{kind:'money',rows:x.rows,terminalPv:x.terminalPv}:null;},
  breakdown(v){const x=apvValues(v);return [row('operations','无杠杆业务价值','Unlevered operating value',x?.operations),row('shield','税盾现值','Tax shield PV',x?.shield),row('enterprise','含融资效应企业价值','Adjusted enterprise value',x?.enterprise),row('equity','股权价值','Equity value',x?.equity)];}
};

export function optionCall(v) {
  const { underlying, exercise, expiry, volatility, riskFree, yieldRate } = v;
  if (![underlying,exercise,expiry,volatility,yieldRate].every(nonneg) || !num(riskFree)) return null;
  const s = underlying * Math.exp(-yieldRate / 100 * expiry), k = exercise * Math.exp(-riskFree / 100 * expiry);
  if (![s,k].every(num)) return null;
  if (expiry === 0) return Math.max(underlying-exercise,0);
  if (underlying === 0) return 0;
  if (volatility === 0 || exercise === 0) return Math.max(s-k,0);
  const value = blackScholesCall(underlying,exercise,expiry,volatility/100,riskFree/100,yieldRate/100);
  return num(value) ? Math.max(0,value) : null;
}
const OPTION_FIELDS = [money('underlying','标的资产现值 S','Underlying asset value S','dual'),money('exercise','行权成本 / 到期优先债务 K','Exercise cost / senior debt at maturity K','dual'),
  field('expiry','剩余期限','Remaining term','single','',5),field('volatility','资产价值波动率','Asset-value volatility','dual','%',30),field('riskFree','连续复利无风险利率','Continuously compounded risk-free rate','single','%',3),field('yieldRate','持有收益率 / 延迟损失率','Payout / cost-of-delay yield','dual','%',0)];
const PROJECT_FIELDS=[...OPTION_FIELDS,money('baseValue','不含该期权的业务现值','Business value excluding this option','dual',0),field('ownership','期权权益比例','Option ownership','single','%',100),nd(),money('otherClaims','其他优先索偿','Other senior claims','single',0)];
const OPTIONS={allowZero:true,key:'options',group:'contingent',label:{zh:'或有权益 / 实物期权',en:'Contingent claims / real options'},fields:PROJECT_FIELDS,defaultMode:'project',modes:[{key:'project',label:{zh:'项目 / 专利期权',en:'Project / patent option'},fields:PROJECT_FIELDS},{key:'distressed',label:{zh:'困境企业股权',en:'Distressed equity'},fields:OPTION_FIELDS}],
  guidance:{zh:'使用欧式 Black–Scholes 看涨期权近似。项目模式将期权加到未含该项目的业务价值；困境股权模式直接以资产价值和到期优先债务计算股权，不再扣债务。S 为资产现值，不是收入；波动率为资产价值波动率。提前行权、多阶段开发和临床成功概率需另建模型。',en:'European Black–Scholes call approximation. Project mode adds the option to business value excluding the project. Distressed mode values equity directly without deducting debt again. S is asset value, not revenue; use asset volatility. Early exercise, staged investment and clinical success probabilities require separate modeling.'},
  compute(v,c){const option=optionCall(v);if(option===null)return null;if(v._mode==='distressed')return shareValue(option,c);if(![v.baseValue,v.netDebt,v.otherClaims].every(num)||!pct(v.ownership)||!nonneg(v.otherClaims))return null;return shareValue(v.baseValue+option*v.ownership/100-v.netDebt-v.otherClaims,c);},
  breakdown(v,c){return [row('option','看涨期权价值','Call option value',optionCall(v)),row('equity','股权价值','Equity value',this.compute(v,c)===null?null:this.compute(v,c)*c.shares)];}
};
const LIQUIDATION_FIELDS=[money('cash','可用现金','Available cash'),money('receivables','应收款账面值','Receivables book value'),money('inventory','存货账面值','Inventory book value'),money('fixedAssets','固定资产账面值','Fixed assets book value'),money('otherAssets','其他可变现资产账面值','Other realizable assets book value'),
  ...[['receivableRecovery','应收款回收率','Receivables recovery'],['inventoryRecovery','存货回收率','Inventory recovery'],['fixedRecovery','固定资产回收率','Fixed asset recovery'],['otherRecovery','其他资产回收率','Other asset recovery']].map(([k,z,e])=>field(k,z,e,'dual','%',undefined)),
  money('totalLiabilities','全部负债清偿额','All liabilities to settle'),money('seniorClaims','未计入负债的优先索偿','Senior claims outside liabilities','single',0),money('closureCosts','清算税费及关闭成本','Liquidation taxes and closing costs','dual',0),field('delay','变现等待年数','Years to realization','single','',1),field('discount','清算回收折现率','Realization discount rate','dual','%',10)];
function liquidation(v){
  if(!['cash','receivables','inventory','fixedAssets','otherAssets','totalLiabilities','seniorClaims','closureCosts','delay','discount'].every(k=>nonneg(v[k]))||!['receivableRecovery','inventoryRecovery','fixedRecovery','otherRecovery'].every(k=>nonneg(v[k])))return null;
  const proceeds=v.receivables*v.receivableRecovery/100+v.inventory*v.inventoryRecovery/100+v.fixedAssets*v.fixedRecovery/100+v.otherAssets*v.otherRecovery/100;
  // Cash and liabilities are settled today; delayed gross proceeds and costs discounted.
  const pv=(proceeds-v.closureCosts)/(1+v.discount/100)**v.delay;
  const residual=v.cash+pv-v.totalLiabilities-v.seniorClaims;
  return [proceeds,pv,residual].every(num)?{proceeds,pv,residual,equity:Math.max(0,residual)}:null;
}
const LIQUIDATION={allowZero:true,key:'liquidation',group:'asset',label:{zh:'清算价值',en:'Liquidation value'},fields:LIQUIDATION_FIELDS,
  guidance:{zh:'现金及负债按当前清偿额计，其他资产变现所得与清算费用在等待期末折现。回收率可高于账面值，但必须有评估依据。未覆盖的利息、税费和优先索偿需计入，普通股价值最低为零。',en:'Cash and liabilities use current settlement values. Discount other asset proceeds and closing costs from the realization date. Recovery above book value needs appraisal evidence. Include accrued interest, taxes and senior claims; common equity is floored at zero.'},
  compute(v,c){return shareValue(liquidation(v)?.equity,c);},breakdown(v){const x=liquidation(v);return[row('proceeds','非现金资产回收额','Non-cash asset proceeds',x?.proceeds),row('residual','未截零剩余价值','Residual before zero floor',x?.residual),row('equity','普通股清算价值','Common equity liquidation value',x?.equity)];}
};
const NCAV={allowZero:true,key:'ncav',group:'asset',label:{zh:'NCAV 净流动资产',en:'NCAV'},fields:[money('currentAssets','流动资产','Current assets'),money('totalLiabilities','总负债（含长期负债）','Total liabilities, including long-term'),money('seniorClaims','未计入负债的优先索偿','Senior claims outside liabilities','single',0),field('ncavFactor','采用 NCAV 的比例','Fraction of NCAV used','dual','%',100)],
  guidance:{zh:'NCAV = 流动资产 − 总负债 − 其他优先索偿，原始 NCAV 可能为负。采用比例是你的折扣假设，不是额外资产；回收率和清算成本请用清算模型逐项评估。',en:'NCAV = current assets minus all liabilities and other senior claims; raw NCAV can be negative. The chosen fraction is your discount assumption. Use the liquidation model for recovery rates and liquidation costs.'},
  compute(v,c){if(![v.currentAssets,v.totalLiabilities,v.seniorClaims].every(nonneg)||!pct(v.ncavFactor))return null;return shareValue(Math.max(0,v.currentAssets-v.totalLiabilities-v.seniorClaims)*v.ncavFactor/100,c);},
  breakdown(v){return[row('ncav','原始 NCAV','Raw NCAV',[v.currentAssets,v.totalLiabilities,v.seniorClaims].every(num)?v.currentAssets-v.totalLiabilities-v.seniorClaims:null)];}
};
const EVSALES={key:'evsales',group:'relative',label:{zh:'EV/Sales 企业收入倍数',en:'EV/Sales'},fields:[{...money('revenue','同期间营收','Revenue for the chosen period'),meta:'revenue',prefill:c=>num(c?.revenue)?c.revenue:''},field('targetEVSales','目标 EV/Sales','Target EV/Sales','dual',''),nd(),money('otherClaims','其他非普通股索偿','Other non-common claims','single',0)],
  guidance:{zh:'收入×EV/Sales得到企业价值，再扣净负债及其他索偿。输入当前或同一预测年度的收入和倍数；模型不自动预测收入或折现未来价格。',en:'Revenue × EV/Sales gives enterprise value; subtract net debt and other claims. Align the revenue and multiple period. This model does not forecast revenue or discount future prices.'},
  compute(v,c){if(!pos(v.revenue)||!nonneg(v.targetEVSales)||!num(v.netDebt)||!nonneg(v.otherClaims))return null;return shareValue(v.revenue*v.targetEVSales-v.netDebt-v.otherClaims,c);},
  breakdown(v){return[row('ev','企业价值','Enterprise value',pos(v.revenue)&&nonneg(v.targetEVSales)?v.revenue*v.targetEVSales:null)];}
};
const Q={key:'tobinq',group:'relative',label:{zh:'Tobin’s Q 重置成本倍数',en:'Tobin’s Q'},fields:[money('replacementCost','经营资产重置成本','Operating asset replacement cost'),field('targetQ','目标 Q 倍数','Target Q multiple','dual',''),nd(),money('otherClaims','其他非普通股索偿','Other non-common claims','single',0)],
  guidance:{zh:'使用经营口径：经营资产重置成本×目标 Q 得到经营企业价值，再减净负债与其他索偿。重置成本须剔除单列现金，不能直接用会计净资产替代。可比 Q 也须使用同一口径。',en:'Operating convention: replacement cost × target Q gives operating enterprise value; subtract net debt and other claims. Exclude separately counted cash from replacement cost; book equity is not a substitute. Comparable Q ratios must use the same basis.'},
  compute(v,c){if(!pos(v.replacementCost)||!nonneg(v.targetQ)||!num(v.netDebt)||!nonneg(v.otherClaims))return null;return shareValue(v.replacementCost*v.targetQ-v.netDebt-v.otherClaims,c);},
  breakdown(v){return[row('ev','经营企业价值','Operating enterprise value',pos(v.replacementCost)&&nonneg(v.targetQ)?v.replacementCost*v.targetQ:null)];}
};
const SECTOR_MODES=[['users','EV / 活跃用户','EV / active user','活跃用户数','Active users','每用户企业价值','Enterprise value per user',true],['gmv','P / GMV','P / GMV','年度 GMV','Annual GMV','目标 P/GMV','Target P/GMV',false],['reserves','EV / 储量','EV / reserves','权益可采储量（统一单位）','Attributable recoverable reserves (consistent units)','每单位储量企业价值','Enterprise value per reserve unit',true]].map(([key,zh,en,qz,qe,mz,me,ev])=>({key,label:{zh,en},fields:[field('quantity',qz,qe),field('unitValue',mz,me,'dual'),...(ev?[nd(),money('otherClaims','其他非普通股索偿','Other non-common claims','single',0)]:[])]}));
const SECTOR={key:'sector',group:'relative',label:{zh:'行业特定乘数',en:'Sector-specific multiples'},fields:SECTOR_MODES[0].fields,modes:SECTOR_MODES,defaultMode:'users',
  guidance:{zh:'用户数须统一活跃定义和日期；GMV 是交易额而非收入；储量须统一商品、品位、可采性和单位。EV/用户与EV/储量减净负债；P/GMV直接得到股权价值。',en:'Align active-user definitions and dates. GMV is transaction volume, not revenue. Align commodity, grade, recoverability and reserve units. EV/user and EV/reserves subtract net debt; P/GMV gives equity directly.'},
  compute(v,c){if(!pos(v.quantity)||!nonneg(v.unitValue))return null;const ev=(v._mode||'users')!=='gmv';if(ev&&(!num(v.netDebt)||!nonneg(v.otherClaims)))return null;return shareValue(v.quantity*v.unitValue-(ev?v.netDebt+v.otherClaims:0),c);},
  breakdown(v){return[row('gross',v._mode==='gmv'?'股权价值':'企业价值',v._mode==='gmv'?'Equity value':'Enterprise value',pos(v.quantity)&&nonneg(v.unitValue)?v.quantity*v.unitValue:null)];}
};
export const EXTENDED=[APV,OPTIONS,LIQUIDATION,NCAV,EVSALES,Q,SECTOR];
