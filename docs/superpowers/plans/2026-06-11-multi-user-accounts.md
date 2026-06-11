# 多用户账号系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单看板/单密码应用升级为多用户系统：激活码注册、用户名+密码登录、每用户一个看板（`/b/<slug>` 公开只读），站长后台生成激活码与管理用户。

**Architecture:** 沿用 Hono Worker + D1 + 纯 ESM 前端。新增独立可单测的后端模块（password.js 密码哈希、codes.js 激活码、users.js 校验/映射），扩展 auth.js 的会话 token 携带 `{role, uid}`，在 index.js 统一装配公开/用户/站长三类路由。前端新增 login/register/app/owner 四个页面，公开页改为按 slug 取数据。所有用户数据接口严格按 cookie 里的 `uid` 隔离。

**Tech Stack:** Cloudflare Workers + D1、Hono、Web Crypto（PBKDF2 密码哈希、HMAC 会话签名、getRandomValues 激活码）、Vitest（pool-workers + node）。

---

## 并行执行说明（给编排者）

任务分三波，**波内可并行**（文件互不重叠、各自 commit 由编排者串行落地），**波间有依赖**：

- **Wave A（独立后端模块，可并行）**：Task 2 password.js、Task 3 codes.js、Task 4 users.js、Task 5 auth.js 扩展。互不依赖，各自 TDD。
- **Wave B（前端页面，可并行，依赖契约不依赖后端代码）**：Task 8 login.html、Task 9 register.html、Task 10 app.html、Task 11 owner.html、Task 12 public index.html。互不重叠，可与 Wave A 同时进行。
- **Wave C（集成，必须串行，依赖 Wave A 全部完成）**：Task 1 schema、Task 6 index.js 路由装配、Task 7 routes 端到端测试、Task 13 迁移脚本、Task 14 联调。`index.js` 只能由一个 agent 串行改。

并行 agent **只创建/修改自己任务列出的文件**，**不要 commit**（编排者审查后统一提交），避免争用 git index。

---

## File Structure

```
schema.sql                       # 新多用户 schema（重写）
migrate-to-multiuser.sql         # 现有单看板数据 → 初始用户（新建）
src/
  password.js                    # PBKDF2 hashPassword/verifyPassword（新）
  codes.js                       # generateCode（新）
  users.js                       # validateUsername/validateSlug/rowToUser（新）
  auth.js                        # signToken/verifyToken 携带 {role,uid}（改）
  items.js                       # validateItem/rowToItem（复用，不改）
  quotes.js                      # 不改
  index.js                       # 路由装配：公开/用户/站长（重写）
test/
  password.test.js  codes.test.js  users.test.js  auth.test.js  routes.test.js
public/
  index.html                     # 公开页按 slug 取数（改）
  login.html  register.html  app.html  owner.html   # 新
  shared/core.js gauge.js market.js styles.css       # 不改
```

---

## 契约（所有并行任务共享，务必一致）

**会话 token（auth.js）**
- `signToken(secret, claims, ttlSeconds)` → 字符串。claims 形如 `{role:"user", uid:7}` 或 `{role:"owner"}`，内部加 `exp`。
- `verifyToken(secret, token)` → 验证通过返回 claims 对象 `{exp, role, uid?}`，否则返回 `null`。

**cookie 名**：用户 `pendulum_user`，站长 `pendulum_owner`。都 `HttpOnly; Secure; SameSite=Strict; Path=/`。

**密码（password.js）**
- `hashPassword(password)` → `{hash, salt}`（均 base64 字符串）。
- `verifyPassword(password, saltB64, hashB64)` → `boolean`。

**API 请求/返回**（前端按此写）：
- `GET /api/config?slug=<slug>` → 200 `{board:{slug,name}, items:[...], settings:{...}}`；未知 slug → 404 `{error}`。
- `POST /api/register` `{username,password,code}` → 200 `{ok:true, board:{slug,name}}` + set user cookie；错误 400/409 `{ok:false, error}`。
- `POST /api/login` `{username,password}` → 200 `{ok:true}` + cookie；401 `{ok:false}`。
- `POST /api/logout` → 200 `{ok:true}`。
- `GET /api/me` → 200 `{username, board:{slug,name}}`；401。
- `GET /api/my/items` → `{items:[...]}`。`POST /api/my/items` → 201 `{ok,id}`。`PUT/DELETE /api/my/items/:id` → `{ok}` / 404。
- `GET /api/my/settings` → `{settings}`。`PUT /api/my/settings` → `{ok, settings}`。
- `PUT /api/my/board` `{slug,name}` → `{ok, board}`；slug 冲突 409。
- `POST /api/owner/login` `{password}` → cookie；401。`POST /api/owner/logout`。
- `GET /api/owner/codes` → `{codes:[{code,used,usedBy}]}`。`POST /api/owner/codes` `{count}` → `{ok, created:[code,...]}`。
- `GET /api/owner/users` → `{users:[{id,username,boardSlug,createdAt}]}`。
- `POST /api/owner/users/:id/reset` → `{ok, password:"<临时明文>"}`。

item 对象（camelCase）：`{id,ticker,name,symbol,fairLow,fairHigh,mos,ext,sortOrder}`（不含 user_id）。
settings keys：`eyebrow,title,subtitle,color_deep,color_under,color_fair,color_over,color_xover`。

---

## Task 1: 新 schema（Wave C，先做以便测试建表参照）

**Files:** Modify `schema.sql`; Create `migrate-to-multiuser.sql`（迁移在 Task 13）

