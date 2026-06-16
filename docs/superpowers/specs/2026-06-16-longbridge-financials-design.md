# 设计：接入长桥财报数据（财报 tab + 计算器预填）

日期：2026-06-16

## 目标

1. 详情页「财报」tab 展示真实的**完整三表多期表格**（利润表 IS / 资产负债表 BS / 现金流 CF；年报/季报可切换），数据来自长桥 Fundamental API。
2. 把**最近一期年报**的营收 / 净利 /（若有）EBITDA 预填进估值计算器对应字段。

## 关键事实（研究确认）

- 长桥有 Fundamental「Financial Report」HTTP REST 接口：`kind ∈ {IncomeStatement, BalanceSheet, CashFlow, All}`，`period ∈ {Annual, SemiAnnual, Q1, Q2, Q3, ThreeQ, QuarterlyFull}`。
- 响应是**指标行**结构（按 kind 分组）：每个 `FinancialAccount{ field, name, values[] }`，`values` 为 `{ period, year, fp_end, value, yoy }` 时间序列。本地化 `name` 直接可用于表头/行名。
- 该接口是独立 HTTP（签名），不同于现用 WS quote 协议。**签名复用 `getOtp` 的模式**：canonical = `GET|<path>|<query>|<signed-headers-block>|<header-names>|`，`sig = hmac256hex(SECRET, "HMAC-SHA256|" + sha1hex(canonical))`，头 `authorization / x-api-key / x-timestamp / x-api-signature`。
- 来源：open.longbridge.com/docs/fundamental/fundamental/financial-report（及 snapshot）。

## Task 0：探针（必须先跑，整套实现依赖其产出）

用 `.dev.vars` 凭据，按 `getOtp` 签名模式对 Fundamental Financial Report 端点发一次真实 GET（候选 path `/v1/fundamental/financial-report`，query `symbol=AAPL.US&kind=All&period=Annual`；若候选 path 不对，依据文档/错误码修正）。必须产出：

1. 确认**精确 HTTP path 与 query 参数名/取值**。
2. 确认 token **是否有 fundamental 权限**（返回 `code===0 && data`）。
3. 把 AAPL 的真实 JSON 存为 fixture：`test-core/fixtures/financials-aapl.json`。
4. 从 fixture 记录：IS/BS/CF 的**分组键**，以及营收 / 净利 / 营业利润(EBIT) / EBITDA 对应的 `field` 码（写进代码里的字段码常量）。

**门禁**：若无权限或拿不到数据 → 停止本功能，向用户报告，回退方案 = 财报 tab 维持「即将上线」、预填维持现状（FCFE 用 eps×股数、营收手填）。其余任务都不做。

## 数据层（`src/longbridge.js`）

- `fetchLongbridgeFinancials(env, tencentSymbol, period)`：
  - `tencentToLongport` 转 symbol；按上面的签名模式签名 GET（query 含 `symbol/kind=All/period`，canonical 的 query 段填排序后的 query string）。
  - 调 `parseFinancials(json)` 归一化为 `{ IS:[Acct], BS:[Acct], CF:[Acct] }`，`Acct = { field, name, values:[{ period, year, fpEnd, value, yoy }] }`（最新期在前）。
  - 任意错误/空 → 返回 `null`。
- `parseFinancials(json)`：**导出的纯函数**，按 Task 0 确认的响应键解析；坏数据兜底 `null`。
- `pickLatestAnnual(financials)`：导出纯函数，按字段码常量从 IS 取最近一期年报的 `{ revenue, netIncome, ebitda }`（取不到的项为 `null`）。字段码常量来自 Task 0。

## 服务端路由（`src/index.js`）

- `GET /api/financials?symbol=&period=`：有长桥凭据则调 `fetchLongbridgeFinancials`，返回 `{ financials }`（或 `{ financials: null }`）。`Cache-Control: public, max-age=86400`（财报季度级，缓存一天）。`period` 缺省 `Annual`。

## 前端（`public/index.html`）

### 取数
- 详情页打开（仅主人）时，`fetch('/api/financials?symbol=...&period=annual')`，结果挂在 `item._financials.annual`；切到季报时再懒取 `item._financials.quarterly`。

### 财报 tab（`panelEls[1]`，现为「即将上线」）
- 顶部两个切换：报表 利润表/资产负债表/现金流；周期 年报/季报。
- 每张表渲染成表格：表头 = 各期（`year` 或 `fpEnd`），每行 = 指标（`name`）+ 各期 `value`（`fmtBig` 按币种格式化），值旁可带 `yoy` 小字。
- 三态：加载中 / 空（暂无财报数据）/ 错误。

### 预填（计算器）
- `valuationCtx(item)` 增加 `revenue / netIncome / ebitda = pickLatestAnnual(item._financials.annual)`（无则 `undefined`）。
- 模型 prefill 调整（`valuation/intrinsic.js`、`valuation/relative.js`）：
  - FCFF / PE / PS 的 `revenue`：`prefill:(ctx)=> ctx.revenue ?? ""`。
  - FCFE 的 `netIncome`：`prefill:(ctx)=> ctx.netIncome ?? (isFinite(ctx.epsTtm*ctx.shares) ? ctx.epsTtm*ctx.shares : "")`。
  - EV/EBITDA 的 `ebitda`：`prefill:(ctx)=> ctx.ebitda ?? ""`。
- 财报未取到时 ctx 无这些字段 → prefill 返回 ""，回退手填，不报错。

### i18n（`public/shared/i18n.js`）
- 新增：`d_stmt_is/d_stmt_bs/d_stmt_cf`、`d_period_annual/d_period_quarter`、`d_yoy`、`d_no_financials`。
- 指标行名直接用 API 返回的本地化 `name`（v1 不强制双语；若 API 仅返中文则英文界面也显示中文名，作为已知限制记录）。

## 测试

- `test-core/financials.test.js`：`parseFinancials` + `pickLatestAnnual` 跑真实 fixture（纯函数，core 项目）。
- `test/routes.test.js` 或新增：`/api/financials` 路由形状（无凭据时返回 `{financials:null}`，不崩）。
- 现有 97 测试须保持。

## 缓存与成本

- 服务端 `max-age=86400`；客户端按 item 在本会话内存缓存。
- 权限缺失即按 Task 0 门禁回退。

## 范围外

- 财报快照（AI 摘要 / 预测 vs 实际）——单独后续。
- 指标名双语翻译（用 API 本地化名）。
- TTM 口径预填（用最近年报）。
- 财报数据写库（每次按需取 + 缓存，不持久化）。
