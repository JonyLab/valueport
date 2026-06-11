# 估值钟摆看板 · 公开/后台分离版 — 设计文档

- 日期：2026-06-11
- 状态：已与用户确认，待写实现计划
- 来源：基于现有单文件 `pendulum-board.html`（自包含、纯客户端、内存配置、无持久化）改造

## 目标

把现有自包含 HTML 看板改造成移动端/桌面端可用的网页，具备：

1. **配置后台**：登录后增删改标的及其估值参数，保存到数据库。
2. **公开只读页**：常规访问只能看到配置好的内容，自动刷新现价，无任何配置入口、不可修改。

## 非目标（YAGNI）

- 多管理员账号 / 注册 / 找回密码（自用，单一密码足够）。
- 公开页的访问鉴权（定为完全公开只读；结构上预留 token 保护的扩展位，但本期不做）。
- 历史价格、K 线、组合收益等扩展功能。
- 前端打包器 / 框架（保持纯 vanilla JS，与原文件一脉相承）。

## 整体形态

单个 Cloudflare Worker 承担三件事：托管静态页面、提供配置 CRUD API、代理腾讯行情。两个入口：

- `/` — 公开页，免登录、只读。访客只看到配好的钟摆图，自动刷新现价。无配置面板、无添加/移除按钮。
- `/admin` — 后台页，单一密码进入。现有右侧配置面板搬过来（添加图表、代码联想下拉、合理区间/安全边际/极度高估、移除），保存即写入 D1，公开页随之变化。

技术栈：

- Worker：**Hono**（极轻量路由框架）。
- 数据库：**Cloudflare D1**（内置 SQLite）。
- 前端：纯 vanilla JS，**不引入打包器**。
- 静态资源：Cloudflare Workers 的 `assets` 绑定托管 `public/`。

## 目录结构

```
worker/
  src/index.js          # Hono：路由 + 鉴权 + 行情代理
  wrangler.toml         # CF 配置、D1 绑定、secret 声明、assets 绑定
  schema.sql            # D1 建表
public/
  index.html            # 公开只读页
  admin.html            # 后台配置页（含登录门）
  shared/gauge.js       # Gauge 类 + verdict 逻辑 + ZONES（两页共用）
  shared/styles.css     # 共用样式（从现文件抽出）
```

从现文件抽出 `Gauge` 类、`verdictOf`、`structValid`、`ZONES`、几何常量等到 `shared/gauge.js`，公开页与后台页都引用，避免两份拷贝。

## 数据模型（D1，表 `items`）

```sql
CREATE TABLE items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker      TEXT    NOT NULL,           -- 展示代码，如 AAPL
  name        TEXT    NOT NULL DEFAULT '',-- 名称，如 苹果
  symbol      TEXT    NOT NULL,           -- 腾讯格式，如 usAAPL（行情/联想锁定的精确标的）
  fair_low    REAL    NOT NULL,           -- 合理区间低点
  fair_high   REAL    NOT NULL,           -- 合理区间高点
  mos         REAL    NOT NULL,           -- 安全边际 %
  ext         REAL    NOT NULL,           -- 极度高估 %
  sort_order  INTEGER NOT NULL DEFAULT 0, -- 公开页展示顺序
  updated_at  TEXT    NOT NULL
);
```

约束校验（沿用现有 `structValid`）：`fair_low > 0`、`fair_high > fair_low`、`0 < mos < 100`、`ext > 0`，且 `symbol` 必须非空（后台只能从代码联想下拉中锁定）。

## 接口