- [ ] **Step 1: 重写 schema.sql**
```sql
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE,
  pass_hash   TEXT    NOT NULL,
  pass_salt   TEXT    NOT NULL,
  board_slug  TEXT    NOT NULL UNIQUE,
  board_name  TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);
CREATE TABLE IF NOT EXISTS settings (
  user_id  INTEGER NOT NULL,
  key      TEXT    NOT NULL,
  value    TEXT    NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS activation_codes (
  code        TEXT PRIMARY KEY,
  used_by     INTEGER,
  created_at  TEXT NOT NULL,
  used_at     TEXT
);
```

- [ ] **Step 2: Commit**
```bash
git add schema.sql
git commit -m "feat: multi-user schema (users, per-user items/settings, activation codes)"
```

---

## Task 2: password.js — PBKDF2 哈希（Wave A，TDD）

**Files:** Create `src/password.js`; Test `test/password.test.js`

- [ ] **Step 1: 写失败测试** — Create `test/password.test.js`:
```js
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/password.js";

describe("password", () => {
  it("verifies the correct password", async () => {
    const { hash, salt } = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", salt, hash)).toBe(true);
  });
  it("rejects a wrong password", async () => {
    const { hash, salt } = await hashPassword("hunter2");
    expect(await verifyPassword("nope", salt, hash)).toBe(false);
  });
  it("uses a random salt (two hashes differ)", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
  it("rejects when salt is tampered", async () => {
    const { hash } = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", "AAAA", hash)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL** — `npx vitest run test/password.test.js` → module missing.

- [ ] **Step 3: 实现 src/password.js**
```js
// PBKDF2-SHA256 加盐密码哈希（Web Crypto）。hash/salt 均 base64 存储。
const ITER = 100000, KEYLEN = 32, SALTLEN = 16;

function b64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function unb64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }

async function derive(password, saltBytes) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: ITER }, key, KEYLEN * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALTLEN));
  const hash = await derive(password, salt);
  return { hash: b64(hash), salt: b64(salt) };
}

export async function verifyPassword(password, saltB64, hashB64) {
  let expected, salt;
  try { salt = unb64(saltB64); expected = unb64(hashB64); } catch { return false; }
  const actual = await derive(password, salt);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
```

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run test/password.test.js`.
- [ ] **Step 5: Commit** — `git add src/password.js test/password.test.js && git commit -m "feat: PBKDF2 password hashing"`

---

## Task 3: codes.js — 激活码生成（Wave A，TDD）

**Files:** Create `src/codes.js`; Test `test/codes.test.js`

- [ ] **Step 1: 写失败测试** — Create `test/codes.test.js`:
```js
import { describe, it, expect } from "vitest";
import { generateCode } from "../src/codes.js";

describe("generateCode", () => {
  it("matches XXXX-XXXX-XXXX of unambiguous base32 chars", () => {
    expect(generateCode()).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });
  it("is random (100 codes all unique)", () => {
    const set = new Set();
    for (let i = 0; i < 100; i++) set.add(generateCode());
    expect(set.size).toBe(100);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL** — `npx vitest run test/codes.test.js`.

- [ ] **Step 3: 实现 src/codes.js**
```js
// 去歧义字符集（无 0/1/I/O）。生成形如 XXXX-XXXX-XXXX 的一次性激活码。
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars
export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) out += "-";
    out += ALPHABET[bytes[i] & 31];
  }
  return out;
}
```

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run test/codes.test.js`.
- [ ] **Step 5: Commit** — `git add src/codes.js test/codes.test.js && git commit -m "feat: activation code generator"`

---

## Task 4: users.js — 校验与行映射（Wave A，TDD）

**Files:** Create `src/users.js`; Test `test/users.test.js`

- [ ] **Step 1: 写失败测试** — Create `test/users.test.js`:
```js
import { describe, it, expect } from "vitest";
import { validateUsername, validateSlug, rowToUser } from "../src/users.js";

describe("validateUsername", () => {
  it("accepts 3-20 of [A-Za-z0-9_-]", () => {
    expect(validateUsername("jony_2")).toBe(true);
    expect(validateUsername("ab")).toBe(false);      // too short
    expect(validateUsername("has space")).toBe(false);
    expect(validateUsername("a".repeat(21))).toBe(false);
  });
});
describe("validateSlug", () => {
  it("accepts 3-32 lowercase/digit/hyphen", () => {
    expect(validateSlug("my-board")).toBe(true);
    expect(validateSlug("UP")).toBe(false);
    expect(validateSlug("a")).toBe(false);
  });
});
describe("rowToUser", () => {
  it("maps a row without exposing hash/salt", () => {
    const r = { id: 3, username: "jony", pass_hash: "x", pass_salt: "y", board_slug: "j", board_name: "J", created_at: "t" };
    expect(rowToUser(r)).toEqual({ id: 3, username: "jony", boardSlug: "j", boardName: "J", createdAt: "t" });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL** — `npx vitest run test/users.test.js`.

- [ ] **Step 3: 实现 src/users.js**
```js
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const SLUG_RE = /^[a-z0-9-]{3,32}$/;
export function validateUsername(s) { return typeof s === "string" && USERNAME_RE.test(s); }
export function validateSlug(s) { return typeof s === "string" && SLUG_RE.test(s); }
export function rowToUser(r) {
  return { id: r.id, username: r.username, boardSlug: r.board_slug, boardName: r.board_name, createdAt: r.created_at };
}
```

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run test/users.test.js`.
- [ ] **Step 5: Commit** — `git add src/users.js test/users.test.js && git commit -m "feat: user validation and row mapping"`

