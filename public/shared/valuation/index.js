/**
 * valuation/index.js — 估值模型注册表 + 运行器（glue）。
 * 组合内在价值组（intrinsic.js）与相对估值组（relative.js），
 * 提供统一的 MODELS 列表与 runModel(model, form, ctx)。
 */
import { INTRINSIC } from "./intrinsic.js";
import { RELATIVE } from "./relative.js";
import { RESOURCE } from "./resource.js";
import { EXTENDED } from "./extended.js";
import { SOTP } from "./sotp.js";

// 列表顺序即 UI 方法选择条的顺序。
export const MODELS = [...INTRINSIC, ...RESOURCE, ...RELATIVE, ...EXTENDED, SOTP];

// 分类只描述已实现的计算器；SOTP 是组合框架，不是资源 NAV 的别名。
export const METHOD_MENU_GROUPS = [
  {
    key: "intrinsic",
    title: { zh: "内在估值 · 现金流折现", en: "Intrinsic valuation · Discounted cash flows" },
    description: { zh: "从增长、利润率、再投资与风险推导价值，现金流必须匹配折现率。", en: "Estimate value from growth, margins, reinvestment and risk; match cash flows to the discount rate." },
    methods: [
      { key: "fcff", title: { zh: "FCFF 企业现金流", en: "FCFF · Firm valuation" }, category: { zh: "企业价值 → 股权价值", en: "Enterprise → equity" }, subtitle: { zh: "从收入、营业利润率和再投资预测 FCFF，以 WACC 折现后减净负债。", en: "Forecast FCFF from revenue, operating margins and reinvestment; discount at WACC, then subtract net debt." } },
      { key: "fcf", title: { zh: "简化 FCFF · 直接现金流", en: "Simplified FCFF · Direct cash flow" }, category: { zh: "企业价值 → 股权价值", en: "Enterprise → equity" }, subtitle: { zh: "直接预测企业自由现金流，以 WACC 折现；财报现金流需先核对利息和再投资口径。", en: "Forecast firm cash flow directly and discount at WACC; reconcile interest and reinvestment in reported cash flows." } },
      { key: "fcfe", title: { zh: "FCFE 股权现金流", en: "FCFE · Equity valuation" }, category: { zh: "股权价值", en: "Equity value" }, subtitle: { zh: "从净利润和股权再投资推导 FCFE，以股权成本折现，不再扣净负债。", en: "Derive FCFE from earnings and equity reinvestment; discount at cost of equity without another debt deduction." } },
      { key: "ddm", title: { zh: "DDM 股息折现", en: "DDM · Dividend discount" }, category: { zh: "股权价值", en: "Equity value" }, subtitle: { zh: "以股权成本折现股息，适合分红可预测且能代表股东分配能力的公司。", en: "Discount dividends at cost of equity when payouts are predictable and represent distributable capacity." } },
      { key: "navsotp", title: { zh: "资源股 NAV · 资产现金流", en: "Resource NAV · Asset cash flows" }, category: { zh: "有限寿命资产", en: "Finite-life assets" }, subtitle: { zh: "按矿山产量、成本和寿命折现并加总；支持未开发储量期权和手填资产价值，不是通用 SOTP 或清算模型。", en: "Discount mine output, costs and life, plus undeveloped reserve options and manually valued assets; not a generic SOTP or liquidation calculator." } },
    ],
  },
  {
    key: "relative",
    title: { zh: "相对估值 · 市场定价", en: "Relative valuation · Market pricing" },
    description: { zh: "用可比资产的倍数定价；盈利口径、报告期、风险和增长质量必须可比。", en: "Price against comparable assets; align earnings definitions, periods, risk and growth quality." },
    methods: [
      { key: "pe", title: { zh: "P/E 市盈率", en: "P/E · Earnings multiple" }, category: { zh: "盈利倍数 · 股权", en: "Earnings · equity" }, subtitle: { zh: "用净利润或 EPS 乘目标 PE；经调整利润属于输入口径，需核对调整项及稀释。", en: "Apply target P/E to earnings or EPS; adjusted earnings are an input basis requiring reconciliation and dilution checks." } },
      { key: "peg", title: { zh: "PEG 增长校准", en: "PEG · Growth adjustment" }, category: { zh: "盈利倍数 · 辅助比较", en: "Earnings · cross-check" }, subtitle: { zh: "PEG = PE ÷ 预期盈利增速百分数；用于辅助比较，1 或 1–2 不是通用合理标准。", en: "PEG = P/E divided by expected earnings growth in percentage points; neither 1 nor 1–2 is a universal fair range." } },
      { key: "evebitda", title: { zh: "EV/EBITDA 企业倍数", en: "EV/EBITDA · Enterprise multiple" }, category: { zh: "盈利倍数 · 企业", en: "Earnings · enterprise" }, subtitle: { zh: "EBITDA 乘倍数后减净负债；仍需比较资本开支、租赁和税负，EBITDA 不是现金流。", en: "Apply the multiple to EBITDA, then subtract net debt; compare capex, leases and taxes. EBITDA is not cash flow." } },
      { key: "pb", title: { zh: "P/B 市净率", en: "P/B · Book-value multiple" }, category: { zh: "账面价值倍数 · 股权", en: "Book value · equity" }, subtitle: { zh: "每股净资产乘目标 PB，结合可持续 ROE 和资产质量判断；不是资产清算价值。", en: "Apply target P/B to book equity per share, considering sustainable ROE and asset quality; not liquidation value." } },
      { key: "ps", title: { zh: "P/S 市销率", en: "P/S · Sales multiple" }, category: { zh: "收入倍数 · 股权", en: "Revenue · equity" }, subtitle: { zh: "收入乘目标 PS 得股权价值；需比较利润率与杠杆，不等同于 EV/Sales。", en: "Revenue times target P/S gives equity value; compare margins and leverage. This is not EV/Sales." } },
    ],
  },
];

