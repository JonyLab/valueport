# 设计：估值参数的「参考数据 + 估值提示」

日期：2026-06-17

## 目标

在估值计算弹窗里，为每个参数提供两层帮助：

1. **参考数据**（可点击回填的小筹码）：从财报序列 / 行业估值分布算出的客观参考（如净利率「最新 27.2% · 5年均 24.5%」、目标 PE「当前 35.9x · 自身5年均 31.2x · 行业中位 26.4x」）。
2. **估值提示**（标签旁 ⓘ 点击弹出）：教用户「怎么定这个值」的方法论（如增速看市场空间×渗透率×份额；WACC=股权成本×权重+税后债务成本×权重）。

默认表单清爽：提示藏在 ⓘ 里、参考是输入框下一行小筹码；数据缺失则不显示参考。中英双语。

## 已实测确认的数据源（`.dev.vars` 真凭据）

- `GET /v1/quote/financial-reports`（已接入）：IS/BS/CF 多期序列。字段：`OperatingRevenue`、`NetProfit`、`OperatingIncome`、`EPS`、`NetProfitMargin`、`GrossMgn`、`ROE`（IS）；`NetFreeCashFlow`（CF）等。
- `GET /v1/quote/industry-valuation-distribution`（counter_id）：按 `pe/pb/ps` 返回 `{ low, high, median, value(个股当前), ranking, rank_index, rank_total }`。→ 行业中位 + 个股当前。
- `GET /v1/quote/industry-valuation-comparison`（counter_id）：`data.list[]`，首条为个股自身，含 `pe/pb/ps` 当前值与 `history:[{date,pe,pb,ps}]`（季度序列）。→ 个股自身 5 年均倍数。
- 签名沿用 `getOtp` 模式；counter_id = `symbolToCounterId`。

## 架构

集中到一个纯模块，模型字段只挂标签：

- `public/shared/field-meta.js`（新，纯函数，可测）：
  - `export const FIELD_META = { <tag>: { guide:{zh,en}, ref?:<refTag> }, ... }` —— 所有「提示文案」与「参考标签」集中于此。
  - `export function fieldReference(refTag, data, ctx, lang) → { unit:"%"|"x", chips:[{label, value}] } | null` —— 参考数据计算。`data = { financials, valuationRefs }`。
- 模型字段（`valuation/intrinsic.js`、`valuation/relative.js`）：每个字段加 `meta:"<tag>"`。
- 服务端（`src/longbridge.js` + `/api/financials`）：年报那次顺带取行业两端点，算出 `valuationRefs` 一并返回。
- 编辑器（`valuation-ui.js`）：按 `FIELD_META[field.meta]` 渲染 ⓘ 提示 + 参考筹码（点击回填保守&乐观）。

## 服务端数据层（`src/longbridge.js`）

- `fetchLongbridgeValuationDist(env, tencentSymbol)` → 解析 distribution → `{ pe:{value,median}, pb:{...}, ps:{...} }` 或 null。
- `fetchLongbridgeIndustryComp(env, tencentSymbol)` → 解析 comparison 首条自身的 `history` → `{ pe:[...], pb:[...], ps:[...] }`（数值数组，最新在前或按 date）或 null。
- `buildValuationRefs(dist, comp)`（纯，导出）→ `{ pe:{current, own5y, industryMedian}, pb:{...}, ps:{...} }`：
  - `current` = dist[m].value；`industryMedian` = dist[m].median；`own5y` = comp.history[m] 取最近 ~20 个季度的均值（即近 5 年）。任一缺失则该子项为 null。
- `/api/financials`（仅 `period=annual` 那次）：并发取 dist + comp，返回 `{ financials, latest, valuationRefs }`；季报那次仍只 `{ financials }`。失败 → valuationRefs:null。`Cache-Control: max-age=86400` 不变。

## 参考计算（`fieldReference(refTag, data, ctx, lang)`）

记 `series(kind,field)` = `data.financials[kind]` 中该 field 的 `values`（最新在前，`value` 为数）。百分比保留 2 位、倍数保留 1 位 + "x"。标签按 lang。

- `revGrowth` / `niGrowth` / `epsGrowth`：取 OperatingRevenue / NetProfit / EPS 序列 →
  - 最新 = `(v0-v1)/|v1|×100`；5年均 = 取最近 6 个年值算 5 段 YoY 的算术均（不足则用现有）。chips：`最新 X%`、`5年均 Y%`。
- `netMargin`：NetProfitMargin 序列 → `最新 v0%`、`5年均 = 最近 5 年均%`。
- `opMargin`：按下标对齐 `OperatingIncome[i]/OperatingRevenue[i]×100` → `最新`、`5年均`。
- `reinvest`：`1 − NetFreeCashFlow[i]/NetProfit[i]`（百分比）→ `最新`、`5年均`；分母≤0 跳过该期。
- `pe`/`pb`/`ps`：用 `data.valuationRefs[refTag]` → chips：`当前 {current}x`、`自身5年均 {own5y}x`、`行业中位 {industryMedian}x`（缺失项略过）。
- 任一无足够数据 → 返回 null（该字段不显示参考）。

