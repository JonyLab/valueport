# 设计：可保存的多估值卡片（估值研究 tab）

日期：2026-06-16　（估值计算器套件的演进）

## 目标

把「估值研究」tab 从**单次临时计算器**，改造为**可保存的多估值卡片**工作流：

> 添加估值 → 选方法填表 → 完成 → 生成描述性卡片；卡片可编辑回到表单；可加多张不同方法的卡片；可选其中一张作为合理区间（驱动钟摆并写入 `fairLow`/`fairHigh`）。

## 已定决策（来自头脑风暴）

1. **选中联动 = 实时跟随**：被选中的卡片是合理区间的「活」来源——编辑它的假设并完成后，`fairLow`/`fairHigh` 随之更新。
2. **详情页整体仅主人可见**：访客只看看板列表，点击列表行不跳转详情；直接访问 `/b/:slug/:code` 且非主人时回退到列表。故估值卡片天然全是主人专属，无需访客只读态。
3. **手填区间保留并共存**：添加标的弹窗里的「合理价值·低/高」手填仍可用；手填即清空 `selectedValuationId`（手填覆盖卡片选择）。
4. **存储方案 = B**：卡片存进 items 行的 JSON 列，不新建表。

## 数据模型

### 卡片对象（前端 + JSON 持久化）
```js
{
  id: String,            // 客户端生成的稳定 id（如 "v" + 计数/时间种子；不依赖 DB 自增）
  method: String,        // 模型 key：fcff|fcfe|ddm|pe|peg|pb|ps|evebitda（白名单）
  inputs: Object,        // 表单值快照：{ [fieldKey]: Number(single) | {c:Number,o:Number}(dual) }
  low: Number,           // 计算快照（冻结），> 0
  high: Number,          // 计算快照（冻结），> low
  updatedAt: String,     // ISO
}
```
- `low/high` 是**冻结快照**：仅在「完成」（新建或编辑保存）时用当时的表单值 + 当时的 ctx 重算一次写入。看板加载不再依赖实时行情计算，合理区间不随行情漂移。
- `inputs` 用于「编辑」时回填表单。

### items 行新增两列（schema.sql + 迁移，向后兼容）
```sql
ALTER TABLE items ADD COLUMN valuations TEXT NOT NULL DEFAULT '[]';      -- 卡片数组 JSON
ALTER TABLE items ADD COLUMN selected_valuation_id TEXT;                  -- 选中卡片 id，可空
```
- `items.fair_low/fair_high` 仍是钟摆**唯一驱动值**，全站其它代码零改动。
- 选中某卡 / 编辑被选中的卡 → 把该卡 `low/high`（min/max）写入 `fair_low/fair_high` + 记 `selected_valuation_id`。
- 手填弹窗写 `fair_low/fair_high` 时，置 `selected_valuation_id = null`。

## 后端

- `src/items.js`：
  - `validateItem`：在现有校验外，校验 `valuations`（数组；每项 method ∈ 白名单、`low>0`、`high>low`、`inputs` 为对象、id 为字符串）与 `selectedValuationId`（字符串或空、且若非空须命中某张卡 id）。非法卡片项**整条拒绝**（400），与现有风格一致。
  - `rowToItem`：解析 `valuations`（`JSON.parse`，坏数据兜底 `[]`）与 `selectedValuationId` 一并返回。
- `src/index.js` 的 `POST /api/my/items`、`PUT /api/my/items/:id`：INSERT/UPDATE 语句加 `valuations`、`selected_valuation_id` 两列；其余不变。
- 看板加载 `/api/config` 与 `/api/my/items` 经 `rowToItem` 自动附带卡片，无需新增路由。

## 前端

### 访客门禁（`public/index.html`）
- 列表行点击：仅 `owner` 时 `pushState` + `showDetail`；非主人无跳转、无 hover 指针态。
- `route()`：`currentDetailCode()` 命中但 `!owner` → `showList()`（回退）。

### 估值研究面板（`renderDetail` 的 `panelEls[2]`，主人专属）
两种视图，单一容器内切换：

**A. 列表视图（默认）**
- 现有摘要（`valuationRows`）。
- 估值卡片列表：每张**描述性卡片**显示
  - 方法名（`MODELS` 的 label）· `低 ~ 高`
  - 关键假设摘要：dual 字段渲染为「标签 保守–乐观」串（如「营收增速 8–15% · 净利率 24–28% · 目标PE 22–30」）
  - 现价落档：复用 `verdictOf` 在该卡区间下的判定文案
  - 操作：`○ 设为合理区间`（单选高亮被选中卡）/ 编辑 / 删除
- 「＋ 添加估值」按钮 → 进入编辑视图（新建）。

**B. 编辑视图（新建/编辑）**
- 即已打磨好的计算器表单（方法选择 + 前提/情景假设工作表 + 实时低~高 + 区间条预览）。
- 底部操作：**完成**（重算 low/high，写入/更新卡片，回列表）/ **取消**（放弃回列表）。
- 编辑时用卡片 `inputs` 回填表单与方法；`mountValuationCalc` 增加可选 `initialMethod` / `initialInputs`。

### 选中 / 联动逻辑
- 「设为合理区间」：`item.cfg.fairLow = card.low; fairHigh = card.high; selectedValuationId = card.id` → 重渲染详情钟摆 + idBlock 判定 + 列表行 Bar/verdict → `saveItem`。
- 首张卡片完成时**自动设为合理区间**；之后新增需手动选。
- 编辑被选中的卡并完成 → 同步写回 fair 区间（实时跟随）。
- 删除被选中的卡 → 清 `selectedValuationId`（fair_low/high 保持上次值不变，等待用户另选或手填）。

### `mountValuationCalc` 改造（`valuation-ui.js`）
- 签名扩展：`mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, onDone, onCancel })`。
- 去掉原 `canApply`/`onApply`/内嵌应用按钮；底部改为「完成 / 取消」。
- 「完成」回调 `onDone({ method, inputs, low, high })`，由宿主页生成/更新卡片并处理选中。
- `initialInputs` 存在时按其回填（覆盖 prefill/default）。

## 测试

- `test/items.test.js`（worker 项目）：扩展 `validateItem`——合法 valuations 通过；非法（method 不在白名单、`high<=low`、selectedValuationId 不命中）被拒；`rowToItem` 正确 parse `valuations`/`selectedValuationId`、坏 JSON 兜底 `[]`。
- 现有 88 测试须保持。
- 浏览器手测：增/改/删卡片、设为合理区间→钟摆更新+保存、编辑被选中卡的实时跟随、首卡自动选中、访客无法进入详情、中英文。

## 范围外

- 卡片备注/自定义标题（YAGNI；描述自动生成）。
- 卡片排序拖拽。
- 访客只读卡片视图（已决策详情页仅主人可见）。
- 卡片 low/high 随实时行情重算（已决策为冻结快照）。