---

## Task 5: auth.js — token 携带 role/uid（Wave A，TDD）

**Files:** Modify `src/auth.js`; Modify `test/auth.test.js`

- [ ] **Step 1: 重写 test/auth.test.js**
```js
import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/auth.js";
const SECRET = "unit-secret";

describe("auth token with claims", () => {
  it("round-trips role and uid", async () => {
    const t = await signToken(SECRET, { role: "user", uid: 7 }, 3600);
    const c = await verifyToken(SECRET, t);
    expect(c).toMatchObject({ role: "user", uid: 7 });
    expect(typeof c.exp).toBe("number");
  });
  it("returns null for tampered token", async () => {
    const t = await signToken(SECRET, { role: "owner" }, 3600);
    expect(await verifyToken(SECRET, t + "x")).toBe(null);
  });
  it("returns null for wrong secret", async () => {
    const t = await signToken(SECRET, { role: "owner" }, 3600);
    expect(await verifyToken("other", t)).toBe(null);
  });
  it("returns null for expired token", async () => {
    const t = await signToken(SECRET, { role: "user", uid: 1 }, -1);
    expect(await verifyToken(SECRET, t)).toBe(null);
  });
  it("returns null for malformed token", async () => {
    expect(await verifyToken(SECRET, "a.b.c")).toBe(null);
    expect(await verifyToken(SECRET, "garbage")).toBe(null);
  });
});
```

- [ ] **Step 2: Run, confirm FAIL** — `npx vitest run test/auth.test.js` (signToken signature changed).

- [ ] **Step 3: 重写 src/auth.js**
```js
// HMAC-SHA256 签名的无状态会话 token，携带任意 claims（如 role/uid）。
// 格式: base64url(JSON {...claims, exp}) + "." + base64url(hmac)
function b64urlEncode(bytes) {
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToBytes(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}
function nowSeconds() { return Math.floor(Date.now() / 1000); }
// Constant-time compare for equal-length ASCII strings (base64url MAC).
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0;
}

export async function signToken(secret, claims, ttlSeconds) {
  const body = { ...claims, exp: nowSeconds() + ttlSeconds };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}
// 返回 claims 对象（含 exp/role/uid）或 null。
export async function verifyToken(secret, token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!timingSafeEqual(sig, await hmac(secret, payload))) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payload)));
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds()) return null;
    return claims;
  } catch { return null; }
}
```

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run test/auth.test.js`.
- [ ] **Step 5: Commit** — `git add src/auth.js test/auth.test.js && git commit -m "feat: session token carries role/uid claims"`

---

## Task 6: index.js — 路由装配（Wave C，串行，依赖 Task 1-5）

**Files:** Rewrite `src/index.js`

- [ ] **Step 1: 重写 src/index.js**（完整内容）
```js
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { signToken, verifyToken } from "./auth.js";
import { validateItem, rowToItem } from "./items.js";
import { parseTencentQuotes, parseTencentHints } from "./quotes.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateCode } from "./codes.js";
import { validateUsername, validateSlug, rowToUser } from "./users.js";

const app = new Hono();
const USER_COOKIE = "pendulum_user", OWNER_COOKIE = "pendulum_owner";
const TTL = 7 * 24 * 3600;
const TEXT_KEYS = ["eyebrow", "title", "subtitle"];
const COLOR_KEYS = ["color_deep", "color_under", "color_fair", "color_over", "color_xover"];
const SETTING_KEYS = [...TEXT_KEYS, ...COLOR_KEYS];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: TTL };

async function readSettings(db, userId) {
  const out = {};
  try {
    const { results } = await db.prepare("SELECT key, value FROM settings WHERE user_id=?").bind(userId).all();
    for (const r of results || []) if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value;
  } catch {}
  return out;
}
async function fetchGbk(url) {
  const res = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return new TextDecoder("gbk").decode(await res.arrayBuffer());
}

/* ---------- 公开接口 ---------- */
app.get("/api/config", async (c) => {
  const slug = c.req.query("slug") || "";
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE board_slug=?").bind(slug).first();
  if (!user) return c.json({ error: "board not found" }, 404);
  const { results } = await c.env.DB.prepare("SELECT * FROM items WHERE user_id=? ORDER BY sort_order ASC, id ASC").bind(user.id).all();
  return c.json({ board: { slug: user.board_slug, name: user.board_name }, items: (results || []).map(rowToItem), settings: await readSettings(c.env.DB, user.id) });
});
app.get("/api/quotes", async (c) => {
  const symbols = (c.req.query("symbols") || "").split(",").map((s) => s.trim()).filter((s) => s && s.length <= 16).slice(0, 50);
  if (!symbols.length) return c.json({ quotes: {}, ts: new Date().toISOString() });
  try { const text = await fetchGbk("https://qt.gtimg.cn/q=" + symbols.join(",")); return c.json({ quotes: parseTencentQuotes(text, symbols), ts: new Date().toISOString() }); }
  catch { return c.json({ quotes: {}, error: "upstream unreachable", ts: new Date().toISOString() }, 502); }
});
app.get("/api/hints", async (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.json({ hints: [] });
  try { const text = await fetchGbk("https://smartbox.gtimg.cn/s3/?v=2&t=all&q=" + encodeURIComponent(q)); return c.json({ hints: parseTencentHints(text) }); }
  catch { return c.json({ hints: [] }); }
});