标签文案（lang）：`最新/Latest`、`5年均/5y avg`、`当前/Now`、`自身5年均/5y avg`、`行业中位/Industry median`。

## 字段 → meta 标签 + 内容（FIELD_META 权威内容）

> 下表即 `field-meta.js` 的内容来源。`ref` 列空=仅提示无参考。guide 为 ⓘ 弹出文案。

| tag | 用于字段 | ref | guide(zh) | guide(en) |
|---|---|---|---|---|
| `revenue` | FCFF/PE/PS 当前营收 | — | 公司总营收（非每股）。已用最近年报预填，可改成你的预期口径。 | Total company revenue (not per share). Prefilled from the latest annual report; adjust to your estimate. |
| `netIncome` | FCFE 净利润 | — | 公司净利润总额（非每股）。已用最近年报预填。 | Total net income (not per share). Prefilled from the latest annual report. |
| `netDebt` | FCFF/EV 净负债 | — | 有息负债−现金。已用最近年报预填；负值=净现金。 | Interest-bearing debt minus cash. Prefilled; negative means net cash. |
| `dps` | DDM 每股股利 | — | 每股股利。已按现价×股息率预填，可改成你预期的每股分红。 | Dividend per share. Prefilled from price×yield; adjust to your expected payout. |
| `eps` | PEG 每股收益 | — | 每股收益，已用 TTM 预填。 | Earnings per share, prefilled with TTM. |
| `bps` | PB 每股净资产 | — | 每股净资产，已用最近年报预填。 | Book value per share, prefilled from the latest annual report. |
| `ebitda` | EV/EBITDA | — | 息税折旧摊销前利润。接口无此项，请手填（≈营业利润+折旧摊销）。 | EBITDA. Not provided by the API — enter manually (≈ operating income + D&A). |
| `growthYears` | FCFF/FCFE/DDM 高增长年数 | — | 护城河能维持超额增长的年数，通常 5–10 年；优势越强可越长。 | Years the moat sustains excess growth — usually 5–10; longer for stronger advantages. |
| `forecastYears` | PE/PS 预测年数 | — | 预测到第几年的盈利来套目标倍数，常 3–5 年。 | How many years out you project earnings before applying the target multiple — usually 3–5. |
| `revGrowth` | FCFF/PE/PS 营收增速 | revGrowth | 自上而下：市场空间(TAM)×渗透率提升×份额变化；高增速随规模向行业/GDP 收敛，勿长期外推峰值。 | Top-down: TAM × penetration × share. High growth fades toward industry/GDP as scale grows — don't extrapolate peaks. |
| `niGrowth` | FCFE 净利润增速 | niGrowth | 由营收增速 + 利润率变化（经营杠杆）共同驱动；成熟后向营收增速靠拢。 | Driven by revenue growth plus margin change (operating leverage); converges to revenue growth at maturity. |
| `epsGrowth` | PEG 盈利增速 | epsGrowth | 用未来 3–5 年 EPS 复合增速；留意回购会抬高每股增速。 | Use forward 3–5y EPS CAGR; buybacks inflate per-share growth. |
| `divGrowth` | DDM 股利增速 | — | 由盈利增速与分红率共同决定；成熟分红股通常低个位数。 | Set by earnings growth and payout ratio; mature payers are usually low single digits. |
| `ebitdaGrowth` | EV/EBITDA 增速 | — | 通常略低于营收增速，受利润率变化影响。 | Usually a bit below revenue growth, shaped by margin change. |
| `opMargin` | FCFF 目标营业利润率 | opMargin | 成熟期可持续的经营利润率；看毛利率−费用率趋势与规模效应，别取单年峰值。 | Sustainable mature operating margin; read gross-minus-opex trend and scale effects, not a peak year. |
| `netMargin` | PE 净利率 | netMargin | 长期可持续净利率中枢，剔除一次性项目与税率扰动，别用单年高点。 | Long-run sustainable net margin; strip one-offs and tax noise, avoid peak years. |
| `reinvest` | FCFE 股权再投资率 | reinvest | 支撑增长所需留存 ≈ 增速÷ROE（可持续增长）；参考 1−自由现金流/净利。 | Retention needed to fund growth ≈ growth ÷ ROE; reference is 1 − FCF/net income. |
| `taxRate` | FCFF 税率 | — | 永续期用法定/边际税率（美≈21%、中≈25%）；或参考近年有效税率。 | Use statutory/marginal rate for the terminal phase (US≈21%, CN≈25%), or recent effective rate. |
| `salesToCap` | FCFF 销售/资本比 | — | 每 1 元新增投资带来的营收 = 营收/投入资本；轻资产高、重资产低，参考历史与同业。 | Revenue per unit of new investment = revenue/invested capital; higher for asset-light, lower for asset-heavy. |
| `wacc` | FCFF 折现率 | — | 加权资本成本 = 股权成本×权重 + 税后债务成本×权重；股权成本=无风险利率+β×股权风险溢价（美股约 8–10%）。 | WACC = cost of equity×weight + after-tax cost of debt×weight; cost of equity = risk-free + β×ERP (~8–10% for US equities). |
| `costOfEquity` | FCFE/DDM 股权成本 | — | 无风险利率(10Y 国债)+ β×股权风险溢价(~4.5–5.5%)；稳定大盘股约 8–9%。 | Risk-free (10Y) + β×equity risk premium (~4.5–5.5%); ~8–9% for stable large caps. |
| `termGrowth` | FCFF/FCFE/DDM 永续增速 | — | ≤ 长期名义 GDP/无风险利率(通常 2–3%)，且必须 < 折现率；代表进入永续稳定期。 | ≤ long-run nominal GDP/risk-free (~2–3%) and must be < discount rate; the perpetual steady state. |
| `targetPE` | PE 目标 PE | pe | 反映增长与确定性；锚定自身历史中枢、行业中位、与增速匹配(PEG≈1 ⇒ PE≈增速)。 | Reflects growth and certainty; anchor to own history, industry median, and growth (PEG≈1 ⇒ PE≈growth). |
| `targetPB` | PB 目标 PB | pb | 与 ROE 强相关（高 ROE 配高 PB）；周期股参考历史 PB 区间。 | Tightly linked to ROE (higher ROE warrants higher PB); use the historical PB band for cyclicals. |
| `targetPS` | PS 目标 PS | ps | 适合未盈利/低利润期；最终应能回推到合理净利率下的 PE，别脱离盈利能力。 | For pre-profit/low-margin firms; must still map back to a sane PE at a normal net margin. |
| `peg` | PEG 系数 | — | 经验上 PEG≈1 视为合理，<1 偏低估；对超高/超低增长会失真，谨慎。 | PEG≈1 is the rule-of-thumb fair level, <1 cheap; breaks down at very high/low growth. |
| `targetMultiple` | EV/EBITDA 目标倍数 | — | 参考同业与历史；资本密集/高增长行业差异大。 | Reference peers and history; varies widely by capital intensity and growth. |

