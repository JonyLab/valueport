# PE 估值：四种输入口径(radio tab)

日期：2026-06-18（v2 重写：四 tab + 分业务升级为口径 + 补 runModel/assumeSummary 遗漏）
状态：设计已确认，待实现

## 背景与目标

当前 PE 估值（[relative.js](../../../public/shared/valuation/relative.js) 的 `PE` 模型）只有一条「营收驱动」链:`营收→×(1+g)^n→未来营收→×净利率→未来净利→÷股本→未来EPS→×目标PE`。用户必须先填营收 + 净利率。但很多人更想直接从盈利端切入,少一层假设少一个出错点;而净利润/EPS 系统都有现成数据可预填(`ctx.netIncome`、`ctx.epsTtm`)。

此外 `9873b45/6533901a` 已上线「分部加总」(各业务 营收+增速+净利率 → ΣEᵢ),目前是 **revenue 口径内的一个开关**。本设计把它**提升为一个并列口径**。

**目标:PE 选中后,顶部一排 radio tab 横切四种输入口径**(同一个 PE 估值,不同输入精细度):

| Tab(`_mode`) | 单值字段 | 假设字段{保守,乐观} | 算法 |
|---|---|---|---|
| **经典 PE**(`netIncome`) | `netIncome`(money,预填 `ctx.netIncome`)、`n` | `growth`%(meta `niGrowth`)、`targetPE`(meta `targetPE`) | `netIncome×(1+g)^n ÷ shares × targetPE` |
| **EPS**(`eps`) | `eps`(预填 `ctx.epsTtm`)、`n` | `growth`%(meta `epsGrowth`)、`targetPE` | `eps×(1+g)^n × targetPE`(不依赖股本) |
| **营收·利润率**(`revenue`) | `revenue`(money,预填 `ctx.revenue`)、`n` | `growth`%(meta `revGrowth`)、`netMargin`%(meta `netMargin`)、`targetPE` | `revenue×(1+g)^n×netMargin ÷ shares × targetPE`(现状不变) |
| **分业务**(`segment`) | 分部表(各业务 `当前营收` + `增速{c,o}` + `净利率{c,o}`)、`n` | `targetPE` | ΣEᵢ × targetPE;复用 revenue 算法,分部表驱动隐藏的 revenue/growth/netMargin |

均为**投影式**(填 当前值 + 增速 + 预测年数 n,按 `×(1+g)^n` 投到第 n 年再 × 目标 PE)。三口径增速统一用 `growth` 作 key(compute 始终读 `vals.growth`),但各自 `meta` 不同 → 历史增速参考筹码各自正确。单值字段用不同 key(`netIncome`/`eps`/`revenue`),切 tab 互不串值。

### 默认口径(向后兼容)

- **新建 PE 卡片**(无 `initialInputs`):默认 `netIncome`(经典 PE)= `model.defaultMode`。
- **编辑旧卡片**(`inputs` 无 `_mode`):落 `revenue`,保持现行为完全一致。
- **旧卡片若 `segments.enabled===true` 且无 `_mode`**(上一特性的开关式分部):迁移到 `segment` tab。
- UI 解析:`currentMode = initialInputs ? (initialInputs._mode || (initialSegments && initialSegments.enabled ? "segment" : "revenue")) : (model.defaultMode || model.modes[0].key)`。

## 非目标(YAGNI)

- 不引入「直接填目标年绝对值」风格(走投影式)。
- 不为 PEG/PS/其它方法加口径切换——只动 PE。
- 不做数据迁移脚本——靠默认值与上面的迁移规则向后兼容。

## 设计

### ① 数据模型 / 持久化

- PE 卡片把当前口径存进 `inputs._mode ∈ {"netIncome","eps","revenue","segment"}`。
- 后端 [items.js](../../../src/items.js) **无需改动**:`validateValuations` 整体透传 `card.inputs`(含 `_mode`)与 `card.segments`(已有校验)。仅核对。

### ② 模型层(relative.js):PE 改造为 `modes`