/* ---------- 注册 / 登录 ---------- */
app.post("/api/register", async (c) => {
  const { username, password, code } = await c.req.json().catch(() => ({}));
  if (!validateUsername(username)) return c.json({ ok: false, error: "用户名需 3-20 位字母/数字/_/-" }, 400);
  if (typeof password !== "string" || password.length < 6) return c.json({ ok: false, error: "密码至少 6 位" }, 400);
  const codeRow = await c.env.DB.prepare("SELECT code FROM activation_codes WHERE code=? AND used_by IS NULL").bind(code || "").first();
  if (!codeRow) return c.json({ ok: false, error: "激活码无效或已被使用" }, 400);
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first();
  if (exists) return c.json({ ok: false, error: "用户名已被占用" }, 409);
  let slug = username.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!validateSlug(slug)) slug = "b-" + slug;
  if (await c.env.DB.prepare("SELECT id FROM users WHERE board_slug=?").bind(slug).first()) slug = slug + "-" + (Date.now() % 10000);
  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  const { meta } = await c.env.DB.prepare(
    "INSERT INTO users (username,pass_hash,pass_salt,board_slug,board_name,created_at) VALUES (?,?,?,?,?,?)"
  ).bind(username, hash, salt, slug, username, now).run();
  await c.env.DB.prepare("UPDATE activation_codes SET used_by=?, used_at=? WHERE code=?").bind(meta.last_row_id, now, code).run();
  const token = await signToken(c.env.SESSION_SECRET, { role: "user", uid: meta.last_row_id }, TTL);
  setCookie(c, USER_COOKIE, token, COOKIE_OPTS);
  return c.json({ ok: true, board: { slug, name: username } });
});
app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username=?").bind(username || "").first();
  if (!user || !(await verifyPassword(password || "", user.pass_salt, user.pass_hash))) return c.json({ ok: false, error: "用户名或密码错误" }, 401);
  const token = await signToken(c.env.SESSION_SECRET, { role: "user", uid: user.id }, TTL);
  setCookie(c, USER_COOKIE, token, COOKIE_OPTS);
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => { setCookie(c, USER_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 }); return c.json({ ok: true }); });

/* ---------- 用户会话中间件 ---------- */
async function currentUserId(c) {
  const token = getCookie(c, USER_COOKIE);
  if (!token) return null;
  const claims = await verifyToken(c.env.SESSION_SECRET, token);
  return claims && claims.role === "user" ? claims.uid : null;
}
app.get("/api/me", async (c) => {
  const uid = await currentUserId(c);
  if (!uid) return c.json({ ok: false, error: "unauthorized" }, 401);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
  if (!user) return c.json({ ok: false }, 401);
  return c.json({ username: user.username, board: { slug: user.board_slug, name: user.board_name } });
});
app.use("/api/my/*", async (c, next) => {
  const uid = await currentUserId(c);
  if (!uid) return c.json({ ok: false, error: "unauthorized" }, 401);
  c.set("uid", uid);
  await next();
});

/* ---------- 用户数据 CRUD（按 uid 隔离） ---------- */
app.get("/api/my/items", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM items WHERE user_id=? ORDER BY sort_order ASC, id ASC").bind(c.get("uid")).all();
  return c.json({ items: (results || []).map(rowToItem) });
});
app.post("/api/my/items", async (c) => {
  const v = validateItem(await c.req.json().catch(() => ({})));
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const it = v.value;
  const { meta } = await c.env.DB.prepare(
    "INSERT INTO items (user_id,ticker,name,symbol,fair_low,fair_high,mos,ext,sort_order,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(c.get("uid"), it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder, new Date().toISOString()).run();
  return c.json({ ok: true, id: meta.last_row_id }, 201);
});
app.put("/api/my/items/:id", async (c) => {
  const v = validateItem(await c.req.json().catch(() => ({})));
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const it = v.value;
  const { meta } = await c.env.DB.prepare(
    "UPDATE items SET ticker=?,name=?,symbol=?,fair_low=?,fair_high=?,mos=?,ext=?,sort_order=?,updated_at=? WHERE id=? AND user_id=?"
  ).bind(it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder, new Date().toISOString(), Number(c.req.param("id")), c.get("uid")).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true });
});
app.delete("/api/my/items/:id", async (c) => {
  const { meta } = await c.env.DB.prepare("DELETE FROM items WHERE id=? AND user_id=?").bind(Number(c.req.param("id")), c.get("uid")).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true });
});
app.get("/api/my/settings", async (c) => c.json({ settings: await readSettings(c.env.DB, c.get("uid")) }));
app.put("/api/my/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const uid = c.get("uid"), stmts = [];
  for (const k of SETTING_KEYS) {
    if (!(k in body)) continue;
    const val = typeof body[k] === "string" ? body[k].trim() : "";
    if (COLOR_KEYS.includes(k) && val && !HEX_RE.test(val)) continue;
    stmts.push(val
      ? c.env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").bind(uid, k, val)
      : c.env.DB.prepare("DELETE FROM settings WHERE user_id=? AND key=?").bind(uid, k));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, settings: await readSettings(c.env.DB, uid) });
});
app.put("/api/my/board", async (c) => {
  const { slug, name } = await c.req.json().catch(() => ({}));
  if (!validateSlug(slug)) return c.json({ ok: false, error: "网址 slug 需 3-32 位小写字母/数字/-" }, 400);
  const clash = await c.env.DB.prepare("SELECT id FROM users WHERE board_slug=? AND id<>?").bind(slug, c.get("uid")).first();
  if (clash) return c.json({ ok: false, error: "该网址已被占用" }, 409);
  await c.env.DB.prepare("UPDATE users SET board_slug=?, board_name=? WHERE id=?").bind(slug, typeof name === "string" ? name : "", c.get("uid")).run();
  return c.json({ ok: true, board: { slug, name: name || "" } });
});

