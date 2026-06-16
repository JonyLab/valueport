# 设计：估值研究 tab 的 Damodaran 估值计算器套件

日期：2026-06-16　（详情页 spec 的扩展）

## 目标

在标的详情页「估值研究」tab 的摘要下方，加入一组 **Damodaran 风格的估值计算器**：选方法 → 关键假设按「保守 | 乐观」双列输入 → **一次**算出 **低 ~ 高** 每股合理价值 → **一键应用**为标的的 `fairLow`/`fairHigh`（即时驱动钟摆、随标的保存）。

- 能预填的用现有数据（现价 `price`、`epsTtm`、`bps`、`shares`、`dividendYield`）；其余是用户假设输入。
- 假设**不持久化**（临时算稿）；只有应用后的区间随 `saveItem` 持久化。
- **应用按钮仅主人可见**；访客可算不可存。
- PE/PEG/PB/PS/EV-EBITDA = 相对乘数；FCFF/FCFE/DDM = 内在折现。PE/PS 不折现（n 年后目标值）；FCFF/FCFE/DDM 折现到现在。

## 合约（所有 agent 必须严格遵守）

### 预填上下文 `ctx`
```js
ctx = { price:Number, epsTtm:Number, bps:Number, shares:Number, dividendYield:Number } // 均可能为 0/NaN
```

### 模型对象（每个方法一个）
```js
{
  key: "fcff",                          // 唯一标识
  group: "intrinsic" | "relative",
  label: { zh: "FCFF 两阶段", en: "FCFF (2-stage)" },
  fields: [
    { k:"revenue", label:{zh:"当前营收", en:"Current revenue"}, col:"single",
      unit:"", prefill:(ctx)=>"" , hint:{zh:"公司总营收（不是每股）", en:"Total, not per share"} },
    { k:"growth",  label:{zh:"营收增速", en:"Revenue growth"}, col:"dual", unit:"%" },
    // ...
  ],
  // vals: 扁平对象 { [fieldKey]: Number }（某一情景的取值）；返回每股合理价值或 null（无效，如 r≤g∞）
  compute(vals, ctx) { return Number | null; }
}
```
- `col:"single"` → 单输入；`col:"dual"` → 保守|乐观两输入。
- `unit`：`"%"` 表示百分比（用户填 20 表示 20%，compute 内部自行 /100）；`""` 普通数（倍数、年数、金额、每股值）。
- `prefill(ctx)`：返回该字段初始值（数字）或 `""`（不预填）。仅 single 字段会预填；dual 字段不预填。
- 金额类（revenue/fcf/netIncome/ebitda/netDebt）单位 = 总额（与 price×shares 同量纲）；per-share 类（eps/bps/dps）= 每股；倍数/比率（PE/PB/PS/PEG/EV倍数/salesToCap）= 纯数；增速/利润率/税率/折现率/永续增速 = 百分数。

### 运行器（我写在 `valuation/index.js`）
```js
runModel(model, form, ctx) → { low:Number|null, high:Number|null }
// form[k] = Number（single）或 {c:Number, o:Number}（dual）
// consVals: single→form[k]; dual→form[k].c    optVals: dual→form[k].o
// a = model.compute(consVals,ctx); b = model.compute(optVals,ctx)
// 过滤 null/NaN/非有限；都有效则 low=min(a,b), high=max(a,b)；否则对应为 null
```

## 八个模型的精确公式

记号：`g,m,tax,r,g∞` 等百分数在 compute 内 `/100`；`n` 年数；`shares=ctx.shares`。

### 相对（relative.js）
1. **PE** — fields: `revenue`(single), `n`(single,默认5), `growth`%(dual), `netMargin`%(dual), `targetPE`(dual)
   `futRev=revenue*(1+g)^n; eps=futRev*netMargin/shares; return eps*targetPE`
2. **PEG** — fields: `eps`(single, prefill=ctx.epsTtm), `growth`%(dual), `peg`(dual,默认1)
   `impliedPE=peg*(g*100)`（g 为百分数本身，如 20）→ 实现为 `impliedPE=peg*growthPercentNumber`；`return eps*impliedPE`
   （即 PEG×增速数字；增速 20% 记作 20）
3. **PB** — fields: `bps`(single, prefill=ctx.bps), `targetPB`(dual)　`return bps*targetPB`
4. **PS** — fields: `revenue`(single), `n`(single,5), `growth`%(dual), `targetPS`(dual)
   `futRev=revenue*(1+g)^n; return futRev*targetPS/shares`
5. **EV/EBITDA** — fields: `ebitda`(single), `n`(single,5), `growth`%(dual), `targetMultiple`(dual), `netDebt`(single,默认0)
   `futEbitda=ebitda*(1+g)^n; ev=futEbitda*targetMultiple; return (ev-netDebt)/shares`