PE 从「单一 `fields` + `compute` + `breakdown`」改为 **`modes` 数组 + 按 `vals._mode` 分派的顶层 `compute`/`breakdown`**。**不保留顶层 `fields`**——强制所有读取走 mode-aware 路径(见 §③),避免"有的地方读旧 fields、有的读 mode"的不一致。

```
PE = {
  key: "pe", group: "relative", label: {...},
  defaultMode: "netIncome",
  modes: [
    { key:"netIncome", label:{zh:"经典 PE", en:"Classic (NI)"}, fields:[ netIncome(single,money), n(single), growth(dual, meta niGrowth), targetPE(dual) ] },
    { key:"eps",       label:{zh:"EPS",     en:"EPS"},          fields:[ eps(single),         n(single), growth(dual, meta epsGrowth), targetPE(dual) ] },
    { key:"revenue",   label:{zh:"营收·利润率", en:"Revenue×margin"}, fields:[ revenue(single,money), n(single), growth(dual, meta revGrowth), netMargin(dual), targetPE(dual) ] },
    { key:"segment",   label:{zh:"分业务",  en:"By segment"},   fields:(同 revenue 的 fields —— 由分部表驱动,UI 隐藏) },
  ],
  compute(vals, ctx) { const mode = (vals._mode === "segment" ? "revenue" : (vals._mode || "revenue")); /* 按 mode 分派 */ },
  breakdown(vals, ctx) { /* 同样按 mode */ },
}
```

- `segment` 口径的 `fields` 与 `revenue` 相同(`compute` 把 `segment` 视作 `revenue`),差别纯在 UI(见 §③)。
- `compute` 分派:
  - `netIncome`:`futNi = netIncome×(1+growth)^n`;`eps = futNi/shares`;`fair = eps×targetPE`;`shares>0` 否则 `null`。
  - `eps`:`futEps = eps×(1+growth)^n`;`fair = futEps×targetPE`(不需 shares)。
  - `revenue`/`segment`:现状 `futRev=revenue×(1+growth)^n; futNi=futRev×netMargin; eps=futNi/shares; fair=eps×targetPE`;`shares>0`。
- `breakdown` 分派:
  - `netIncome`:预期净利润、隐含 EPS、目标 PE。
  - `eps`:预期 EPS、目标 PE。
  - `revenue`/`segment`:预期营收、预期净利润、目标 PE(现状)。
- `relative.js` 顶部对 `compute`/`ctx` 契约的注释补充:moded 模型通过 `vals._mode` 选口径(`segment` 等价 `revenue`)。

### ③ 通用 mode-aware 改造(★关键,含原 spec 漏掉的两处)

任何带 `modes` 的模型都走以下机制(本次只 PE 用到);无 `modes` 的模型行为完全不变。新增 helper:

```js
function modeFields(model, mode) {
  if (!model.modes) return model.fields;
  const m = model.modes.find((x) => x.key === mode) || model.modes[0];
  return m.fields;
}
```

需要按口径取字段、并注入 `_mode` 的所有位置:

- **`public/shared/valuation/index.js` 的 `runModel`(★ 原 spec 遗漏 —— 这才是算 low/high 的路径)**:
  - 取字段:`const fields = model.modes ? modeFields(model, form._mode || model.defaultMode) : model.fields;`(`modeFields` 复制进 index.js 或共享)。
  - 构造 cons/opt 后**注入 `_mode`**:`cons._mode = opt._mode = form._mode || model.defaultMode;`,否则顶层 `compute` 无法分派。
- **`public/shared/valuation-ui.js`**:
  - `currentMode` 状态:按 §「默认口径」解析;切 tab → 重新 `renderForm`(同名键 `growth`/`targetPE`/`n` 保留,异名键自然清空)。
  - 当 `model.modes` 存在 → 在方法下拉**下方**、`vc-form` **上方**渲染一排 radio tab(药丸,来自 `model.modes` 的 `label`)。无 `modes` 不渲染。
  - `renderForm`、`currentDerivations`、`consOpt`、`midVals` 里对 `model.fields` 的读取一律换成 `modeFields(model, currentMode)`。
  - `consOpt`/`midVals` 产出的 `cons`/`opt`/`mid` 带上 `_mode = currentMode`。
  - `buildForm`/`onDone` 注入:`lastForm._mode = currentMode`。