const extendedMeta = (key, categoryZh, categoryEn, zh, en) => {
  const model = MODELS.find(m => m.key === key);
  return { key, title: model.label, category: { zh: categoryZh, en: categoryEn }, subtitle: { zh, en } };
};
METHOD_MENU_GROUPS[0].methods.push(extendedMeta("apv", "企业价值 → 股权价值", "Enterprise → equity", "无杠杆业务价值 + 税盾及融资效应 − 困境成本；支持分期偿债或到期还本。", "Unlevered operations plus tax shields and financing effects, less distress costs; amortizing or bullet debt."));
METHOD_MENU_GROUPS[1].methods.push(
  extendedMeta("evsales", "收入倍数 · 企业", "Revenue · enterprise", "营收乘企业收入倍数后扣净负债，适合与可比公司的利润率及增长预期一起研究。", "Apply an enterprise sales multiple, then subtract net debt; compare margins and growth."),
  extendedMeta("tobinq", "重置成本倍数 · 企业", "Replacement cost · enterprise", "以经营资产重置成本和目标 Q 定价，再转为股权价值；重置成本需独立估计。", "Price operating replacement cost using target Q, then bridge to equity; estimate replacement cost separately."),
  extendedMeta("sector", "行业特定乘数", "Sector-specific multiples", "支持 EV/用户、P/GMV、EV/储量；明确单位和企业/股权口径。", "EV/user, P/GMV and EV/reserves, with explicit units and enterprise/equity bases.")
);
METHOD_MENU_GROUPS.push(
  { key:"contingent", title:{zh:"或有权益 · 期权估值",en:"Contingent claims · Option valuation"}, description:{zh:"对具有行权成本、期限和选择权的资产建模，明确期权近似的适用条件。",en:"Model assets with exercise costs, expiry and optionality; check the approximation's assumptions."}, methods:[extendedMeta("options","项目期权 / 困境股权","Project options / distressed equity","Black–Scholes 看涨期权近似，支持项目叠加与困境企业股权两种口径。","Black–Scholes call approximation for projects and distressed company equity.")] },
  { key:"asset", title:{zh:"资产基础 · 清算与净流动资产",en:"Asset-based · Liquidation and NCAV"}, description:{zh:"从资产可回收价值和负债索偿出发，区分账面数据与变现假设。",en:"Start from realizable assets and claims; separate book figures from recovery assumptions."}, methods:[extendedMeta("liquidation","资产回收 → 普通股","Asset recovery → common equity","分别估计应收、存货及长期资产回收率，扣除负债、清算成本与等待时间影响。","Estimate receivable, inventory and long-lived asset recoveries, liabilities, costs and timing."),extendedMeta("ncav","净流动资产","Net current asset value","流动资产减全部负债和优先索偿，可设置采用比例；不把负 NCAV 当正价值。","Current assets minus all liabilities and senior claims, with an explicit chosen fraction.")] },
  { key:"combination", title:{zh:"组合框架 · 分部加总",en:"Combination framework · SOTP"}, description:{zh:"各业务选择不同方法，统一现值、持股比例、币种和集团调整后汇总。",en:"Use different methods by business; reconcile present value, ownership, currencies and group adjustments."}, methods:[extendedMeta("sotp","多业务股权现值汇总","Multi-business equity PV","支持 PE、PS、EV 倍数、DCF、资产法和已评估现值；集团折价由你决定。","Combine PE, PS, EV multiples, DCF, asset methods and appraised present values; justify any holding discount.")] }
);