| 方法 | 路径 | 鉴权 | 作用 |
|---|---|---|---|
| GET | `/api/config` | 公开 | 返回所有标的配置（不含价格），按 `sort_order` 排序 |
| GET | `/api/quotes?symbols=a,b` | 公开 | Worker 服务端请求腾讯 `qt.gtimg.cn`、GBK 转码、解析、返回干净 JSON（带短缓存，约 30–60s） |
| GET | `/api/hints?q=` | 公开 | 代理腾讯 smartbox（`smartbox.gtimg.cn`）、GBK 转码、返回联想 JSON |
| POST | `/api/login` | 公开 | 校验密码；成功则下发 HMAC 签名的 session cookie |
| POST | `/api/logout` | 需登录 | 清除 session cookie |
| GET | `/api/admin/items` | 需登录 | 列出全部配置 |
| POST | `/api/admin/items` | 需登录 | 新增一条 |
| PUT | `/api/admin/items/:id` | 需登录 | 修改一条 |
| DELETE | `/api/admin/items/:id` | 需登录 | 删除一条 |

行情代理放服务端后，前端彻底告别 JSONP / GBK / `<script>` 注入那套 hack，CORS 不再是问题。GBK 转码在 Worker 内用 `TextDecoder('gbk')` 完成。

### `/api/config` 与 `/api/quotes` 响应示例

```jsonc
// GET /api/config
{ "items": [
  { "id": 1, "ticker": "AAPL", "name": "苹果", "symbol": "usAAPL",
    "fairLow": 215, "fairHigh": 265, "mos": 20, "ext": 25, "sortOrder": 0 }
]}

// GET /api/quotes?symbols=usAAPL,usNVDA
{ "quotes": { "usAAPL": 232.1, "usNVDA": 118.4 }, "ts": "2026-06-11T09:30:01Z" }
```

## 鉴权

- 管理密码存为 Worker secret `ADMIN_PASSWORD`，代码不硬编码任何密码。
- 另存 secret `SESSION_SECRET`，用于给登录后的 cookie 做 HMAC-SHA256 签名（Web Crypto API）。
- `POST /api/login` 校验密码 → 生成 `{ exp }` 载荷 + HMAC 签名 → 写入 `HttpOnly; Secure; SameSite=Lax` cookie。
- `/api/admin/*` 中间件校验 cookie 签名与过期时间；失败返回 401。
- `/admin` 页面本身可直接返回 HTML，由前端 JS 检测未登录态并显示登录门（输入密码 → 调 `/api/login` → 成功后加载配置 UI）。

## 移动端 / 桌面端

- 公开页：单列钟摆流，移动端竖排、桌面端按宽度自适应多列网格。SVG 本就是响应式（`viewBox` + `width:100%`），基本直接复用。
- 后台页：沿用现有 880px 断点（窄屏时配置面板从右侧 sticky 变为静态堆叠）。

## 复用 vs 重写

**保留**：钟摆绘制、摆入动画（`swingIn`）、跟随动画（`follow`）、verdict 判定、代码联想下拉交互、ZONES/几何。

**改动**：
1. 拆分公开页 / 后台页两个 HTML。
2. 内存 seed → D1 读写（后台经 `/api/admin/items`，公开页经 `/api/config`）。
3. 行情取价 `loadTencent`/`parsePrice` 改为 `fetch('/api/quotes')`。
4. 代码联想 `loadHints`/`parseHints` 改为 `fetch('/api/hints')`。
5. 公开页移除所有写操作 UI；后台页保存按钮触发 API 写入。

## 自动刷新

公开页与后台预览均沿用：加载即取一次，之后每 60s 刷新现价（调 `/api/quotes`）。

## 错误处理

- 行情代理上游不可达：`/api/quotes` 返回部分成功 + 缺失标的列表；前端状态条显示「已更新 N/M」或「接口不可达」。
- 登录失败：`/api/login` 返回 401，前端登录门显示错误。
- 配置校验不过：后台保存前前端校验 + Worker 端二次校验，返回 400。

## 部署

- `wrangler d1 create` 建库，`wrangler d1 execute --file schema.sql` 建表。
- `wrangler secret put ADMIN_PASSWORD` / `SESSION_SECRET`。
- `wrangler deploy`。

## 开放问题

无（公开页保护一项已定为本期不做，预留扩展位）。
