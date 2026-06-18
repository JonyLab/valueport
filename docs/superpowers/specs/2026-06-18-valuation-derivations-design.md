# 估值输入「展开推导」框架 — 设计

日期:2026-06-18
状态:已通过 brainstorm,待实现计划

## 背景与目标

ValuePort 的估值模型里,有些输入是"事实"(营收、净利、净负债、当前 FCF)——这些已有**参考筹码**从财报取口径值;另一些是"假设"(折现率、增速、目标倍数)——目前只能凭感觉填一个数。

本特性给"假设型"输入加一个**可选的「展开推导」面板**:把一个拍脑袋的数,搭成几个各自更可估的分量,使假设变得可解释、可辩护、可复盘。灵感来自卖方研报的 WACC build-up / 收入桥,以及价值投资者对"为什么是这个数"的执着。

首批做三个推导,统一进一个框架:

1. **折现率推导(CAPM)**
2. **营收增速推导(行业 + 份额 + 提价)**
3. **目标倍数推导(历史/同业分位重估)**

## 关键决策(brainstorm 结论)

- **每个分量都分 保守|乐观**,直接产出一对低~高值,写回字段的双输入(最严谨)。
- **目标倍数**用**历史/同业分位重估**(锚点引导),不用 Gordon 基本面合理倍数。
- **推导过程持久化**:各分量数值随卡片存档,重开卡片能看到完整 build-up。
- **架构 A:统一注册表 + 通用渲染器**(`DERIVATIONS` 注册表,按字段 meta 挂载)。

## 交互

- 在每个"有推导可用"的双输入字段下,加一个 `▾ 推导` 折叠开关。
- 展开后是小面板:
  - **求和型**(折现率、营收增速):每个分量一行,带 **保守|乐观** 两列(沿用"情景假设"卡的 `.vc-arow` 样式);面板底部实时显示 `= 保守 X / 乐观 Y`。
  - **锚点引导型**(目标倍数):顶部展示数据锚点(当前 / 自身5年均 / 行业中位)作参考筹码;下方用户填 **保守目标 / 乐观目标**,可一键套用任一锚点。
- 推导结果**自动写回**该字段的保守/乐观两格;字段两格仍可见、可手动改。
- **解除**:一旦手动改字段输入 → 该字段的推导自动解除(清空 `derivations[fieldKey]`、收起面板),与"估值卡片设为/取消合理区间"的解除逻辑一致。
- 语义统一:**保守列 → 更不利的估值**(更高折现率 / 更低增速 / 更低倍数)。与现有字段双输入语义一致,无需特殊处理——推导的保守列直接喂字段的保守格。

## 三个推导的分量与公式

### ① 折现率推导(CAPM) — 求和型
核心:`股权成本 Ke = Rf + β × ERP`

- 分量(各分 保守|乐观):无风险利率 `Rf`、贝塔 `β`、股权风险溢价 `ERP`
- **公司层**(meta `wacc`,FCFF / 现金流折现)额外两分量:税后债务成本 `Kd`、股权权重 `E%`
  - `WACC = Ke × E% + Kd × (1 − E%)`
- **股权层**(meta `costOfEquity`,FCFE / DDM):只算到 `Ke`,不显示债务段
- 默认值(可改,标注"默认值·按需改"):`Rf ≈ 3%`、`β = 1.0`、`ERP ≈ 5%`、`Kd ≈ 3%`、`E% = 100%`(无债)
- 数据:无实时 Rf/β/ERP 源,用可改默认值;以后可再接

### ② 营收增速推导(行业 + 份额 + 提价) — 求和型
`本块增速 = 行业增速 + 份额贡献 + 提价/结构贡献`

- 分量(各分 保守|乐观):行业增速(市场 β)、份额贡献(抢/丢份额 α)、提价/结构
- 默认值:空 / 0,纯手填;每项配 ⓘ 提示
- 应用于 meta `revGrowth`(FCFF、PE、PS)