### 内在（intrinsic.js）
6. **FCFF 两阶段** — fields: `revenue`(single), `n`(single,默认10), `growth`%(dual,高增长), `opMargin`%(dual,目标营业利润率), `taxRate`%(single,默认25), `salesToCap`(dual,销售资本比,默认2), `wacc`%(dual,默认9), `termGrowth`%(dual,默认2.5,需 < wacc), `netDebt`(single,默认0)
   ```
   PV=0; prev=revenue;
   for t=1..n: rev=revenue*(1+g)^t; nopat=rev*opMargin*(1-tax);
               reinvest=(rev-prev)/salesToCap; fcff=nopat-reinvest;
               PV+=fcff/(1+wacc)^t; prev=rev;
   revN=revenue*(1+g)^n; revT=revN*(1+g∞); nopatT=revT*opMargin*(1-tax);
   reinvestT=(revT-revN)/salesToCap; fcffT=nopatT-reinvestT;
   if(wacc<=g∞) return null;
   TV=fcffT/(wacc-g∞); PV+=TV/(1+wacc)^n;
   return (PV-netDebt)/shares;
   ```
7. **FCFE 两阶段** — fields: `netIncome`(single, prefill=ctx.epsTtm*ctx.shares), `growth`%(dual), `reinvestRate`%(dual,股权再投资率占净利,默认40), `costOfEquity`%(dual,默认9), `n`(single,默认10), `termGrowth`%(dual,默认2.5,需<ke)
   ```
   PV=0;
   for t=1..n: ni=netIncome*(1+g)^t; fcfe=ni*(1-reinvestRate); PV+=fcfe/(1+ke)^t;
   niN=netIncome*(1+g)^n; fcfeT=niN*(1+g∞)*(1-reinvestRate);
   if(ke<=g∞) return null;
   TV=fcfeT/(ke-g∞); PV+=TV/(1+ke)^n;
   return PV/shares;
   ```
8. **DDM 两阶段** — fields: `dps`(single, prefill=ctx.price*ctx.dividendYield/100), `growth`%(dual,高增长), `n`(single,默认5), `costOfEquity`%(dual,默认9), `termGrowth`%(dual,默认2.5,需<ke)
   ```
   PV=0;
   for t=1..n: d=dps*(1+g)^t; PV+=d/(1+ke)^t;
   dT=dps*(1+g)^n*(1+g∞);
   if(ke<=g∞) return null;
   TV=dT/(ke-g∞); PV+=TV/(1+ke)^n;
   return PV;   // 已是每股
   ```

无效输入（NaN、shares≤0、分母≤0）→ compute 返回 null。

## 文件结构
- `public/shared/valuation/relative.js` **(Agent B)** — `export const RELATIVE = [PE,PEG,PB,PS,EVEBITDA]`
- `public/shared/valuation/intrinsic.js` **(Agent A)** — `export const INTRINSIC = [FCFF,FCFE,DDM]`
- `public/shared/valuation/index.js` **(我)** — `import` 两组，`export const MODELS=[...INTRINSIC,...RELATIVE]; export function runModel(model,form,ctx){...}`
- `public/shared/valuation-ui.js` **(Agent C)** — `export function mountValuationCalc(mount, ctx, { onApply, canApply, lang })`
- `public/index.html` **(我)** — 在 `renderDetail` 的「估值研究」面板调用 `mountValuationCalc`，`onApply=(low,high)=>{ item.cfg.fairLow=low; item.cfg.fairHigh=high; renderDetail 内的钟摆 set + renderItemHead + saveItem }`

## UI 规格（Agent C，`valuation-ui.js`）
`mountValuationCalc(mount, ctx, { onApply, canApply, lang })`：
- 顶部一排方法选择（MODELS 的 label[lang]），点选切换。
- 选中方法渲染表单：single 字段一行一个输入；dual 字段一行两个输入（左「保守」右「乐观」，带列头）。带 `prefill`、`unit`（%后缀显示）、`hint`。
- 输入 `input` 事件 → 调 `runModel` 实时计算 → 显示 **低 X ~ 高 Y**（用 `toFixed(2)`，无效显示「—」）。
- 一个「应用为合理区间 / Apply as fair range」按钮：仅 `canApply` 时显示；点按 `onApply(low, high)`（仅当 low,high 均有效）。
- 纯静态文案（保守/乐观/低/高/应用为合理区间/合理价值/方法）用模块内 `{zh,en}[lang]` 小字典，不改 i18n.js（避免文件冲突）。
- 样式 class 前缀 `vc-`（valuation calc）；我会在 index.html 里补 `.vc-*` 的 CSS。Agent C 只产出结构与逻辑，className 用：`vc-methods`/`vc-method`(`.on`)/`vc-form`/`vc-row`/`vc-label`/`vc-input`/`vc-cols`/`vc-colhead`/`vc-out`/`vc-out-low`/`vc-out-high`/`vc-apply`。
- `runModel`/`MODELS` 从 `"/shared/valuation/index.js"` import。

## 测试与验证
- Agent A/B 各为自己的 compute 写最小单测（`test/valuation-*.test.js`，纯函数，断言一两个已知算例）。现有 58 测试须保持。
- 集成后浏览器手测：每个方法填假设→低~高合理；应用→钟摆区间更新+保存；访客无应用按钮；中英文。

## 范围外
期权式估值、行业回归相对估值、beta/ERP/无风险利率自动取数、金融机构专用超额收益模型。
