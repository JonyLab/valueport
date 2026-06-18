/**
 * valuation/derivations.js — 估值「假设型」输入的展开推导注册表。
 * 按字段 meta 挂载;valuation-ui 据此渲染 ▾ 推导 面板。
 *   shape "sum"   : 分量求和（各分量分保守|乐观）,compute(parts,{meta}) → 单情景值
 *   shape "anchor": 锚点引导（目标倍数）,无 compute,面板复用 fieldReference 锚点筹码
 */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export const CAPM = {
  id: "capm", shape: "sum", appliesToMeta: ["wacc", "costOfEquity"],
  components: [
    { key: "rf",   label: { zh: "无风险利率", en: "Risk-free rate" }, unit: "%", default: 3 },
    { key: "beta", label: { zh: "β（贝塔）", en: "Beta" }, unit: "", default: 1 },
    { key: "erp",  label: { zh: "股权风险溢价", en: "Equity risk premium" }, unit: "%", default: 5 },
    { key: "kd",   label: { zh: "税后债务成本", en: "After-tax cost of debt" }, unit: "%", default: 3, debtOnly: true },
    { key: "ew",   label: { zh: "股权权重", en: "Equity weight" }, unit: "%", default: 100, debtOnly: true },
  ],
  componentsFor(meta) { return this.components.filter((c) => meta === "wacc" || !c.debtOnly); },
  compute(parts, opts) {
    const ke = num(parts.rf) + num(parts.beta) * num(parts.erp);
    if (opts && opts.meta === "wacc") {
      const ew = num(parts.ew) / 100;
      return ke * ew + num(parts.kd) * (1 - ew);
    }
    return ke;
  },
};

export const REV_GROWTH = {
  id: "revGrowth", shape: "sum", appliesToMeta: ["revGrowth"],
  components: [
    { key: "industry", label: { zh: "行业增速", en: "Industry growth" }, unit: "%", default: "", hint: { zh: "该品类/行业的市场增速（β）", en: "Category/market growth (β)" } },
    { key: "share",    label: { zh: "份额贡献", en: "Share gain" }, unit: "%", default: "", hint: { zh: "抢/丢市场份额带来的增减（α）", en: "From gaining/losing share (α)" } },
    { key: "price",    label: { zh: "提价/结构", en: "Price / mix" }, unit: "%", default: "", hint: { zh: "提价与产品结构升级带来的增量", en: "Price hikes and mix upgrade" } },
  ],
  componentsFor() { return this.components; },
  compute(parts) { return num(parts.industry) + num(parts.share) + num(parts.price); },
};

export const MULTIPLE_ANCHOR = {
  id: "multipleAnchor", shape: "anchor",
  appliesToMeta: ["targetPE", "targetPB", "targetPS", "targetMultiple"],
};

const ALL = [CAPM, REV_GROWTH, MULTIPLE_ANCHOR];

export function derivationForMeta(meta) {
  return ALL.find((d) => d.appliesToMeta.includes(meta)) || null;
}