/* ---------- 站长 ---------- */
app.post("/api/owner/login", async (c) => {
  const { password } = await c.req.json().catch(() => ({}));
  if (!password || password !== c.env.ADMIN_PASSWORD) return c.json({ ok: false, error: "密码错误" }, 401);
  const token = await signToken(c.env.SESSION_SECRET, { role: "owner" }, TTL);
  setCookie(c, OWNER_COOKIE, token, COOKIE_OPTS);
  return c.json({ ok: true });
});
app.post("/api/owner/logout", (c) => { setCookie(c, OWNER_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 }); return c.json({ ok: true }); });
app.use("/api/owner/*", async (c, next) => {
  if (c.req.path === "/api/owner/login") return next();
  const token = getCookie(c, OWNER_COOKIE);
  const claims = token ? await verifyToken(c.env.SESSION_SECRET, token) : null;
  if (!claims || claims.role !== "owner") return c.json({ ok: false, error: "unauthorized" }, 401);
  await next();
});
app.get("/api/owner/codes", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT code, used_by, used_at, created_at FROM activation_codes ORDER BY created_at DESC").all();
  return c.json({ codes: (results || []).map((r) => ({ code: r.code, used: r.used_by != null, usedBy: r.used_by, usedAt: r.used_at })) });
});
app.post("/api/owner/codes", async (c) => {
  const { count } = await c.req.json().catch(() => ({}));
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const now = new Date().toISOString(), created = [], stmts = [];
  for (let i = 0; i < n; i++) { const code = generateCode(); created.push(code); stmts.push(c.env.DB.prepare("INSERT INTO activation_codes (code,used_by,created_at,used_at) VALUES (?,?,?,?)").bind(code, null, now, null)); }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, created });
});
app.get("/api/owner/users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  return c.json({ users: (results || []).map(rowToUser) });
});
app.post("/api/owner/users/:id/reset", async (c) => {
  const tmp = generateCode();
  const { hash, salt } = await hashPassword(tmp);
  const { meta } = await c.env.DB.prepare("UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?").bind(hash, salt, Number(c.req.param("id"))).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, password: tmp });
});

/* ---------- 公开页路由 + 静态 ---------- */
app.get("/b/:slug", (c) => { const url = new URL(c.req.url); url.pathname = "/index.html"; return c.env.ASSETS.fetch(new Request(url, c.req.raw)); });
app.all("*", (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ ok: false, error: "not found" }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});
export default app;
```

- [ ] **Step 2: 健全性** — `node --check src/index.js` 无错。
- [ ] **Step 3: Commit** — `git add src/index.js && git commit -m "feat: wire multi-user routes (auth, per-user data, owner)"`

---

## Task 7: routes.test.js — 端到端（Wave C，串行，依赖 Task 6）

**Files:** Rewrite `test/routes.test.js`

> pool-workers 共享存储；用唯一 username/slug 避免跨用例干扰，断言不依赖总数。

- [ ] **Step 1: 重写 test/routes.test.js**
```js
import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL, mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`).run();
});

async function ownerCookie() {
  const r = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-pass" }) });
  const ck = r.headers.get("set-cookie"); if (!ck) throw new Error("owner login failed"); return ck;
}
async function mintCode() {
  const r = await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { "content-type": "application/json", cookie: await ownerCookie() }, body: JSON.stringify({ count: 1 }) });
  return (await r.json()).created[0];
}
async function register(username) {
  const code = await mintCode();
  const r = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "secret1", code }) });
  return { res: r, cookie: r.headers.get("set-cookie") };
}

describe("owner", () => {
  it("rejects wrong owner password", async () => {
    const r = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "no" }) });
    expect(r.status).toBe(401);
  });
  it("gates code listing without owner session", async () => {
    expect((await SELF.fetch("https://x/api/owner/codes")).status).toBe(401);
  });
  it("mints activation codes", async () => {
    const r = await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { "content-type": "application/json", cookie: await ownerCookie() }, body: JSON.stringify({ count: 3 }) });
    expect(r.status).toBe(200); expect((await r.json()).created.length).toBe(3);
  });
});

describe("register + login", () => {
  it("registers with a valid code and rejects reuse", async () => {
    const code = await mintCode();
    const ok = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password: "secret1", code }) });
    expect(ok.status).toBe(200);
    const reuse = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice2", password: "secret1", code }) });
    expect(reuse.status).toBe(400);
  });
  it("rejects an invalid code", async () => {
    const r = await SELF.fetch("https://x/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bob", password: "secret1", code: "NOPE-NOPE-NOPE" }) });
    expect(r.status).toBe(400);
  });
  it("logs in and reaches /api/me", async () => {
    const { cookie } = await register("carol");
    const me = await SELF.fetch("https://x/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).username).toBe("carol");
  });
});

describe("per-user isolation", () => {
  it("a user only sees their own items; public board shows them", async () => {
    const a = await register("dave"); const b = await register("erin");
    await SELF.fetch("https://x/api/my/items", { method: "POST", headers: { "content-type": "application/json", cookie: a.cookie }, body: JSON.stringify({ ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 }) });
    const aItems = await (await SELF.fetch("https://x/api/my/items", { headers: { cookie: a.cookie } })).json();
    const bItems = await (await SELF.fetch("https://x/api/my/items", { headers: { cookie: b.cookie } })).json();
    expect(aItems.items.length).toBe(1);
    expect(bItems.items.length).toBe(0);
    const pub = await (await SELF.fetch("https://x/api/config?slug=dave")).json();
    expect(pub.items.some((i) => i.symbol === "usAAPL")).toBe(true);
  });
  it("blocks my/items without session", async () => {
    expect((await SELF.fetch("https://x/api/my/items")).status).toBe(401);
  });
  it("404s an unknown public board slug", async () => {
    expect((await SELF.fetch("https://x/api/config?slug=nobody")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run test/routes.test.js` → 全过。
