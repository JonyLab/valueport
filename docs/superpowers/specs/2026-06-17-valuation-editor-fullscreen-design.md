# 设计：估值编辑器改为全屏双栏视图

日期：2026-06-17

## 目标

把估值编辑器从大弹窗改为**详情内的全屏双栏视图**：左栏输入、右栏常驻结果。彻底摆脱弹窗的滚动/吸顶/回弹问题，让结果钟摆始终可见。

## 决策（已确认）

- **路由方式**：详情内全屏视图（占内容区、保留顶部导航）。进入时 `history.pushState` 压一条 → 浏览器后退 = 取消返回详情；不做深链（编辑状态本就临时）。
- **窄屏**：单栏，输入在上、结果（低~高 + 完成/取消）做吸底条。
- 右栏桌面端 **sticky 常驻**；大弹窗整体下线。

## 视图系统改动（`public/index.html`）

- HTML：在 `#viewDetail` 后加 `<div class="view-detail hidden" id="viewValEdit"></div>`（复用 `.view-detail` 的宽度/边距）。
- `showView(v)` 扩展支持 `"valedit"`：
  - `isValEdit = v === "valedit"`；`viewValEdit.classList.toggle("hidden", !isValEdit)`；list/settings/detail 三者在 valedit 时均隐藏。
  - nav-tab「board」高亮在 `isList || isDetail || isValEdit` 时保持。
  - 进入非 valedit 视图时清空 `valEditReturn`（见下）。

## 进入 / 退出

- 模块级 `let valEditReturn = null`（编辑期间存当前 item）。
- `openValEdit(item, card, idBlock)`（取代原 `showEditor`）：
  - `valEditReturn = item`；`history.pushState({ valedit: 1 }, "", location.href)`；渲染编辑视图到 `#viewValEdit`；`showView("valedit")`；滚动置顶。
- `finishValEdit()`：`history.back()`（弹掉压入的历史条 → 触发 popstate）。
- `popstate` 处理：若 `valEditReturn` 非空 → 取出 item、置空、`showDetail(item)`（重渲染详情，卡片列表反映最新）、return；否则走原 `route()`。
- 「返回 / 取消」按钮、浏览器后退 → 统一 `finishValEdit()`。
- 「完成」→ 先存卡（同现逻辑：新增/更新卡片、首张或被选中卡同步 `selectValuation`、`saveItem`）→ 再 `finishValEdit()`。

## 编辑视图内容（渲染到 `#viewValEdit`）

- 顶部标题栏：`← 返回`（= 取消）+ 标题「添加估值 / 编辑估值」。
- 下方挂载点调用 `mountValuationCalc(mount, valuationCtx(item), { lang, initialMethod, initialInputs, initialNote, refData, onDone, onCancel })`（参数同现状；`refData` 含 financials/valuationRefs/sources）。
  - `onCancel = finishValEdit`
  - `onDone = ({method,inputs,low,high,note}) => { 存卡逻辑; finishValEdit(); }`

## 双栏布局（重构 `mountValuationCalc` 结构 + CSS）

`mountValuationCalc` 把内容分两块挂到 `.vc`：

- `.vc-main`（左，随页面滚动）：方法下拉（`.vc-methods`）+ 工作表（`.vc-sheet`，含参考筹码/ⓘ/↗）+ 备注（`.vc-note`）。
- `.vc-side`（右，**桌面 sticky**）：结果 hero（`.vc-rnums` 低~高）+ 五区间条预览（`.vc-bar-mount`）+ 动作（`.vc-actions` 完成/取消）。
- `.vc{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:32px;align-items:start}`
- `.vc-side{position:sticky;top:24px;align-self:start}`
- 窄屏 `@media(max-width:860px)`：`.vc{grid-template-columns:1fr}`；`.vc-side{position:sticky;bottom:0;top:auto;background:var(--bg);border-top:1px solid var(--divider);margin:0 -28px;padding:12px 28px}`（吸底条，输入在上）。区间条在窄屏可保留（较矮）。
- `.vc-actions` 恢复为普通行（`display:flex;gap:10px;margin-top:16px`），不再自带 sticky（由 `.vc-side` 负责定位）。

视图容器：`.view-valedit`（复用 `.view-detail` 内边距 `28px 28px 0`）；标题栏 class `.ve-head`（含 `.ve-back` 返回链接 + `.ve-title`）。

## 清理（移除弹窗遗留）

- 删除 `#valOverlay` 整段 HTML、`closeValModal()`、`valOverlay` 的 backdrop 点击监听、keydown 中 valOverlay 分支、`valuationSources` 保留（仍用）。
- 删除 CSS：`.modal-lg`、`.modal-lg .modal-head`、`#valModalBody`。`.modal`/`.modal-foot` 等其它弹窗(添加标的/分享)样式保留不动。
- `.vc-actions` 由 sticky-footer 样式改回普通行（见上）。

## 不变

预填、参考/提示/溯源、卡片增删改选与持久化、方法下拉、`field-meta`、`fieldReference`、`valuationSources` 全部不变。

## 测试

- UI/视图改造，无新单测；现有 113 测试须保持（`npx vitest run`）。
- 浏览器手验：从卡片列表 添加/编辑 → 进入全屏双栏；左滚右钉;窄屏吸底;完成存卡并返回详情且卡片更新;取消/浏览器后退返回详情;编辑既有卡片回填;参考筹码点击回填、ⓘ、↗ 正常;中英文。

## 范围外

- 编辑器深链（URL 编码状态）。
- 拖拽/分屏比例可调。
