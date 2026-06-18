# PE 估值：增加 EPS / 净利润 输入口径

日期：2026-06-18
状态：已确认设计，待实现

## 背景与目标

当前 PE 估值（[relative.js](../../../public/shared/valuation/relative.js) 中的 `PE` 模型）只有一条「营收驱动」算法链：

```
当前营收 → ×(1+营收增速)^n → 未来营收 → ×净利率 → 未来净利润 → ÷股本 → 未来EPS → ×目标PE = 公允价值
```

用户**必须**先填营收和净利率，系统才能推出净利润和 EPS。但有些公司更适合直接预测盈利端的增长，不想拆成「营收 × 净利率」两层假设——少一层假设就少一个出错点。而 EPS 和净利润系统都已有现成数据可预填（`ctx.epsTtm`、`ctx.netIncome`）。

### 现有相关能力（写 spec 时已核对最新代码）

`9873b45` 之后代码新增了一套 **「分部加总 / Segment build-up」** 功能（[segments.js](../../../public/shared/valuation/segments.js)），目前是 **PE 营收口径专属**：用户可把营收按业务分部拆开，各分部填「当前营收 + 增速{保守/乐观} + 净利率{保守/乐观}」，反解出与 ΣEᵢ 数学恒等的混合增速/净利率，**写回 PE 的 `growth` / `netMargin` 字段**。

- UI 入口在 [valuation-ui.js](../../../public/shared/valuation-ui.js) 的 `buildSegmentSection`，当前门控为 `renderForm` 中的 `if (model.key === "pe")`，插在表单顶部，依赖 `fieldEls.revenue / growth / netMargin / n`。
- 持久化：估值卡片新增 `segments` 字段，[items.js](../../../src/items.js) `validateValuations` 已校验透传；`onDone` 回传 `segments`。
- 这套功能**只在营收口径有意义**（净利润/EPS 口径没有 revenue/margin 可拆）。本设计必须让二者共存：见 §③、§④。

**目标**：在 PE 方法内部提供三种输入口径（同一个 PE 估值，不同输入精细度），用户可切换：

| 口径 | 说明 |
|------|------|
| 营收 × 净利率 | 现状，默认 |
| 净利润 | 直接从公司净利润切入 |
| EPS | 直接从每股收益切入 |

三种口径均采用**投影式**输入（与现有 PE 一致）：填「当前值 + 增速 + 预测年数 n」，系统按 `×(1+g)^n` 投影到第 n 年再 × 目标 PE。

## 非目标（YAGNI）

- 不引入「直接填目标年绝对值」的输入风格（已确认走投影式）。
- 不为 PEG / PS / 其它方法增加口径切换——本次只动 PE。
- 不做数据迁移脚本——靠默认值实现向后兼容。

## 设计

### ① 数据模型 / 持久化

- PE 卡片把当前口径存进 `inputs._mode`，取值之一：`"revenue"` | `"netIncome"` | `"eps"`。
- **缺省即 `"revenue"`**：所有已存在的 PE 卡片（`inputs` 中没有 `_mode`）自动落到现有行为。
- 后端 [items.js](../../../src/items.js) 无需改动：`validateValuations` 将 `card.inputs` 整体透传（不逐键校验），`_mode` 字符串随之保存。

### ② 模型层（relative.js）：PE 增加 `modes`

PE 模型从「单一 `fields` + `compute` + `breakdown`」改造为「三个 mode，每个 mode 自带 `fields`」，顶层 `compute` / `breakdown` 读 `vals._mode` 分派到对应口径的算法。

每个 mode 的字段（共享字段 `n`、`targetPE` 在每个 mode 内都列出）：

| 口径 (`_mode`) | 单值字段（前提） | 假设字段（保守/乐观） | 算法 |
|------|------|------|------|
| `revenue`（现状不变） | `revenue`（money，预填 `ctx.revenue`）、`n` | `growth`%（meta `revGrowth`）、`netMargin`%（meta `netMargin`）、`targetPE`（meta `targetPE`） | `revenue×(1+g)^n×netMargin÷shares ×targetPE` |
| `netIncome`（新增） | `netIncome`（money，预填 `ctx.netIncome`）、`n` | `growth`%（meta `niGrowth`）、`targetPE`（meta `targetPE`） | `netIncome×(1+g)^n÷shares ×targetPE` |
| `eps`（新增） | `eps`（预填 `ctx.epsTtm`）、`n` | `growth`%（meta `epsGrowth`）、`targetPE`（meta `targetPE`） | `eps×(1+g)^n ×targetPE` |