## 编辑器 UI（`valuation-ui.js`）

- 新增可选回调 `fieldRef(field)`（由 index.html 提供，内部调 `fieldReference`）。`FIELD_META` 由 valuation-ui 直接 import。
- 渲染每个字段时：
  - 标签若有 `FIELD_META[field.meta].guide` → 标签后加一个 `ⓘ` 按钮（`vc-info`）；点击切换显示一个小提示框（`vc-guide`，含 guide[lang]）。再次点击或点别处收起。
  - 若 `fieldRef(field)` 返回非空 → 在该字段输入框下方加一行筹码（`vc-ref` + `vc-refchip`），文案 `label value(+unit)`；点击 → 填入该字段（dual 同时填保守&乐观，single 填单值）→ 触发实时重算。
- 统一网格：参考行作为 `grid-column:2/-1` 的附加行（在输入下方），与输入列对齐；ⓘ 提示框绝对定位浮于其下，不挤占布局。
- 无 `meta` 或无 guide/ref 的字段：原样渲染。

## i18n

- 静态：`d_guide_close` 不需要（点切换即可）。ⓘ 的 aria-label `估值提示/Valuation tip`。参考筹码标签由 `fieldReference` 按 lang 返回，不入 i18n.js。

## 测试

- `test-core/field-meta.test.js`：用合成 `financials` + `valuationRefs` 测 `fieldReference`：revGrowth 的最新/5年均、netMargin、opMargin 对齐、reinvest（分母≤0 跳过）、pe/pb/ps 三筹码、数据不足返回 null；并断言 `FIELD_META` 关键 tag 存在且 guide 双语非空。
- `src/longbridge.js`：`buildValuationRefs` 纯函数单测（dist+comp → current/own5y/industryMedian；缺失兜底）。
- 现有 104 测试保持。

## 范围外（后续）

- DDM 股利增速参考（需 `/v1/quote/dividends` 历史）。
- PEG 盈利增速的分析师预期参考（需 `/v1/quote/forecast-eps`）。
- EV/EBITDA 的 EBITDA 与目标倍数参考（接口无 EBITDA/EV 倍数）。
- WACC/股权成本的无风险利率自动取数（无现成数据源）。