- [ ] **Step 3: 全量** — `npx vitest run` 全绿。
- [ ] **Step 4: Commit** — `git add test/routes.test.js && git commit -m "test: e2e multi-user auth, isolation, owner codes"`

---

## Task 8: login.html（Wave B）

**Files:** Create `public/login.html`

- [ ] **Step 1: 创建页面**（链接 styles.css；表单调 `/api/login`，成功跳 `/app`，失败显示错误；附「没有账号？去注册」链接到 `/register`）
```html
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>登录 · 估值钟摆</title>
<link rel="stylesheet" href="/shared/styles.css">
<style>.auth{max-width:360px;margin:80px auto;background:var(--card);border-radius:18px;box-shadow:var(--shadow);padding:28px 24px}
.auth h2{font-size:18px;margin:0 0 16px}.auth input{width:100%;font-size:14px;padding:10px;border:1px solid #dfe3ea;border-radius:8px;margin-bottom:12px}
.auth .err{color:var(--red);font-size:12px;margin-bottom:10px;min-height:16px}.auth .alt{font-size:12.5px;color:var(--ink-soft);margin-top:14px;text-align:center}</style>
</head><body><div class="page"><div class="auth">
<h2>登录</h2><div class="err" id="err"></div>
<input id="u" placeholder="用户名" autocomplete="username">
<input id="p" type="password" placeholder="密码" autocomplete="current-password">
<button class="btn primary" id="go" style="width:100%">登录</button>
<div class="alt">没有账号？<a href="/register">用激活码注册</a></div>
</div></div>
<script type="module">
const err=document.getElementById("err");
async function login(){ err.textContent="";
  const r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:document.getElementById("u").value,password:document.getElementById("p").value})});
  if(r.ok) location.href="/app"; else err.textContent=(await r.json().catch(()=>({}))).error||"登录失败"; }
document.getElementById("go").addEventListener("click",login);
document.getElementById("p").addEventListener("keydown",(e)=>{if(e.key==="Enter")login();});
</script></body></html>
```
- [ ] **Step 2:** `awk '/<script type="module">/{f=1;next}/<\/script>/{f=0}f' public/login.html > /tmp/c.mjs && node --check /tmp/c.mjs && rm /tmp/c.mjs` → 通过。
- [ ] **Step 3: Commit** — `git add public/login.html && git commit -m "feat: login page"`

---

## Task 9: register.html（Wave B）

**Files:** Create `public/register.html`

- [ ] **Step 1: 创建页面**（用户名/密码/激活码三个框，调 `/api/register`，成功跳 `/app`，失败显示 `error`；附「已有账号？去登录」）
```html
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>注册 · 估值钟摆</title>
<link rel="stylesheet" href="/shared/styles.css">
<style>.auth{max-width:380px;margin:72px auto;background:var(--card);border-radius:18px;box-shadow:var(--shadow);padding:28px 24px}
.auth h2{font-size:18px;margin:0 0 6px}.auth p.hint{font-size:12px;color:var(--ink-soft);margin:0 0 16px}
.auth input{width:100%;font-size:14px;padding:10px;border:1px solid #dfe3ea;border-radius:8px;margin-bottom:12px}
.auth .err{color:var(--red);font-size:12px;margin-bottom:10px;min-height:16px}.auth .alt{font-size:12.5px;color:var(--ink-soft);margin-top:14px;text-align:center}</style>
</head><body><div class="page"><div class="auth">
<h2>注册</h2><p class="hint">需要一枚激活码（向站长索取）。</p><div class="err" id="err"></div>
<input id="u" placeholder="用户名（3-20 位字母/数字/_-）" autocomplete="username">
<input id="p" type="password" placeholder="密码（至少 6 位）" autocomplete="new-password">
<input id="c" placeholder="激活码 XXXX-XXXX-XXXX">
<button class="btn primary" id="go" style="width:100%">注册并进入</button>
<div class="alt">已有账号？<a href="/login">去登录</a></div>
</div></div>
<script type="module">
const err=document.getElementById("err");
async function reg(){ err.textContent="";
  const r=await fetch("/api/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:document.getElementById("u").value.trim(),password:document.getElementById("p").value,code:document.getElementById("c").value.trim()})});
  if(r.ok) location.href="/app"; else err.textContent=(await r.json().catch(()=>({}))).error||"注册失败"; }
document.getElementById("go").addEventListener("click",reg);
</script></body></html>
```
- [ ] **Step 2:** node --check 内联脚本（同 Task 8 方式）→ 通过。
- [ ] **Step 3: Commit** — `git add public/register.html && git commit -m "feat: register page"`

---

## Task 10: app.html — 用户后台（Wave B）

**Files:** Create `public/app.html`（以现有 `public/admin.html` 为模板改造）

