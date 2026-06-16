# 设计：估值组件两种形态 + 标的详情页

日期：2026-06-16

## 背景与目标

当前每个标的在看板里是一行「左信息 + 右迷你半圆钟摆」。需求：同一套估值可视化有**两种形态**——

1. **列表里**：横向条形图（钟摆"展平"成水平五段色带），更紧凑、可扫读。
2. **详情页里**：完整的半圆钟摆 + 该标的的多维信息（tab）。

详情页通过**真路由**进入（独立 URL、可分享、浏览器后退可返回）。

## 一、列表：横向条形图（Bar）

新增轻量渲染器 `public/shared/bar.js`，与 `Gauge` 同源（都从 `core.js` 取区间与映射），API 类似：`new Bar(mount)`、`bar.set(cfg, animate)`、`bar.destroy()`。

**结构**（替换列表行右侧的迷你钟摆）：
- 一条水平轨道，分成 **5 个等宽区间段**（深度低估/低估/合理/高估/极度高估），用各区间色着色；**当前所在区间高亮（实色），其余变浅**（与钟摆色带同逻辑：非当前段填 `var(--track)`）。
- 段上方：5 个**缩写区间标签**（深低/低估/合理/高估/极）。
- 段下方：**4 个分位刻度数字**（`computeAnchors` 得到的 t1..t4，落在段边界 20/40/60/80%）。
- **现价标记**：竖向 tick + 小三角，水平位置 `x% = priceToPhi(anchors, price) / 180 * 100`——与钟摆指针**完全同一套映射**，保证两种形态一致。
- **入场动画**：标记从中点缓动到目标位置，时长/节奏与现价计数动画一致；`prefers-reduced-motion` 时直接定位。
- 无现价/区间未填全时：标记隐藏、刻度留空（沿用钟摆的处理）。

**行布局**：保持 `左 .chart-info（名称/代码/现价/判定） + 右 Bar`。Bar 比半圆矮，行更紧凑。列表行整体可点击 → 进入详情。

列表不再用 `Gauge` 的 `compact` 模式（该模式可移除）。

## 二、详情页：真路由 SPA

**路由**：`/b/<slug>/<code>`（如 `/b/demo/AAPL`）。服务端对该路径返回同一个 `index.html`（不新建 HTML 页），前端按 `location.pathname` 切视图。

- **服务端**（`src/index.js`）：新增 `GET /b/:slug/:code` 返回 `index.html`（与现有 `/b/:slug` 同样的静态资源）。
- **客户端路由**：
  - 加载时照常拉 `/api/board` 数据、渲染列表（items 缓存在内存）。
  - 解析路径：`/b/:slug` → 列表视图；`/b/:slug/:code` → 详情视图（按 ticker 不区分大小写匹配 item）。
  - 行点击 → `history.pushState({}, "", "/b/"+slug+"/"+code)` 后渲染详情（不整页刷新）。
  - `popstate` → 重新按路径渲染列表或详情。
  - 「← 返回」→ `history.back()`（无历史时 pushState 回 `/b/slug`）。
  - 深链直接进 `/b/slug/code`：先拉看板数据，再按 code 渲染详情；找不到则回列表。
  - `slug` 用现有 `boardSlug`；`code` 用 `item.cfg.ticker`。

## 三、详情页布局

**顶部**（关键信息 + 完整钟摆）：
- 左：名称（随语言双语）、代码、交易所/货币、**现价**（大号）、**判定**（语义色）。
- 右：**完整半圆钟摆**（现有 `Gauge`，非 compact：区间词标签 + 分位刻度 + 中枢）。
- 顶部下缘一条标尺线 + 两端菱形节点（沿用线条系统）。

**下方 Tab 区**（基本面 / 财报 / 估值研究）：

### Tab 1 · 基本面（数据来自 Longbridge）
从 `SecurityStaticInfo`（已为名称调用 cmd 10）多解析字段，配合现价计算：
- **市值** = `total_shares × 现价`（按货币做亿/万亿或 B/T 缩写）
- **市盈率 PE(TTM)** = `现价 ÷ eps_ttm`（eps_ttm>0 时）
- **市净率 PB** = `现价 ÷ bps`（bps>0 时）
- **股息率** = `dividend_yield`
- **EPS(TTM)**、**每股净资产 BPS** 直接展示
- 货币 / 交易所
- 任一字段缺失或为 0 → 该项不显示（优雅降级）；整体拿不到 → 显示「暂无基本面数据」。

### Tab 2 · 财报
占位「即将上线」（无数据源，本期不接）。

### Tab 3 · 估值研究（现有数据）
- **合理价值区间**：fairLow – fairHigh
- **安全边际 %**：mos
- **极度高估 %**：ext
- **现价 + 判定**
- **五区间阈值**：`computeAnchors` 的 t1..t4（深度低估线 / 低 / 高 / 极度高估线）
- **方法说明**：链接到 `/valuation`

## 四、数据管道

- `src/longbridge.js` `parseStaticInfo`：在现有 `symbol/name_cn/name_en/name_hk` 基础上，增解析 `exchange(5)`、`currency(6)`、`total_shares(8, varint)`、`eps_ttm(12, str)`、`bps(13, str)`、`dividend_yield(14, str)`（字段号依 Longbridge quote proto `SecurityStaticInfo`）。**实现时用 dev 服务器对真实返回逐字段校验**（名称字段 name_cn=2/name_en=3 已这样验证过），字段号若与实际不符以实际为准。
- `fetchLongbridgeNames` → 返回每个标的的完整静态信息对象（不止 cn/en）。
- `src/index.js` `/api/names`：返回扩展后的对象 `{sym: {cn, en, exchange, currency, totalShares, epsTtm, bps, dividendYield}}`。
- 前端 `loadNames`：把静态信息存到 `item.statics`；详情页「基本面」用 `item.statics × 现价` 计算指标。名称展示逻辑不变。

## 五、改动文件

- `public/shared/bar.js`（新）——Bar 渲染器
- `public/index.html`——列表行改用 Bar；客户端路由（list/detail）；详情视图 + 三 tab；行点击进详情
- `src/longbridge.js`——`parseStaticInfo` 多解析静态字段
- `src/index.js`——`/b/:slug/:code` 返回 SPA；`/api/names` 返回扩展静态信息

## 六、范围外（YAGNI）

- 财报真实数据、52 周高低
- 详情页内编辑（编辑仍在列表的编辑弹窗）
- 历史价格/财务走势图
- 每标的独立 API（复用 `/api/board` 内存数据 + `/api/names`）

## 七、测试与验证

- 现有 57 个 worker/core 测试须保持通过；CSS/前端为主，后端仅扩展 `parseStaticInfo`（纯解析）与新增路由。
- 可为扩展后的 `parseStaticInfo` 增一个单测（导出后断言字段解析）。
- 浏览器手测：列表条形图标记位置与钟摆一致；点行进详情、后退返回、深链直进；基本面指标计算正确（拿真实静态信息验证）；中英切换名称与标签。