要点：
- 三个口径的增速字段统一用 `growth` 作为 key（compute 始终读 `vals.growth`），但各自的 `meta` 不同，从而参考筹码（历史增速）各自正确。
- 单值字段使用不同 key（`revenue` / `netIncome` / `eps`），切换口径时互不串值。
- `netIncome` 已在 `valuation-ui.js` 的 `MONEY_METAS` 白名单中，自动获得单位化金额输入（亿 / B）。
- 顶层 `compute(vals, ctx)`：`const mode = vals._mode || "revenue"`，按 mode 分派；非法输入返回 `null`（沿用现有约定）。
- 顶层 `breakdown(vals, ctx)`：同样按 mode 返回对应的明细行。
  - `revenue`：预期营收、预期净利润、目标 PE（现状）。
  - `netIncome`：预期净利润、隐含 EPS、目标 PE。
  - `eps`：预期 EPS、目标 PE。

`relative.js` 顶部对 `compute`/`ctx` 契约的注释需补充：moded 模型通过 `vals._mode` 选择口径。

### ③ UI 层（valuation-ui.js）：通用「口径」切换

引入一个**通用**机制——任何带 `modes` 的模型都能用，本次只有 PE 用到：

- 当 `MODELS[activeIdx].modes` 存在时，在方法下拉**下方**、`vc-form` **上方**渲染一个分段切换（segmented control / 药丸三选一）。无 `modes` 的模型不渲染该控件，行为完全不变。
- 维护 UI 状态 `currentMode`（默认 `model.defaultMode` 或第一个 mode；编辑时取 `initialInputs._mode`，缺省 `revenue`）。
- 新增 helper `activeFields(model)`：moded 模型返回 `model.modes.find(m => m.key === currentMode).fields`，否则返回 `model.fields`。把 `renderForm`、`currentDerivations`、`consOpt`、`midVals`、`renderBreakdown` 等处对 `model.fields` 的读取改为按当前口径取字段。
- `consOpt` / `midVals` 构造出的 `cons`/`opt`/`mid` 表中要带上 `_mode`，使顶层 `compute`/`breakdown` 能正确分派。
- 切换口径 → 重新 `renderForm`；同名键（`growth` / `targetPE` / `n`）的值保留，不同键自然清空。
- 提交时（`onDone`）把 `_mode` 写进 `inputs`：`lastForm._mode = currentMode`（或在 `buildForm` 中注入）。

#### 与分部加总（segment build-up）共存 ★关键

- `renderForm` 末尾构建分部加总区的门控，从 `if (model.key === "pe")` 收紧为 **`if (model.key === "pe" && currentMode === "revenue")`**——分部表只在营收口径出现。净利润/EPS 口径既无 `fieldEls.revenue/netMargin` 字段，也不该出现该区块。
- 切到非营收口径时不渲染分部区；`segments` 闭包状态保留但不生效。提交非营收口径卡片时，`onDone` 传出的 `segments` 应为「未启用」（`{ enabled: false, rows: segments.rows }` 或直接 `{ enabled:false, rows:[] }`），避免把分部数据挂到与之无关的口径上。
- 编辑既有营收口径卡片（带 `segments`）→ 默认 `revenue` 口径，分部区与现状一致。

### ④ 边界 / 兜底

- `eps` 口径不依赖股本；`netIncome` 与 `revenue` 口径仍要求 `ctx.shares > 0`，否则 `compute` 返回 `null` → 结果显示 `—`、提交按钮禁用（与现状一致）。
- 切换口径保留同名键值；`revenue` / `netIncome` / `eps` 为不同键，互不串值。
- 编辑老卡片（无 `_mode`）→ 默认 `revenue` 口径，字段与值与现状完全一致。

## 测试

在 [test-core/valuation-relative.test.js](../../../test-core/valuation-relative.test.js) 中为 PE 三口径补充用例：

- `revenue` 口径：沿用现有断言（revenue=1000, n=5, growth=10%, netMargin=15%, targetPE=20, shares=100 → ≈48.32），并确认 `_mode` 缺省时等价于 `revenue`。
- `netIncome` 口径：netIncome=150, n=5, growth=10%, targetPE=20, shares=100 → futNi=150×1.1^5=241.58, eps=2.4158, fair=48.32。
- `eps` 口径：eps=2.4158, n=5, growth=10%, targetPE=20 → futEps=2.4158×1.1^5=3.891, fair=77.82（不依赖 shares）。
- 缺股本时 `netIncome` 口径返回 `null`；`eps` 口径正常计算。
- `breakdown` 三口径分别返回正确的明细行。

## 受影响文件

- `public/shared/valuation/relative.js` — PE 模型改造为 modes。
- `public/shared/valuation-ui.js` — 通用口径切换 + 按口径取字段 + **分部加总门控收紧为 revenue 口径**。
- `public/shared/field-meta.js` — **无需改动**：已核对 `netIncome`（guide + 金额参考）、`niGrowth`（guide + ref）、`epsGrowth`（guide + ref）均已存在。
- `test-core/valuation-relative.test.js` — 新增三口径用例。
- `src/items.js` — **无需改动**：`validateValuations` 透传 `inputs`（`_mode` 随之保存），`segments` 已有校验。仅核对。
