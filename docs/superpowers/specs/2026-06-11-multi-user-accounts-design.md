# 激活码注册的多用户看板 — 设计文档

- 日期：2026-06-11
- 状态：已与用户确认，待写实现计划
- 来源：在现有单看板（单一 `ADMIN_PASSWORD`）应用上增加多用户账号系统

## 目标

把现在「单一密码、单看板」的估值钟摆应用，升级为**多用户系统**：

1. 用户凭**激活码**注册账号（用户名 + 密码），不开放无码注册。
2. 每个用户拥有并管理**自己的一个看板**（标的、页面文案、色块配色），数据按账号隔离。
3. 访客通过 `/b/<slug>` 只读访问某个看板。
4. **站长（你）**用站长密码进入专属后台，生成/查看激活码、查看用户列表、必要时重置用户密码。

## 非目标（YAGNI，本期不做）

- 邮箱注册、邮件验证、邮件找回密码（忘密码由站长在后台重置）。
- 无激活码的开放注册。
- 每用户多看板（先一人一看板）。
- 第三方登录（OAuth 等）、双因素、验证码图形码。
- 限流/防刷的复杂策略（仅做基础校验）。

## 角色与入口

| 角色 | 入口 | 鉴权 |
|---|---|---|
| 访客 | `/b/<slug>` | 无（只读公开页） |
| 注册用户 | `/register`、`/login`、登录后 `/app` | 用户名+密码 → 用户会话 cookie |
| 站长 | `/owner` | 站长密码（`ADMIN_PASSWORD` secret）→ 站长会话 cookie |

- `/` ：未登录跳 `/login`；已登录跳 `/app`。
- 站长会话与用户会话是**两种不同的签名 token**（用 payload 里的角色字段区分），都用 `SESSION_SECRET` 签名。

## 数据模型（D1）

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE,         -- 登录名，^[a-zA-Z0-9_-]{3,20}$
  pass_hash   TEXT    NOT NULL,                -- PBKDF2 派生，base64
  pass_salt   TEXT    NOT NULL,                -- 随机盐，base64
  board_slug  TEXT    NOT NULL UNIQUE,         -- 公开页 /b/<slug>，^[a-z0-9-]{3,32}$，默认=username（小写）
  board_name  TEXT    NOT NULL DEFAULT '',     -- 看板显示名
  created_at  TEXT    NOT NULL
);