- **`public/index.html` 的 `assumeSummary`(★ 原 spec 遗漏)**:卡片列表摘要 `(model.fields||[])` 改为按 `card.inputs._mode` 取字段:`(model.modes ? modeFields(model, card.inputs._mode || "revenue") : (model.fields||[]))`。否则 moded PE 卡片摘要为空。

### ④ 分业务 tab 与分部加总共存

- 分部加总区(`buildSegmentSection`)的门控从 `if (model.key === "pe")`(及上一版的 `&& currentMode==="revenue"`)改为 **`if (currentMode === "segment")`**。
- `segment` 口径:渲染分部表;`revenue`/`growth`/`netMargin` 三字段虽在 `fields` 里(供 compute/runModel 读取),但 UI **整行隐藏**(沿用已实现的 `setDriven` 隐藏逻辑),由分部表驱动写入。`n`、`targetPE` 正常显示。
- 切到非 `segment` 口径 → 不渲染分部区;`onDone` 传出的 `segments` 置 `{ enabled:false, rows: segments.rows }`(保留行数据但不启用),避免把分部挂到无关口径。
- `segment` 口径提交时 `segments.enabled = true`。

### ⑤ 边界 / 兜底

- `eps` 口径不依赖股本;`netIncome`/`revenue`/`segment` 仍要求 `ctx.shares>0`,否则 `compute` 返回 `null` → 结果 `—`、提交禁用(现状)。
- 切口径保留同名键;异名键(`netIncome`/`eps`/`revenue`)互不串值。
- 编辑老卡(无 `_mode`)→ `revenue` 口径,字段与值与现状一致。

## 测试

[test-core/valuation-relative.test.js](../../../test-core/valuation-relative.test.js) 为 PE 各口径补用例(compute 直接传 `{_mode, ...}`):

- `revenue`：沿用现有断言;并确认 `_mode` 缺省 ≡ `revenue`。
- `netIncome`：`{_mode:"netIncome", netIncome:150, growth:10, targetPE:20}`、n=5、shares=100 → futNi=241.58、eps=2.4158、fair≈48.32。
- `eps`：`{_mode:"eps", eps:2.4158, growth:10, targetPE:20}`、n=5 → futEps=3.891、fair≈77.82(不依赖 shares)。
- `segment`：`{_mode:"segment", revenue, growth, netMargin, ...}` 与同参数 `revenue` 结果一致(compute 等价)。
- 缺股本时 `netIncome` 返回 `null`;`eps` 正常。
- `breakdown` 各口径返回正确明细行。

`runModel`(index.js)的 mode 分派 + `_mode` 注入,由 `valuation-relative.test.js` 经 `runModel(PE, form_with_mode, ctx)` 覆盖。

## 受影响文件

- `public/shared/valuation/relative.js` — PE 改造为 `modes`(去顶层 `fields`)。
- `public/shared/valuation/index.js` — **★ `runModel` 改为 mode-aware**(取 `modeFields` + 注入 `_mode`)。
- `public/shared/valuation-ui.js` — radio tab + `modeFields` 按口径取字段 + `consOpt`/`midVals`/`currentDerivations`/`renderForm` 改造 + 分部门控改为 `currentMode==="segment"`。
- `public/index.html` — **★ `assumeSummary` 改为 mode-aware**(按 `inputs._mode` 取字段)。
- `test-core/valuation-relative.test.js` — 新增各口径用例。
- `public/shared/field-meta.js` — **无需改动**(已核对 `netIncome`/`eps`/`niGrowth`/`epsGrowth`/`netMargin` 均存在)。
- `src/items.js` — **无需改动**(透传 `inputs._mode` 与 `segments`)。仅核对。