- [ ] **Step 1:** 读取现有 `public/admin.html` 作为模板，复制为 `public/app.html`，做如下**精确改动**：
  - 删除「登录门」`#gate` 那段 HTML 与其登录逻辑；改为：页面加载先 `GET /api/me`，401 则 `location.href="/login"`，否则显示配置界面。
  - 所有接口前缀改成用户态：`/api/admin/items` → `/api/my/items`；`/api/admin/settings` → `/api/my/settings`（GET/PUT 同名调整）。
  - 顶部新增「看板设置」区块：两个输入框（看板名 `name`、网址 slug），调 `PUT /api/my/board` 保存（防抖 600ms），显示公开链接 `/b/<slug>`（slug 改动后更新）；slug 冲突时显示 409 的 `error`。
  - 「退出」按钮调 `POST /api/logout` 后跳 `/login`。
  - 标的联想仍调 `/api/hints`，行情 `/api/quotes`，配色/文案逻辑不变（仅接口前缀变 `/api/my/settings`）。
  - 页面标题与头部文案改为「我的看板 · 配置」。
- [ ] **Step 2:** node --check 内联脚本 → 通过。
- [ ] **Step 3: Commit** — `git add public/app.html && git commit -m "feat: user dashboard (per-user board config)"`

> 实现要点（契约）：item 保存仍走防抖 + `_saving/_pendingSave` 串行（沿用 admin.html 既有逻辑，避免重复 POST）；颜色/文案 PUT 到 `/api/my/settings`；看板 slug/name PUT 到 `/api/my/board`。

---

## Task 11: owner.html — 站长后台（Wave B）

**Files:** Create `public/owner.html`

- [ ] **Step 1: 创建页面**：登录门（调 `/api/owner/login`）→ 进入后两块：
  - **激活码**：输入数量 + 「生成」按钮（`POST /api/owner/codes {count}`），下方表格列出 `GET /api/owner/codes`（code、是否已用、用码人 id），生成后刷新列表；每个未用码旁一个「复制」按钮。
  - **用户**：`GET /api/owner/users` 列表（username、board_slug、created_at），每行一个「重置密码」按钮（`POST /api/owner/users/:id/reset` → 弹出返回的临时密码让站长复制转告）。
  - 「退出」调 `/api/owner/logout`。
```html
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>站长后台 · 估值钟摆</title>
<link rel="stylesheet" href="/shared/styles.css">
<style>.wrap{max-width:760px;margin:40px auto}.gate{max-width:360px;margin:80px auto;background:var(--card);border-radius:18px;box-shadow:var(--shadow);padding:28px 24px}
.gate input{width:100%;font-size:14px;padding:10px;border:1px solid #dfe3ea;border-radius:8px;margin-bottom:12px}
.card{background:var(--card);border-radius:16px;box-shadow:var(--shadow);padding:18px 20px;margin-bottom:20px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.hidden{display:none}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #eef0f3}
.mono{font-family:var(--mono)}.err{color:var(--red);font-size:12px;min-height:16px}</style>
</head><body>
<div class="gate" id="gate"><h2>站长登录</h2><div class="err" id="gerr"></div>
<input id="pw" type="password" placeholder="站长密码"><button class="btn primary" id="gin" style="width:100%">进入</button></div>
<div class="wrap hidden" id="app">
  <div class="row" style="justify-content:space-between"><h1>站长后台</h1><button class="btn" id="out">退出</button></div>
  <div class="card"><div class="row"><b>激活码</b><input id="cnt" type="number" min="1" max="50" value="5" style="width:70px">
    <button class="btn primary" id="gen">生成</button></div><div id="codes"></div></div>
  <div class="card"><b>用户</b><div id="users"></div></div>
</div>
<script type="module">
const $=(id)=>document.getElementById(id);
async function tryLoad(){ const r=await fetch("/api/owner/codes"); if(r.status===401) return false;
  $("gate").classList.add("hidden"); $("app").classList.remove("hidden"); await refreshCodes(); await refreshUsers(); return true; }
async function login(){ $("gerr").textContent="";
  const r=await fetch("/api/owner/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:$("pw").value})});
  if(r.ok) tryLoad(); else $("gerr").textContent="密码错误"; }
$("gin").addEventListener("click",login); $("pw").addEventListener("keydown",(e)=>{if(e.key==="Enter")login();});
$("out").addEventListener("click",async()=>{await fetch("/api/owner/logout",{method:"POST"});location.reload();});
$("gen").addEventListener("click",async()=>{ await fetch("/api/owner/codes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({count:Number($("cnt").value)||1})}); refreshCodes(); });
async function refreshCodes(){ const {codes}=await (await fetch("/api/owner/codes")).json();
  $("codes").innerHTML="<table><tr><th>激活码</th><th>状态</th></tr>"+codes.map(c=>`<tr><td class="mono">${c.code}</td><td>${c.used?"已用":"未用"}</td></tr>`).join("")+"</table>"; }
async function refreshUsers(){ const {users}=await (await fetch("/api/owner/users")).json();
  const t=document.createElement("div");
  t.innerHTML="<table><tr><th>用户名</th><th>网址</th><th>注册时间</th><th></th></tr>"+users.map(u=>`<tr><td>${u.username}</td><td class="mono">/b/${u.boardSlug}</td><td>${(u.createdAt||"").slice(0,10)}</td><td><button class="btn" data-id="${u.id}">重置密码</button></td></tr>`).join("")+"</table>";
  t.querySelectorAll("button[data-id]").forEach(b=>b.addEventListener("click",async()=>{ const r=await fetch(`/api/owner/users/${b.dataset.id}/reset`,{method:"POST"}); const j=await r.json(); if(j.ok) alert("临时密码（转告该用户，登录后请改）：\n"+j.password); }));
  $("users").innerHTML=""; $("users").appendChild(t); }
tryLoad();
</script></body></html>
```
- [ ] **Step 2:** node --check 内联脚本 → 通过。
- [ ] **Step 3: Commit** — `git add public/owner.html && git commit -m "feat: owner backend (codes, users, password reset)"`