CREATE TABLE items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,                -- 归属用户
  ticker      TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  symbol      TEXT    NOT NULL,
  fair_low    REAL    NOT NULL,
  fair_high   REAL    NOT NULL,
  mos         REAL    NOT NULL,
  ext         REAL    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE settings (
  user_id  INTEGER NOT NULL,                   -- 每用户一套文案/配色
  key      TEXT    NOT NULL,
  value    TEXT    NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE activation_codes (
  code        TEXT PRIMARY KEY,                -- 随机不易猜
  used_by     INTEGER,                         -- null=未使用；否则为 users.id
  created_at  TEXT NOT NULL,
  used_at     TEXT
);
```

settings 的 key 仍为 `eyebrow/title/subtitle/color_deep/color_under/color_fair/color_over/color_xover`（与现有一致），只是多了 `user_id` 维度。

## 接口

### 公开
| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/config?slug=<slug>` | 按看板 slug 返回 `{board:{slug,name}, items, settings}`；slug 不存在 → 404 |
| GET | `/api/quotes?symbols=` | 行情代理（不变） |
| GET | `/api/hints?q=` | 联想代理（不变） |

### 用户鉴权
| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/register` | body `{username, password, code}`；校验码未用、用户名合法且未占用、密码强度（≥6）→ 建用户+空看板、标记码已用、下发用户 cookie；失败返回 400/409 带原因 |
| POST | `/api/login` | body `{username, password}`；校验哈希 → 下发用户 cookie；失败 401 |
| POST | `/api/logout` | 清除会话 cookie |
| GET | `/api/me` | 当前登录用户信息 `{username, board:{slug,name}}`；未登录 401 |

### 用户数据（需用户会话；一律以 cookie 中的 userId 为准）
| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/my/items` | 当前用户的标的 |
| POST | `/api/my/items` | 新增（绑定当前 userId） |
| PUT | `/api/my/items/:id` | 改（仅当该 item.user_id == 当前用户，否则 404） |
| DELETE | `/api/my/items/:id` | 删（同上越权防护） |
| GET | `/api/my/settings` | 当前用户的文案/配色 |
| PUT | `/api/my/settings` | 改文案/配色（hex 校验同现有） |
| PUT | `/api/my/board` | 改看板 slug / name（slug 合法且全局唯一，否则 409） |

### 站长（需站长会话）
| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/owner/login` | body `{password}` 校验 `ADMIN_PASSWORD` → 下发站长 cookie |
| POST | `/api/owner/logout` | 清除站长 cookie |
| GET | `/api/owner/codes` | 列出激活码（含是否已用、用码人） |
| POST | `/api/owner/codes` | body `{count}` 批量生成 N 个随机激活码 |
| GET | `/api/owner/users` | 列出用户（username、board_slug、created_at） |
| POST | `/api/owner/users/:id/reset` | 重置某用户密码，返回一个新的临时密码（站长转告用户） |

未匹配的 `/api/*` → JSON 404；其余交静态资源。

## 会话与鉴权

- 沿用 HMAC-SHA256 签名 cookie（Web Crypto，`SESSION_SECRET`）。token payload 扩展为 `{ exp, role, uid? }`：
  - 用户会话：`role:"user"`, `uid:<users.id>`。
  - 站长会话：`role:"owner"`。
- 两个 cookie 名分开：`pendulum_user`、`pendulum_owner`，均 `HttpOnly; Secure; SameSite=Strict; Path=/`。
- 中间件：
  - `/api/my/*` 要求合法 user token，解析出 `uid` 注入上下文；所有查询带 `WHERE user_id = uid`。
  - `/api/owner/*`（除 `/api/owner/login`）要求合法 owner token。
- `verifyToken` 扩展为返回解析后的 payload（或 null），调用方按 `role` 判定。

## 密码哈希

- Web Crypto **PBKDF2**：`importKey(raw, password)` → `deriveBits({name:"PBKDF2", hash:"SHA-256", salt, iterations:100000}, 256)`。
- 每用户随机 16 字节盐（`crypto.getRandomValues`），盐与派生值各自 base64 存库。
- 校验：用存的盐重新派生，**常量时间**比较（复用 `timingSafeEqual`）。
- 不存明文，secret 里也不存任何用户密码。

## 激活码

- 生成：`crypto.getRandomValues` → 取 base32/16 字符的随机串（如 `XXXX-XXXX-XXXX`），插入 `activation_codes`，`used_by=null`。
- 注册时：事务内校验码存在且 `used_by IS NULL`；成功建用户后将该码 `used_by=<新用户id>, used_at=now`。已用/不存在 → 400。

## 公开页 `/b/<slug>`

- Worker 路由 `GET /b/:slug` → 返回静态 `index.html`（前端从 `location.pathname` 取 slug，调 `/api/config?slug=`）。
- `/api/config?slug=` 找不到对应看板 → 404；前端显示「看板不存在」。
- 渲染逻辑（钟摆、verdict、文案、配色）复用现有 `core.js`/`gauge.js`。

## 前端页面

- `public/index.html`：公开只读页（按 slug 取数据），样式沿用当前（白底铺满、分割线、更新时间）。
- `public/login.html`、`public/register.html`：用户登录/注册（注册含激活码框）。
- `public/app.html`：用户后台 = 现有 admin 配置界面（标的 + 文案 + 配色），改为调 `/api/my/*`，并加「看板名/网址(slug)」编辑 + 退出。
- `public/owner.html`：站长后台 = 激活码生成/列表 + 用户列表 + 重置密码。
- 共用 `shared/core.js`、`gauge.js`、`market.js`、`styles.css` 不变。

## 现有数据迁移

- 提供一次性迁移脚本/命令：把现有全局 `items` 与 `settings` 归入一个**初始用户**（站长指定 username + 初始密码 + board_slug）。
- 迁移步骤：建新表（users/activation_codes、给 items 加 user_id、settings 重建为含 user_id）→ 创建初始用户 → 现有 items/settings 的 user_id 指向该用户。
- 若选择全新部署则跳过，直接用新 schema。

## 安全要点汇总

- 密码 PBKDF2 加盐哈希，常量时间比较。
- 激活码一次性、随机、服务端校验。
- 用户接口严格按 cookie 的 `uid` 过滤，忽略前端传入的任何 user_id。
- 站长接口独立 owner 会话；站长密码仍是 `ADMIN_PASSWORD` secret。
- cookie：HttpOnly + Secure + SameSite=Strict。
- 用户名、slug 服务端正则校验；唯一性冲突返回 409。

## 开放问题

无（站长复用 `ADMIN_PASSWORD`；board_slug 默认=用户名小写、可改；均已确认）。