### ③ 目标倍数推导(历史/同业分位重估) — 锚点引导型
- 锚点(单值、来自数据、只作参考):**当前倍数 / 自身5年均 / 行业中位**——复用现有倍数参考筹码的数据(`buildValuationRefs`)
- 输出:用户定 **保守目标 / 乐观目标**,可一键套用任一锚点
- 应用于 meta `targetPE`(PE)、`targetPB`(PB)、`targetPS`(PS)、`targetMultiple`(EV-EBITDA)
- 该面板**收编**这些字段上现有的零散倍数筹码,把锚点集中进来

## 字段挂载映射

| 推导 | meta 标签 | 出现模型 | 形态 |
|---|---|---|---|
| 折现率(CAPM,含债务) | `wacc` | FCFF、现金流折现 | 求和 |
| 折现率(CAPM,纯股权) | `costOfEquity` | FCFE、DDM | 求和 |
| 营收增速 | `revGrowth` | FCFF、PE、PS | 求和 |
| 目标倍数 | `targetPE`/`targetPB`/`targetPS`/`targetMultiple` | PE/PB/PS/EV-EBITDA | 锚点 |

## 数据结构与存储

卡片新增 `derivations` 对象,与 `inputs` 并存:

```js
card.derivations = {
  [fieldKey]: {
    method: "capm" | "revGrowth" | "multipleAnchor",
    parts: { [componentKey]: { c: Number, o: Number } }
  }
}
```

- `inputs[fieldKey]` 始终保存推导算出的 `{c, o}`(runModel 不变,照常读 `form[fieldKey].c/.o`)。
- 服务端 `validateValuations`(`src/items.js`)放行 `derivations`:校验为对象即存(轻校验,与 `inputs` 同等宽松);非对象则丢弃为 `{}`。
- 重开卡片:有 `derivations[fieldKey]` 则展开面板、回填各分量,并据此重算写回 `inputs`。

## 架构(A:统一注册表)

新建 `public/shared/valuation/derivations.js`:

```js
export const DERIVATIONS = {
  capm:           { shape:"sum",    appliesToMeta:["wacc","costOfEquity"], components:[...], compute(parts, opts) {...} },
  revGrowth:      { shape:"sum",    appliesToMeta:["revGrowth"],           components:[...], compute(parts) {...} },
  multipleAnchor: { shape:"anchor", appliesToMeta:["targetPE","targetPB","targetPS","targetMultiple"], anchorsFrom(refData, meta) {...} },
}
// 按字段 meta 查推导
export function derivationForMeta(meta) {...}
```

- 每个推导描述符声明:形态、挂载 meta、分量(求和型)或锚点取数(锚点型)、`compute(parts) -> {c, o}`(对保守/乐观各算一次)。
- `valuation-ui.js` 在 `renderForm` 的双字段渲染处,若 `derivationForMeta(field.meta)` 命中,挂上 `▾ 推导` 折叠 + 通用子面板;子面板按 `shape` 走两种渲染分支;计算结果写回字段双输入并更新 `card.derivations`。
- `capm` 的债务段是否显示:看挂载的 meta 是 `wacc`(显示)还是 `costOfEquity`(隐藏)。

## 本批不做(YAGNI)

- 基本面合理倍数(Gordon)——日后作目标倍数第二子模式
- 反推 / Reverse DCF——独立模式,路线图
- 分部加总 SOTP——路线图
- 二档其他推导:利润率推导、永续增速/终值体检、当前 FCF 正常化
- 非营收类增速(净利/现金流/股利/EBITDA 增速)的分解——本批只做 `revGrowth`
- β/Rf/ERP 接实时数据源——本批用可改默认值
- 投资论点 + 检验闭环——独立特性,不混入本框架

## 测试

`test-core/` 新增:
- `capm.compute`:`Ke = Rf + β×ERP`;`wacc` 含债务加权;`costOfEquity` 不含
- `revGrowth.compute`:三项求和
- `multipleAnchor`:锚点透传 / 套用
- 保守/乐观各算一次 → 写回 `{c, o}` 正确;`runModel` 接到的 form 不变

## i18n

所有新分量标签、锚点标签、提示文案中英双语(`public/shared/i18n.js` 或就近的双语对象,沿用现有 `field-meta.js` / valuation-ui 文案风格)。