export const METHOD_FRAMEWORK_NOTES = [
  {key:"apv_scope",title:{zh:"APV 的债务计划",en:"APV debt schedule"},description:{zh:"支持等额还本和到期一次还本。税盾只计算到债务到期；续借、发行费用等额外融资影响可填现值，避免重复计入。",en:"Equal principal or bullet repayment. Shields end at maturity; separately value refinancing or issue costs without double counting."}},
  {key:"option_scope",title:{zh:"期权模型的适用条件",en:"Option-model assumptions"},description:{zh:"采用欧式 Black–Scholes 近似，不是临床概率树或美式提前行权模型。高不确定性本身并不代表 DCF 失效。",en:"Uses a European Black–Scholes approximation, not a clinical probability tree or American early-exercise model. Uncertainty alone does not invalidate DCF."}},
  {key:"sotp_scope",title:{zh:"SOTP 的集团调整",en:"SOTP group reconciliation"},description:{zh:"每个分部先得到股权现值，再乘持股比例及汇率。集团层面只扣未分配净负债与总部成本；不强制扣控股折价。",en:"Convert each business to equity PV before applying ownership and FX. Group adjustments only include unallocated debt and costs; no mandatory holding discount."}},
];
export const METHOD_RULES = "分类口径：FCFF 与简化 FCFF（fcf）用企业现金流和 WACC，扣一次净负债；FCFE/DDM 用股权成本，不重复扣净负债。APV 用无杠杆资本成本，税盾单独折现且到债务到期为止。资源股 NAV（navsotp）含未开发储量 Black–Scholes 组件，不是通用 SOTP。通用 SOTP 用 sotp，各分部先转股权现值、乘持股比例及汇率，只扣未分配的集团净负债，折价默认0。SOTP 分部结构由用户在参数页添加并选择方法，AI 只建议已有数字字段，不得把集团收入或利润填到每个分部。P/E、PEG、EV/EBITDA、P/B、P/S、EV/Sales、Q 和行业乘数是相对定价。PEG = PE ÷ 预期盈利增速百分数，没有通用合理阈值。经调整 PE 是盈利口径，非现金调整不自动等于无经济成本。P/S 与 P/GMV 直接得到股权价值，EV 倍数需要扣净负债。清算价值用回收率、时间和费用，NCAV 用流动资产减全部负债及优先索偿。options 使用欧式 Black–Scholes 近似，项目模式加期权再转股权，困境模式直接算股权不再扣债。所有模型只能从已提供数据或用户假设取值，缺失数据待补，不能用示例参数充当事实。";

const METHOD_META = new Map(METHOD_MENU_GROUPS.flatMap((group) => group.methods.map((method) => [method.key, method])));

export function methodMenuMeta(model) {
  if (!model) return null;
  return METHOD_META.get(model.key) || null;
}

// 取某模型在某口径下的字段;无 modes 的模型回退到 model.fields。
export function modeFields(model, mode, form = {}) {
  if (model.fieldsFor) return model.fieldsFor(form);
  if (!model.modes) return model.fields || [];
  const key = mode || model.defaultMode || model.modes[0].key;
  const m = model.modes.find((x) => x.key === key) || model.modes.find((x) => x.key === model.defaultMode) || model.modes[0];
  return m.fields;
}

/**
 * 用保守/乐观两套假设各跑一次 compute，得到低~高每股合理价值。
 * @param {Object} model  模型对象（含 fields 或 modes + compute）
 * @param {Object} form   { [fieldKey]: Number(single) | {c:Number,o:Number}(dual) }
 * @param {Object} ctx    { price, epsTtm, bps, shares, dividendYield }
 * @returns {{low:Number|null, high:Number|null}}
 */
export function runScenario(model, form, ctx, scenario) {
  if (!["c", "o"].includes(scenario)) return null;
  if (typeof model.run === "function") {
    const result = model.run(form, ctx);
    return safe(scenario === "c" ? result?.low : result?.high);
  }
  const values = { ...(form._parts ? { _parts: form._parts } : {}) };
  const fields = modeFields(model, form._mode || model.defaultMode, form);
  for (const field of fields) values[field.k] = field.col === "dual" ? form[field.k]?.[scenario] : form[field.k];
  if (model.modes) values._mode = form._mode || model.defaultMode;
  try { return safe(model.compute(values, ctx)); } catch { return null; }
}

export function runModel(model, form, ctx) {
  // 自跑型模型（如 NAV/SOTP：每资产各自增速、求和后取区间）自带 run()，跳过通用 cons/opt 拆分。
  if (typeof model.run === "function") return model.run(form, ctx) || { low: null, high: null };
  const cons = { ...(form._parts ? { _parts: form._parts } : {}) };
  const opt = { ...(form._parts ? { _parts: form._parts } : {}) };
  const fields = modeFields(model, form._mode || model.defaultMode, form);
  for (const field of fields) {
    const v = form[field.k];
    if (field.col === "dual") {
      cons[field.k] = v && typeof v === "object" ? v.c : NaN;
      opt[field.k] = v && typeof v === "object" ? v.o : NaN;
    } else {
      cons[field.k] = v;
      opt[field.k] = v;
    }
  }
  if (model.modes) { cons._mode = opt._mode = form._mode || model.defaultMode; }

  const a = safe(model.compute(cons, ctx));
  const b = safe(model.compute(opt, ctx));

  // 仅当两套假设都算出有限值，才形成一个区间；否则视为输入不完整。
  if (a === null || b === null) return { low: null, high: null };
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

function safe(v) {
  return (typeof v === "number" && isFinite(v)) ? v : null;
}