---

## Task 12: index.html — 公开页按 slug 取数（Wave B）

**Files:** Modify `public/index.html`

- [ ] **Step 1:** 读取现有 `public/index.html`，改 `loadConfig`：从 `location.pathname` 解析 slug（`/b/<slug>` → slug；根路径或无 slug → 显示「缺少看板」），调 `fetch("/api/config?slug="+encodeURIComponent(slug))`；404 时 `chartsEl.innerHTML='<div class="charts-empty">看板不存在。</div>'` 并 return。其余（applySettings/applyColors/addChart/fetchQuotes、样式）不变。
```js
// loadConfig 顶部新增解析；替换原 fetch("/api/config")
const m = location.pathname.match(/^\/b\/([^/]+)/);
const slug = m ? decodeURIComponent(m[1]) : "";
if (!slug) { chartsEl.innerHTML = '<div class="charts-empty">缺少看板地址（/b/&lt;slug&gt;）。</div>'; return; }
let data;
try {
  const res = await fetch("/api/config?slug=" + encodeURIComponent(slug));
  if (res.status === 404) { chartsEl.innerHTML = '<div class="charts-empty">看板不存在。</div>'; return; }
  data = await res.json();
} catch { chartsEl.innerHTML = '<div class="charts-empty">加载失败，请稍后重试。</div>'; return; }
applySettings(data.settings || {}); applyColors(data.settings || {});
const rows = data.items || [];
```
（保留原有空看板/渲染逻辑；将原 `rows` 赋值与 try/catch 替换为上面这段。）
- [ ] **Step 2:** node --check 内联脚本 → 通过。
- [ ] **Step 3: Commit** — `git add public/index.html && git commit -m "feat: public board reads by /b/<slug>"`

---

## Task 13: 迁移脚本（Wave C，串行，文档用）

**Files:** Create `migrate-to-multiuser.sql`；更新 `README.md` 迁移说明

> 用于把**已有单看板数据**迁到多用户结构。新部署可跳过（直接用 schema.sql）。需先有一个初始用户——因为旧 items 无 user_id，迁移把它们归到 user 1。

- [ ] **Step 1: Create migrate-to-multiuser.sql**
```sql
-- 一次性迁移：旧（无 user 概念）→ 多用户。仅在已有数据的库上跑一次。
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT);

-- 占位初始用户（pass_hash/salt 先留空，迁移后用站长后台「重置密码」生成可用密码）
INSERT OR IGNORE INTO users (id, username, pass_hash, pass_salt, board_slug, board_name, created_at)
VALUES (1, 'owner', '', '', 'main', '默认看板', datetime('now'));

ALTER TABLE items ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE settings RENAME TO settings_old;
CREATE TABLE settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
INSERT INTO settings (user_id, key, value) SELECT 1, key, value FROM settings_old;
DROP TABLE settings_old;
```
> 迁移后该初始用户密码为空（无法登录）——在站长后台对 `owner` 用户点「重置密码」拿到临时密码即可登录；或新部署直接注册。

- [ ] **Step 2: README** — 增补「从单看板迁移」一节：跑 `wrangler d1 execute <db> --remote --file=./migrate-to-multiuser.sql`，再设 `ADMIN_PASSWORD`，进 `/owner` 生成激活码 / 重置初始用户密码。新部署用 `schema.sql`。
- [ ] **Step 3: Commit** — `git add migrate-to-multiuser.sql README.md && git commit -m "docs: single-board to multi-user migration"`

---

## Task 14: 全量测试 + 本地联调（Wave C，串行）

- [ ] **Step 1:** `npx vitest run` 全绿。
- [ ] **Step 2:** 本地：`rm -rf .wrangler && npm run db:init`（schema.sql），`npm run dev`，用 curl 走通：owner 登录→生成码→注册→登录→/api/me→POST my/items→GET config?slug→公开页可见。
- [ ] **Step 3:** README 更新入口说明（`/login` `/register` `/app` `/owner` `/b/<slug>`）。
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: multi-user entry points and local verification"`

---

## Self-Review

**Spec coverage：** users/items/settings/activation_codes 模型 → Task 1；密码哈希 → Task 2/5；激活码生成+一次性 → Task 3/6；用户名/slug 校验 → Task 4；会话 role/uid → Task 5；公开 `/api/config?slug` + `/b/:slug` → Task 6/12；注册/登录/me/logout → Task 6/8/9；用户数据按 uid 隔离 → Task 6/7；改看板 slug/name → Task 6/10；站长码/用户/重置 → Task 6/11；迁移 → Task 13。全覆盖。

**Placeholder 扫描：** 无 TBD/TODO；Task 10/12 是「基于现有文件的精确改动清单 + 关键代码段」（在既有代码库里改动的标准做法），契约在「契约」节锁定。

**类型一致性：** `signToken(secret, claims, ttl)` / `verifyToken→claims|null`（Task 5）与 index.js 调用一致；cookie 名 `pendulum_user`/`pendulum_owner` 一致；item camelCase 与 rowToItem 一致；settings keys 一致；`/api/my/*` 与前端调用一致；`rowToUser` 字段（boardSlug/boardName/createdAt）与 owner.html 使用一致。

**并行安全：** Wave A/B 任务文件互不重叠；index.js 仅 Task 6 改；测试文件各自独立（password/codes/users/auth/routes）。Wave C 依赖 Wave A 完成。
