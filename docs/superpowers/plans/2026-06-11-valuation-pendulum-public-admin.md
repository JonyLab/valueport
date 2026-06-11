# 估值钟摆看板 · 公开/后台分离版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有自包含的估值钟摆 HTML 看板改造成 Cloudflare Worker 应用：`/` 为完全公开的只读看板，`/admin` 为单一密码保护的配置后台，配置持久化到 D1，行情由 Worker 代理腾讯接口。

**Architecture:** 单个 Hono Worker 同时托管静态前端（`public/`，纯 ESM vanilla JS，无打包器）、提供配置 CRUD + 鉴权 API、并服务端代理腾讯行情与代码联想。前端把钟摆的纯逻辑（区间/角度/判定）抽到可单测的 `core.js`，DOM 绘制留在 `gauge.js`。鉴权用 Web Crypto HMAC 签名的 cookie，密码与签名密钥存为 Worker secret。

**Tech Stack:** Cloudflare Workers + D1 (SQLite)、Hono、Web Crypto API、Vitest（`@cloudflare/vitest-pool-workers` 跑 Worker 集成测试 + node 环境跑纯逻辑单测）、Wrangler。

---

## File Structure

```
package.json                     # deps + scripts
wrangler.toml                    # Worker 配置：D1 绑定、assets 绑定、secret 声明
schema.sql                       # D1 建表
vitest.config.js                 # 两个 project：worker(pool-workers) + core(node)
src/
  index.js                       # Hono app：路由装配、静态资源、CORS 不需要
  auth.js                        # signToken / verifyToken（HMAC，纯函数 + Web Crypto）
  items.js                       # validateItem、rowToItem（DB 行 <-> API 对象）
  quotes.js                      # parseTencentQuotes、parseTencentHints（GBK 文本 -> JSON）
test/
  auth.test.js                   # 签名/验签 单测（pool-workers）
  items.test.js                  # 校验 + CRUD 集成测试（pool-workers + D1）
  quotes.test.js                 # 腾讯文本解析 单测（pool-workers）
  routes.test.js                 # 端到端路由 + 鉴权 集成测试（pool-workers）
public/
  index.html                     # 公开只读页
  admin.html                     # 后台配置页（登录门 + 配置 UI）
  shared/
    core.js                      # 纯逻辑：ZONES/SEG、computeAnchors、priceToPhi、verdictOf、structValid
    gauge.js                     # Gauge DOM 类（import core.js）
    styles.css                   # 共用样式（从原文件抽出）
test-core/
  core.test.js                   # core.js 纯逻辑单测（node 环境）
```

每个文件单一职责：`core.js` 不碰 DOM 故可在 node 下单测；`gauge.js` 只管 SVG 绘制与动画；Worker 三个辅助模块（auth/items/quotes）各自纯函数化以便单测，`index.js` 仅做装配。

---

## Task 1: 项目脚手架与依赖

**Files:**
- Create: `package.json`
- Create: `wrangler.toml`
- Create: `schema.sql`
- Create: `vitest.config.js`
- Create: `.gitignore`

- [ ] **Step 1: 初始化 git 与 package.json**

Run:
```bash
cd /Users/jony/Documents/Project/watchlist
git init
```

Create `package.json`:
```json
{
  "name": "valuation-pendulum",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "db:init": "wrangler d1 execute pendulum-db --local --file=./schema.sql"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "vitest": "~2.1.0",
    "wrangler": "^3.80.0"
  },
  "dependencies": {
    "hono": "^4.6.0"
  }
}
```

- [ ] **Step 2: 写 wrangler.toml**

Create `wrangler.toml`:
```toml
name = "valuation-pendulum"
main = "src/index.js"
compatibility_date = "2024-11-01"

assets = { directory = "./public", binding = "ASSETS" }

[[d1_databases]]
binding = "DB"
database_name = "pendulum-db"
database_id = "PLACEHOLDER_RUN_d1_create_TO_FILL"

# secrets（不写明文，用 `wrangler secret put` 设置）:
#   ADMIN_PASSWORD   后台登录密码
#   SESSION_SECRET   cookie HMAC 签名密钥
```

> 注：`database_id` 在 Task 9 部署时用 `wrangler d1 create pendulum-db` 生成后回填；本地测试用 `--local` 不需要真实 id。

- [ ] **Step 3: 写 schema.sql**

Create `schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
```

- [ ] **Step 4: 写 vitest.config.js（两套环境）**

Create `vitest.config.js`:
```js
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    projects: [
      {
        // 纯逻辑：node 环境，跑 core.js
        test: {
          name: "core",
          environment: "node",
          include: ["test-core/**/*.test.js"],
        },
      },
      {
        // Worker 集成：pool-workers，注入 D1 与 bindings
        test: {
          name: "worker",
          include: ["test/**/*.test.js"],
          poolOptions: {
            workers: {
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: {
                bindings: { ADMIN_PASSWORD: "test-pass", SESSION_SECRET: "test-secret" },
                d1Databases: ["DB"],
              },
            },
          },
        },
      },
    ],
  },
});
```

- [ ] **Step 5: .gitignore**

Create `.gitignore`:
```
node_modules/
.wrangler/
.dev.vars
dist/
```

- [ ] **Step 6: 安装依赖**

Run: `npm install`
Expected: 依赖安装成功，生成 `node_modules/` 与 `package-lock.json`。

- [ ] **Step 7: Commit**

```bash
git add package.json wrangler.toml schema.sql vitest.config.js .gitignore package-lock.json
git commit -m "chore: scaffold cloudflare worker project"
```

---

## Task 2: 钟摆纯逻辑 core.js（TDD）

**Files:**
- Create: `public/shared/core.js`
- Test: `test-core/core.test.js`

- [ ] **Step 1: 写失败测试**

Create `test-core/core.test.js`:
```js
import { describe, it, expect } from "vitest";
import { computeAnchors, priceToPhi, verdictOf, structValid, SEG, N } from "../public/shared/core.js";

describe("computeAnchors", () => {
  it("derives t1..t4 from fair range, mos, ext", () => {
    const a = computeAnchors({ fairLow: 200, fairHigh: 300, mos: 20, ext: 25 });
    // [0, t1, t2, t3, t4, Infinity]
    expect(a[0]).toBe(0);
    expect(a[1]).toBeCloseTo(160);   // 200 * (1 - 0.2)
    expect(a[2]).toBe(200);
    expect(a[3]).toBe(300);
    expect(a[4]).toBeCloseTo(375);   // 300 * (1 + 0.25)
    expect(a[5]).toBe(Infinity);
  });
});

describe("priceToPhi", () => {
  const anchors = computeAnchors({ fairLow: 200, fairHigh: 300, mos: 20, ext: 25 });
  it("returns 0 for non-positive price", () => {
    expect(priceToPhi(anchors, 0)).toBe(0);
  });
  it("maps fair-range midpoint into the fair band", () => {
    const phi = priceToPhi(anchors, 250);
    expect(phi).toBeGreaterThan(SEG * 2);
    expect(phi).toBeLessThan(SEG * 3);
  });
  it("caps extreme overvalue below 180", () => {
    expect(priceToPhi(anchors, 100000)).toBeLessThanOrEqual(179);
  });
});

describe("verdictOf", () => {
  it("flags undervalue with margin-of-safety pct", () => {
    const v = verdictOf({ symbol: "usX", price: 160, fairLow: 200, fairHigh: 300 });
    expect(v.cls).toBe("v-under");
    expect(v.text).toContain("安全边际");
  });
  it("flags overvalue", () => {
    const v = verdictOf({ symbol: "usX", price: 360, fairLow: 200, fairHigh: 300 });
    expect(v.cls).toBe("v-over");
  });
  it("reports waiting state when no symbol", () => {
    expect(verdictOf({ symbol: null, price: 0 }).text).toBe("未选择标的");
  });
});

describe("structValid", () => {
  it("accepts a valid config", () => {
    expect(structValid({ fairLow: 200, fairHigh: 300, mos: 20, ext: 25 })).toBe(true);
  });
  it("rejects fairHigh <= fairLow", () => {
    expect(structValid({ fairLow: 300, fairHigh: 200, mos: 20, ext: 25 })).toBe(false);
  });
  it("rejects mos out of range", () => {
    expect(structValid({ fairLow: 200, fairHigh: 300, mos: 0, ext: 25 })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --project core`
Expected: FAIL，报 `core.js` 不存在 / 导出未定义。

- [ ] **Step 3: 实现 core.js**

Create `public/shared/core.js`:
```js
// 纯逻辑：无 DOM 依赖，可在 node 下单测。
export const ZONES = [
  { key: "deep",  en: "Deep value",  hex: "#2ea35d" },
  { key: "under", en: "Undervalued", hex: "#3a73ee" },
  { key: "fair",  en: "Fair value",  hex: "#555e6b" },
  { key: "over",  en: "Overvalued",  hex: "#e23c3c" },
  { key: "xover", en: "Extreme",     hex: "#a31515" },
];
export const N = ZONES.length;
export const SEG = 180 / N;
export const PHI_MAX = 179;

// cfg: { fairLow, fairHigh, mos, ext } -> [0, t1, t2, t3, t4, Infinity]
export function computeAnchors(cfg) {
  const t2 = cfg.fairLow, t3 = cfg.fairHigh;
  const t1 = t2 * (1 - cfg.mos / 100);
  const t4 = t3 * (1 + cfg.ext / 100);
  return [0, t1, t2, t3, t4, Infinity];
}

export function priceToPhi(anchors, p) {
  const [, t1, t2, t3, t4] = anchors;
  if (!(p > 0)) return 0;
  if (p <= t1) return SEG * (p / t1);
  if (p <= t2) return SEG + SEG * (p - t1) / (t2 - t1);
  if (p <= t3) return SEG * 2 + SEG * (p - t2) / (t3 - t2);
  if (p <= t4) return SEG * 3 + SEG * (p - t3) / (t4 - t3);
  return Math.min(PHI_MAX, SEG * 4 + SEG * (1 - t4 / p));
}

export function structValid(c) {
  return c.fairLow > 0 && c.fairHigh > c.fairLow && c.mos > 0 && c.mos < 100 && c.ext > 0;
}

export function verdictOf(cfg) {
  if (!cfg.symbol) return { cls: "v-fair", text: "未选择标的", px: "现价 —" };
  if (!(cfg.price > 0)) return { cls: "v-fair", text: "等待报价…", px: "现价 —" };
  if (!(cfg.fairLow > 0) || !(cfg.fairHigh > cfg.fairLow))
    return { cls: "v-fair", text: "—", px: `现价 ${cfg.price}` };
  if (cfg.price < cfg.fairLow) {
    const pct = (cfg.fairLow - cfg.price) / cfg.fairLow * 100;
    return { cls: "v-under", text: `安全边际 ${pct.toFixed(0)}%`, px: `现价 ${cfg.price}` };
  }
  if (cfg.price > cfg.fairHigh) {
    const pct = (cfg.price - cfg.fairHigh) / cfg.fairHigh * 100;
    return { cls: "v-over", text: `高估 ${pct.toFixed(0)}%`, px: `现价 ${cfg.price}` };
  }
  return { cls: "v-fair", text: "合理区间内", px: `现价 ${cfg.price}` };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run --project core`
Expected: PASS（全部用例绿）。

- [ ] **Step 5: Commit**

```bash
git add public/shared/core.js test-core/core.test.js
git commit -m "feat: extract pure pendulum logic with unit tests"
```

---

## Task 3: 鉴权模块 auth.js（TDD）

**Files:**
- Create: `src/auth.js`
- Test: `test/auth.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/auth.test.js`:
```js
import { describe, it, expect } from "vitest";
import { signToken, verifyToken } from "../src/auth.js";

const SECRET = "unit-secret";

describe("auth token", () => {
  it("verifies a freshly signed token", async () => {
    const token = await signToken(SECRET, 3600);
    expect(await verifyToken(SECRET, token)).toBe(true);
  });
  it("rejects a tampered token", async () => {
    const token = await signToken(SECRET, 3600);
    expect(await verifyToken(SECRET, token + "x")).toBe(false);
  });
  it("rejects a token signed with a different secret", async () => {
    const token = await signToken(SECRET, 3600);
    expect(await verifyToken("other-secret", token)).toBe(false);
  });
  it("rejects an expired token", async () => {
    const token = await signToken(SECRET, -1); // 已过期
    expect(await verifyToken(SECRET, token)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --project worker test/auth.test.js`
Expected: FAIL，`signToken` 未定义。

- [ ] **Step 3: 实现 auth.js**

Create `src/auth.js`:
```js
// HMAC-SHA256 签名的无状态会话 token。
// 格式: base64url(JSON payload) + "." + base64url(hmac)
function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToBytes(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

// ttlSeconds 用 0 表示当前时刻（配合负值可造已过期 token 供测试）。
export async function signToken(secret, ttlSeconds) {
  const exp = nowSeconds() + ttlSeconds;
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ exp })));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyToken(secret, token) {
  if (typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig] = token.split(".");
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payload)));
    return typeof exp === "number" && exp > nowSeconds();
  } catch {
    return false;
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run --project worker test/auth.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/auth.js test/auth.test.js
git commit -m "feat: HMAC-signed session token helpers"
```

---

## Task 4: 配置校验与行映射 items.js（TDD）

**Files:**
- Create: `src/items.js`
- Test: `test/items.test.js`（本任务只加纯函数用例，CRUD 集成在 Task 7）

- [ ] **Step 1: 写失败测试**

Create `test/items.test.js`:
```js
import { describe, it, expect } from "vitest";
import { validateItem, rowToItem } from "../src/items.js";

describe("validateItem", () => {
  const good = { ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 };
  it("accepts a valid payload", () => {
    expect(validateItem(good).ok).toBe(true);
  });
  it("rejects missing symbol", () => {
    expect(validateItem({ ...good, symbol: "" }).ok).toBe(false);
  });
  it("rejects fairHigh <= fairLow", () => {
    expect(validateItem({ ...good, fairHigh: 100 }).ok).toBe(false);
  });
  it("rejects mos >= 100", () => {
    expect(validateItem({ ...good, mos: 100 }).ok).toBe(false);
  });
});

describe("rowToItem", () => {
  it("maps a DB row to a camelCase API object", () => {
    const row = { id: 1, ticker: "AAPL", name: "苹果", symbol: "usAAPL",
      fair_low: 215, fair_high: 265, mos: 20, ext: 25, sort_order: 3, updated_at: "2026-06-11T00:00:00Z" };
    expect(rowToItem(row)).toEqual({
      id: 1, ticker: "AAPL", name: "苹果", symbol: "usAAPL",
      fairLow: 215, fairHigh: 265, mos: 20, ext: 25, sortOrder: 3,
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --project worker test/items.test.js`
Expected: FAIL，`validateItem` 未定义。

- [ ] **Step 3: 实现 items.js**

Create `src/items.js`:
```js
// 校验后台提交的配置；ok=false 时 errors 描述原因。
export function validateItem(b) {
  const errors = [];
  const fairLow = Number(b.fairLow), fairHigh = Number(b.fairHigh);
  const mos = Number(b.mos), ext = Number(b.ext);
  if (!b.symbol || typeof b.symbol !== "string") errors.push("symbol required");
  if (!b.ticker || typeof b.ticker !== "string") errors.push("ticker required");
  if (!(fairLow > 0)) errors.push("fairLow must be > 0");
  if (!(fairHigh > fairLow)) errors.push("fairHigh must be > fairLow");
  if (!(mos > 0 && mos < 100)) errors.push("mos must be in (0,100)");
  if (!(ext > 0)) errors.push("ext must be > 0");
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { ticker: b.ticker, name: b.name || "", symbol: b.symbol,
        fairLow, fairHigh, mos, ext, sortOrder: Number(b.sortOrder) || 0 } };
}

export function rowToItem(r) {
  return {
    id: r.id, ticker: r.ticker, name: r.name, symbol: r.symbol,
    fairLow: r.fair_low, fairHigh: r.fair_high, mos: r.mos, ext: r.ext, sortOrder: r.sort_order,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run --project worker test/items.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/items.js test/items.test.js
git commit -m "feat: item validation and row mapping"
```

---

## Task 5: 腾讯行情/联想解析 quotes.js（TDD）

**Files:**
- Create: `src/quotes.js`
- Test: `test/quotes.test.js`

- [ ] **Step 1: 写失败测试**

Create `test/quotes.test.js`:
```js
import { describe, it, expect } from "vitest";
import { parseTencentQuotes, parseTencentHints } from "../src/quotes.js";

describe("parseTencentQuotes", () => {
  it("extracts price (field index 3) per symbol", () => {
    // 腾讯格式: v_usAAPL="1~苹果~AAPL~232.10~...";
    const text =
      'v_usAAPL="1~苹果~AAPL~232.10~230~231~..."; \n' +
      'v_usNVDA="1~英伟达~NVDA~118.40~117~118~...";';
    expect(parseTencentQuotes(text, ["usAAPL", "usNVDA"])).toEqual({
      usAAPL: 232.1, usNVDA: 118.4,
    });
  });
  it("omits symbols with no/zero price", () => {
    const text = 'v_usAAPL="1~苹果~AAPL~0~...";';
    expect(parseTencentQuotes(text, ["usAAPL"])).toEqual({});
  });
});

describe("parseTencentHints", () => {
  it("parses smartbox hint string into structured suggestions", () => {
    const text = 'v_hint="us~AAPL.OQ~Apple Inc~~^sh~600519~贵州茅台~~";';
    const out = parseTencentHints(text);
    expect(out[0]).toMatchObject({ mkt: "us", code: "AAPL", name: "Apple Inc", symbol: "usAAPL" });
    expect(out[1]).toMatchObject({ mkt: "sh", code: "600519", symbol: "sh600519" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run --project worker test/quotes.test.js`
Expected: FAIL，函数未定义。

- [ ] **Step 3: 实现 quotes.js**

Create `src/quotes.js`:
```js
export const MKT_LABEL = { sh: "沪A", sz: "深A", hk: "港股", us: "美股", bj: "北交所" };

// 腾讯行情返回多行: v_<sym>="f0~f1~f2~price~...";  价格在索引 3。
export function parseTencentQuotes(text, symbols) {
  const out = {};
  for (const sym of symbols) {
    const m = text.match(new RegExp(`v_${sym}="([^"]*)"`));
    if (!m) continue;
    const f = m[1].split("~");
    const p = parseFloat(f[3]);
    if (p > 0) out[sym] = p;
  }
  return out;
}

// 腾讯 smartbox: v_hint="mkt~code~name~~^mkt~code~name~~^...";
export function parseTencentHints(text) {
  const m = text.match(/v_hint="([^"]*)"/);
  if (!m) return [];
  const out = [];
  for (const e of m[1].split("^")) {
    const f = e.split("~");
    if (f.length < 3) continue;
    const mkt = (f[0] || "").toLowerCase();
    if (!MKT_LABEL[mkt]) continue;
    let code = (f[1] || "").toUpperCase();
    const name = f[2] || "";
    if (mkt === "us") code = code.split(".")[0];
    const symbol = mkt + (mkt === "us" ? code : (f[1] || "").toLowerCase());
    out.push({ mkt, code, name, symbol });
  }
  return out.slice(0, 8);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run --project worker test/quotes.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/quotes.js test/quotes.test.js
git commit -m "feat: parse tencent quote and hint payloads"
```

---

## Task 6: Worker 主程序 index.js（路由装配）

**Files:**
- Create: `src/index.js`

> 本任务只搭骨架与上游 fetch 封装，CRUD 与鉴权的端到端测试在 Task 7。

- [ ] **Step 1: 实现 index.js**

Create `src/index.js`:
```js
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { signToken, verifyToken } from "./auth.js";
import { validateItem, rowToItem } from "./items.js";
import { parseTencentQuotes, parseTencentHints } from "./quotes.js";

const app = new Hono();
const SESSION_COOKIE = "pendulum_session";
const SESSION_TTL = 7 * 24 * 3600;

// 服务端抓腾讯并按 GBK 解码为文本
async function fetchGbk(url) {
  const res = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder("gbk").decode(buf);
}

/* ---------- 公开接口 ---------- */
app.get("/api/config", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM items ORDER BY sort_order ASC, id ASC"
  ).all();
  return c.json({ items: (results || []).map(rowToItem) });
});

app.get("/api/quotes", async (c) => {
  const symbols = (c.req.query("symbols") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!symbols.length) return c.json({ quotes: {}, ts: new Date().toISOString() });
  try {
    const text = await fetchGbk("https://qt.gtimg.cn/q=" + symbols.join(","));
    return c.json({ quotes: parseTencentQuotes(text, symbols), ts: new Date().toISOString() });
  } catch {
    return c.json({ quotes: {}, error: "upstream unreachable", ts: new Date().toISOString() }, 502);
  }
});

app.get("/api/hints", async (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.json({ hints: [] });
  try {
    const text = await fetchGbk(
      "https://smartbox.gtimg.cn/s3/?v=2&t=all&q=" + encodeURIComponent(q)
    );
    return c.json({ hints: parseTencentHints(text) });
  } catch {
    return c.json({ hints: [] });
  }
});

/* ---------- 登录 ---------- */
app.post("/api/login", async (c) => {
  const { password } = await c.req.json().catch(() => ({}));
  if (!password || password !== c.env.ADMIN_PASSWORD) {
    return c.json({ ok: false, error: "invalid password" }, 401);
  }
  const token = await signToken(c.env.SESSION_SECRET, SESSION_TTL);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL,
  });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  setCookie(c, SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

/* ---------- 后台鉴权中间件 ---------- */
app.use("/api/admin/*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !(await verifyToken(c.env.SESSION_SECRET, token))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});

/* ---------- 后台 CRUD ---------- */
app.get("/api/admin/items", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM items ORDER BY sort_order ASC, id ASC"
  ).all();
  return c.json({ items: (results || []).map(rowToItem) });
});

app.post("/api/admin/items", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const v = validateItem(body);
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const it = v.value;
  const { meta } = await c.env.DB.prepare(
    `INSERT INTO items (ticker,name,symbol,fair_low,fair_high,mos,ext,sort_order,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder,
    new Date().toISOString()).run();
  return c.json({ ok: true, id: meta.last_row_id });
});

app.put("/api/admin/items/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const v = validateItem(body);
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const it = v.value;
  const { meta } = await c.env.DB.prepare(
    `UPDATE items SET ticker=?,name=?,symbol=?,fair_low=?,fair_high=?,mos=?,ext=?,sort_order=?,updated_at=?
     WHERE id=?`
  ).bind(it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder,
    new Date().toISOString(), id).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/admin/items/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { meta } = await c.env.DB.prepare("DELETE FROM items WHERE id=?").bind(id).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true });
});

// 其余交给静态资源（public/）
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
```

- [ ] **Step 2: 静态健全性检查**

Run: `node --check src/index.js`
Expected: 无语法错误（无输出）。

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: wire hono routes for config, quotes, auth, crud"
```

---

## Task 7: 路由与鉴权端到端测试（TDD，针对 Task 6）

**Files:**
- Create: `test/routes.test.js`

> pool-workers 会在每个测试 worker 内提供本地 D1（绑定 `DB`）。先建表，再覆盖公开/鉴权/CRUD 全链路。

- [ ] **Step 1: 写测试**

Create `test/routes.test.js`:
```js
import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";

beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS items (
       id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
       symbol TEXT NOT NULL, fair_low REAL NOT NULL, fair_high REAL NOT NULL,
       mos REAL NOT NULL, ext REAL NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`
  ).run();
});

const item = { ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 };

async function login() {
  const res = await SELF.fetch("https://x/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-pass" }),
  });
  return res.headers.get("set-cookie");
}

describe("auth gating", () => {
  it("blocks admin CRUD without a session", async () => {
    const res = await SELF.fetch("https://x/api/admin/items");
    expect(res.status).toBe(401);
  });
  it("rejects wrong password", async () => {
    const res = await SELF.fetch("https://x/api/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("crud + public read", () => {
  it("creates an item and exposes it on /api/config", async () => {
    const cookie = await login();
    const create = await SELF.fetch("https://x/api/admin/items", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(item),
    });
    expect(create.status).toBe(200);

    const pub = await SELF.fetch("https://x/api/config");
    const body = await pub.json();
    expect(body.items.some((i) => i.symbol === "usAAPL")).toBe(true);
  });

  it("rejects invalid payloads with 400", async () => {
    const cookie = await login();
    const res = await SELF.fetch("https://x/api/admin/items", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...item, fairHigh: 1 }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run --project worker test/routes.test.js`
Expected: PASS（401 拦截、登录后 CRUD、公开读取、400 校验均通过）。

> 若 `cloudflare:test` 的 `SELF` 报未找到 worker，确认 `vitest.config.js` 中 worker project 的 `wrangler.configPath` 正确指向 `./wrangler.toml`。

- [ ] **Step 3: Commit**

```bash
git add test/routes.test.js
git commit -m "test: end-to-end routes, auth gating, crud"
```

---

## Task 8: 共用样式与 Gauge DOM 类

**Files:**
- Create: `public/shared/styles.css`
- Create: `public/shared/gauge.js`

- [ ] **Step 1: 抽出共用样式**

Create `public/shared/styles.css`：把原 `pendulum-board.html` `<style>` 内**全部 CSS** 原样拷入（`:root` 变量、`body`、`.page`、`.charts`/`.chart-item`/`.verdict`、`.config` 及其子项、`.combo*`、媒体查询等），不改样式值。后续公开页只用其中图表相关类，后台页用全部。

- [ ] **Step 2: 实现 gauge.js（DOM 绘制类）**

Create `public/shared/gauge.js`：从原文件搬入 `Gauge` 类，改为 ESM 并 import core。完整内容：
```js
import { ZONES, N, SEG, PHI_MAX, computeAnchors, priceToPhi } from "./core.js";

const NS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
const REDUCE = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
let UID = 0;

export class Gauge {
  constructor(mount) {
    this.uid = ++UID;
    this.cx = 300; this.cy = 112;
    this.rO = 190; this.rI = 134;
    this.rM = (this.rO + this.rI) / 2;
    this.rB = this.rI + 12; this.rL = this.rM + 9; this.rN = this.rI - 14;
    this.RHUB = 58;
    this.anchors = [0, 1, 2, 3, 4, Infinity];
    this.current = 0; this.target = 0; this.raf = null; this.swinging = false;
    this.build(mount);
  }
  pt(r, phi) { return [this.cx - r * Math.cos(phi * D2R), this.cy + r * Math.sin(phi * D2R)]; }
  annular(a0, a1) {
    const [ox0, oy0] = this.pt(this.rO, a0), [ox1, oy1] = this.pt(this.rO, a1);
    const [ix1, iy1] = this.pt(this.rI, a1), [ix0, iy0] = this.pt(this.rI, a0);
    return `M ${ox0} ${oy0} A ${this.rO} ${this.rO} 0 0 0 ${ox1} ${oy1} `
         + `L ${ix1} ${iy1} A ${this.rI} ${this.rI} 0 0 1 ${ix0} ${iy0} Z`;
  }
  mk(tag, attrs = {}) { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; }
  build(mount) {
    const svg = this.mk("svg", { viewBox: "0 0 600 322", role: "img", "aria-label": "估值钟摆" });
    const { cx, cy, rO, rI, rN, rL, rB } = this;
    const gT = this.mk("g");
    for (let a = 2; a < 180; a += 3) {
      const [x0, y0] = this.pt(rI + 3, a), [x1, y1] = this.pt(rO - 3, a);
      gT.appendChild(this.mk("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: "var(--track-edge)", "stroke-width": 1, opacity: 0.38 }));
    }
    this.bands = [];
    const gB = this.mk("g");
    ZONES.forEach((z, i) => {
      const b = this.mk("path", { d: this.annular(i * SEG, (i + 1) * SEG), fill: "var(--track)", class: "gband" });
      b.style.transition = "fill .4s ease";
      gB.appendChild(b); this.bands.push(b);
    });
    const gD = this.mk("g");
    for (let i = 1; i < N; i++) {
      const [x0, y0] = this.pt(rI, i * SEG), [x1, y1] = this.pt(rO, i * SEG);
      gD.appendChild(this.mk("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: "var(--divider)", "stroke-width": 1.4 }));
    }
    const base = this.mk("line", { x1: cx - rO, y1: cy, x2: cx + rO, y2: cy, stroke: "var(--divider)", "stroke-width": 1.5, "stroke-linecap": "round" });
    const defs = this.mk("defs"); const gL = this.mk("g"); this.labels = [];
    ZONES.forEach((z, i) => {
      const a0 = i * SEG + 3, a1 = (i + 1) * SEG - 3;
      const [sx, sy] = this.pt(rL, a0), [ex, ey] = this.pt(rL, a1);
      const id = `g${this.uid}lp${i}`;
      defs.appendChild(this.mk("path", { id, d: `M ${sx} ${sy} A ${rL} ${rL} 0 0 0 ${ex} ${ey}` }));
      const t = this.mk("text", { class: "glabel" });
      t.style.cssText = "font-size:11px;font-weight:600;letter-spacing:.02em;fill:var(--ink-mute);transition:fill .35s";
      const tp = this.mk("textPath", { href: "#" + id, startOffset: "50%", "text-anchor": "middle" });
      tp.textContent = z.en; t.appendChild(tp);
      gL.appendChild(t); this.labels.push(t);
    });
    this.nums = [];
    const gN = this.mk("g");
    for (let i = 1; i < N; i++) {
      const [x, y] = this.pt(rN, i * SEG);
      const t = this.mk("text", { x, y: y + 4, "text-anchor": "middle" });
      t.style.cssText = "font-family:var(--mono);font-size:12px;font-weight:600;fill:var(--ink-soft)";
      gN.appendChild(t); this.nums.push(t);
    }
    this.gNeedle = this.mk("g");
    const [bx, by] = this.pt(rB, 90);
    const needle = this.mk("line", { x1: cx, y1: cy, x2: bx, y2: by, stroke: "var(--hub)", "stroke-width": 2.4, "stroke-linecap": "round" });
    this.ring = this.mk("circle", { cx: bx, cy: by, r: 9, fill: "#fff", "stroke-width": 4, class: "gring" });
    this.ring.style.transition = "stroke .4s ease";
    this.dot = this.mk("circle", { cx: bx, cy: by, r: 3, class: "gdot" });
    this.dot.style.transition = "fill .4s ease";
    this.gNeedle.append(needle, this.ring, this.dot);
    const hubPath = `M ${cx - this.RHUB} ${cy} A ${this.RHUB} ${this.RHUB} 0 0 0 ${cx + this.RHUB} ${cy} Z`;
    const hubShadow = this.mk("path", { d: hubPath, fill: "rgba(20,30,50,.08)", transform: "translate(0,2)" });
    const hubRing = this.mk("path", { d: hubPath, fill: "#fff", stroke: "#dfe3ea", "stroke-width": 1.5 });
    this.hubText = this.mk("text", { x: cx, y: cy + this.RHUB * 0.42, "text-anchor": "middle", "dominant-baseline": "middle" });
    this.hubText.style.cssText = "font-family:var(--mono);font-size:20px;font-weight:700;letter-spacing:.02em;fill:var(--ink)";
    svg.append(gT, gB, gD, base, defs, gL, gN, this.gNeedle, hubShadow, hubRing, this.hubText);
    mount.appendChild(svg);
    this.svg = svg;
  }
  paint(phi) {
    const zi = this.hasPrice ? Math.min(N - 1, Math.floor(Math.max(0, Math.min(180, phi)) / SEG)) : -1;
    const z = zi >= 0 ? ZONES[zi] : null;
    this.gNeedle.setAttribute("transform", `rotate(${90 - phi} ${this.cx} ${this.cy})`);
    this.bands.forEach((b, i) => b.setAttribute("fill", i === zi ? z.hex : "var(--track)"));
    this.labels.forEach((t, i) => t.style.fill = i === zi ? "#fff" : "var(--ink-mute)");
    this.ring.setAttribute("stroke", z ? z.hex : "#c4cad4");
    this.dot.setAttribute("fill", z ? z.hex : "#c4cad4");
  }
  set(cfg, animate = true) {
    this.anchors = computeAnchors(cfg);
    this.nums.forEach((t, k) => t.textContent = Math.round(this.anchors[k + 1]));
    this.hubText.textContent = (cfg.ticker || "—").toUpperCase();
    this.hubText.style.fontSize = (cfg.ticker || "").length > 6 ? "15px" : "20px";
    this.hasPrice = cfg.price > 0;
    this.target = this.hasPrice ? priceToPhi(this.anchors, cfg.price) : 90;
    if (!animate || REDUCE) { this.current = this.target; this.paint(this.current); return; }
    if (!this.raf && !this.swinging) this.follow();
  }
  follow() {
    const step = () => {
      this.current += (this.target - this.current) * 0.16;
      this.paint(this.current);
      if (Math.abs(this.target - this.current) > 0.05) { this.raf = requestAnimationFrame(step); }
      else { this.current = this.target; this.paint(this.current); this.raf = null; }
    };
    this.raf = requestAnimationFrame(step);
  }
  swingIn() {
    if (REDUCE) { this.current = this.target; this.paint(this.current); return; }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.swinging = true;
    const to = this.target, start = to >= 90 ? 8 : 172;
    const lambda = 0.9, omega = 3.0, t0 = performance.now();
    const step = (now) => {
      const t = (now - t0) / 1000, env = Math.exp(-lambda * t);
      this.current = Math.max(0, Math.min(180, to + (start - to) * env * Math.cos(omega * t)));
      this.paint(this.current);
      if (env > 0.012) { this.raf = requestAnimationFrame(step); }
      else { this.current = to; this.paint(to); this.raf = null; this.swinging = false; if (this.target !== to) this.follow(); }
    };
    this.raf = requestAnimationFrame(step);
  }
  destroy() { if (this.raf) cancelAnimationFrame(this.raf); this.svg.remove(); }
}
```

- [ ] **Step 3: 健全性检查**

Run: `node --check public/shared/gauge.js`
Expected: 无语法错误。

- [ ] **Step 4: Commit**

```bash
git add public/shared/styles.css public/shared/gauge.js
git commit -m "feat: shared styles and gauge DOM class as ESM"
```

---

## Task 9: 公开只读页 index.html

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: 实现公开页**

Create `public/index.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>估值钟摆 · 看板</title>
<link rel="stylesheet" href="/shared/styles.css">
<style>
  /* 公开页：单列/自适应多列钟摆流，无配置栏 */
  .layout{display:block}
  .charts{max-width:1080px;margin:0 auto}
  @media (min-width:1100px){
    .charts{display:grid;grid-template-columns:1fr 1fr;gap:8px 40px}
  }
</style>
</head>
<body>
<div class="page">
  <div class="page-head">
    <p class="eyebrow">市场情绪 · Valuation Pendulum</p>
    <h1>估值钟摆看板</h1>
    <p class="sub">每只标的一只钟摆：指针落位由现价与设定的合理价值区间、安全边际共同决定。市场在两端摆动，钟摆终将回归中点。</p>
  </div>
  <div class="layout">
    <div class="charts" id="charts"></div>
  </div>
</div>

<script type="module">
import { Gauge } from "/shared/gauge.js";
import { verdictOf, structValid } from "/shared/core.js";

const REDUCE = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const chartsEl = document.getElementById("charts");
const items = []; // {cfg, gauge, verdictEl, gotQuote}

function renderVerdict(item) {
  const v = verdictOf(item.cfg);
  const el = item.verdictEl;
  el.className = "verdict " + v.cls;
  el.innerHTML = "";
  const px = document.createElement("span");
  px.className = "px" + (item.live ? " px-live" : "");
  px.textContent = v.px;
  el.appendChild(px);
  el.appendChild(document.createTextNode(v.text));
}

function addChart(cfg) {
  const wrap = document.createElement("div");
  wrap.className = "chart-item";
  const gauge = new Gauge(wrap);
  const verdict = document.createElement("p");
  verdict.className = "verdict v-fair";
  wrap.appendChild(verdict);
  chartsEl.appendChild(wrap);
  const item = { cfg, gauge, verdictEl: verdict, live: false, gotQuote: false };
  items.push(item);
  gauge.set(cfg, false);
  renderVerdict(item);
}

async function loadConfig() {
  const res = await fetch("/api/config");
  const { items: rows } = await res.json();
  chartsEl.innerHTML = "";
  items.length = 0;
  if (!rows.length) {
    chartsEl.innerHTML = '<div class="charts-empty">看板暂未配置内容。</div>';
    return;
  }
  rows.forEach((r) => addChart({ ...r, price: 0 }));
  await fetchQuotes();
}

async function fetchQuotes() {
  const symbols = [...new Set(items.map((i) => i.cfg.symbol).filter(Boolean))];
  if (!symbols.length) return;
  let data;
  try {
    const res = await fetch("/api/quotes?symbols=" + encodeURIComponent(symbols.join(",")));
    data = await res.json();
  } catch { return; }
  const quotes = data.quotes || {};
  items.forEach((item) => {
    const p = quotes[item.cfg.symbol];
    if (!(p > 0)) return;
    item.cfg = { ...item.cfg, price: p };
    item.live = true;
    if (structValid(item.cfg)) {
      const first = !item.gotQuote;
      item.gotQuote = true;
      item.gauge.set(item.cfg, !first);
      if (first) item.gauge.swingIn();
      renderVerdict(item);
    }
  });
}

loadConfig();
setInterval(fetchQuotes, 60000);
</script>
</body>
</html>
```

- [ ] **Step 2: 健全性检查**

Run: `node --check <(sed -n '/<script type="module">/,/<\/script>/p' public/index.html | sed '1d;$d')`
Expected: 内联脚本无语法错误（若 shell 不支持进程替换，跳过此步，靠 Task 11 手测）。

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: public read-only pendulum board"
```

---

## Task 10: 后台配置页 admin.html

**Files:**
- Create: `public/admin.html`

> 后台 = 登录门 + 配置 UI。配置 UI 复用原文件右侧面板交互（代码联想下拉、安全边际/极度高估 chips、移除），但读写走 `/api/admin/items`，联想走 `/api/hints`。每条配置在编辑后即时 `保存`（PUT/POST）。

- [ ] **Step 1: 实现后台页**

Create `public/admin.html`:
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>估值钟摆 · 配置后台</title>
<link rel="stylesheet" href="/shared/styles.css">
<style>
  .login-gate{max-width:360px;margin:80px auto;background:var(--card);border-radius:18px;
    box-shadow:var(--shadow);padding:28px 24px}
  .login-gate h2{font-size:18px;margin:0 0 16px}
  .login-gate input{width:100%;font-family:var(--mono);font-size:14px;padding:10px;
    border:1px solid #dfe3ea;border-radius:8px;margin-bottom:12px}
  .login-err{color:var(--red);font-size:12px;margin-bottom:10px;display:none}
  .hidden{display:none}
  .save-state{font-size:11px;color:var(--ink-mute);font-family:var(--mono);margin-left:8px}
  .save-state.ok{color:var(--green)} .save-state.err{color:var(--red)}
</style>
</head>
<body>
<div class="page">
  <!-- 登录门 -->
  <div class="login-gate" id="gate">
    <h2>配置后台登录</h2>
    <div class="login-err" id="loginErr">密码错误</div>
    <input type="password" id="pw" placeholder="管理密码" autocomplete="current-password">
    <button class="btn primary" id="btnLogin" style="width:100%">进入</button>
  </div>

  <!-- 配置主体 -->
  <div id="app" class="hidden">
    <div class="page-head">
      <p class="eyebrow">配置后台 · Admin</p>
      <h1>估值钟摆 · 配置</h1>
      <p class="sub">在此增删改标的与估值参数，保存后公开页 <a href="/" target="_blank">/</a> 即时生效。</p>
    </div>
    <div class="layout">
      <div class="charts" id="charts"></div>
      <div class="config">
        <div class="config-head">
          <span class="config-title">配置</span>
          <button class="btn primary" id="btnAdd">＋ 添加图表</button>
        </div>
        <div class="quote-bar">
          <button class="btn" id="btnRefresh">↻ 立即刷新</button>
          <span class="quote-status" id="quoteStatus"></span>
          <button class="btn" id="btnLogout" style="margin-left:auto">退出</button>
        </div>
        <p class="quote-note">现价由腾讯公开行情接口经服务端代理获取（延时）。代码框支持 <code>代码 / 名称 / 拼音</code> 联想，<b>必须从下拉中选择</b>以锁定精确标的。改动会自动保存。</p>
        <div id="cfgList"></div>
      </div>
    </div>
  </div>
</div>

<script type="module">
import { Gauge } from "/shared/gauge.js";
import { verdictOf, structValid } from "/shared/core.js";
import { MKT_LABEL } from "/shared/market.js";

const REDUCE = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const chartsEl = document.getElementById("charts");
const cfgList = document.getElementById("cfgList");
const items = []; // {id, cfg, gauge, chartEl, cfgEl, verdictEl, live, gotQuote, saveEl}

/* ---------- 登录 ---------- */
const gate = document.getElementById("gate");
const appEl = document.getElementById("app");
async function tryLoad() {
  const res = await fetch("/api/admin/items");
  if (res.status === 401) return false;
  const { items: rows } = await res.json();
  gate.classList.add("hidden");
  appEl.classList.remove("hidden");
  rows.forEach((r) => addItem({ ...r, price: 0 }));
  fetchQuotes();
  return true;
}
document.getElementById("btnLogin").addEventListener("click", login);
document.getElementById("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
async function login() {
  const password = document.getElementById("pw").value;
  const res = await fetch("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) { tryLoad(); }
  else { document.getElementById("loginErr").style.display = ""; }
}
document.getElementById("btnLogout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  location.reload();
});

/* ---------- 保存（防抖） ---------- */
function setSave(item, state, text) {
  if (!item.saveEl) return;
  item.saveEl.className = "save-state " + (state || "");
  item.saveEl.textContent = text || "";
}
async function saveItem(item) {
  if (!item.cfg.symbol || !structValid(item.cfg)) return;
  setSave(item, "", "保存中…");
  const payload = {
    ticker: item.cfg.ticker, name: item.cfg.name, symbol: item.cfg.symbol,
    fairLow: item.cfg.fairLow, fairHigh: item.cfg.fairHigh, mos: item.cfg.mos, ext: item.cfg.ext,
    sortOrder: item.cfg.sortOrder || 0,
  };
  const url = item.id ? `/api/admin/items/${item.id}` : "/api/admin/items";
  const method = item.id ? "PUT" : "POST";
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (res.ok) {
    const body = await res.json();
    if (!item.id && body.id) item.id = body.id;
    setSave(item, "ok", "已保存");
  } else {
    setSave(item, "err", "保存失败");
  }
}
function debounceSave(item) {
  clearTimeout(item._saveT);
  item._saveT = setTimeout(() => saveItem(item), 600);
}

/* ---------- 图表侧 ---------- */
function renderVerdict(item) {
  const v = verdictOf(item.cfg);
  const el = item.verdictEl;
  el.className = "verdict " + v.cls;
  el.innerHTML = "";
  const px = document.createElement("span");
  px.className = "px" + (item.live ? " px-live" : "");
  px.textContent = v.px;
  el.appendChild(px);
  el.appendChild(document.createTextNode(v.text));
}
function addChartDom(item) {
  const wrap = document.createElement("div");
  wrap.className = "chart-item";
  const gauge = new Gauge(wrap);
  const verdict = document.createElement("p");
  verdict.className = "verdict v-fair";
  wrap.appendChild(verdict);
  chartsEl.appendChild(wrap);
  item.gauge = gauge; item.chartEl = wrap; item.verdictEl = verdict;
  gauge.set(item.cfg, false);
  renderVerdict(item);
}

/* ---------- 代码联想（走 /api/hints） ---------- */
let hintSeq = 0;
async function loadHints(q) {
  const seq = ++hintSeq;
  try {
    const res = await fetch("/api/hints?q=" + encodeURIComponent(q));
    const { hints } = await res.json();
    return seq === hintSeq ? hints : null;
  } catch { return []; }
}

/* ---------- 配置侧 ---------- */
const FIELDS = [
  { k: "ticker", lab: "标的代码", type: "text" },
  { k: "fairLow", lab: "合理 · 低点", type: "number" },
  { k: "fairHigh", lab: "合理 · 高点", type: "number" },
  { k: "mos", lab: "安全边际 %", type: "number", presets: [10, 20, 30, 40, 50] },
  { k: "ext", lab: "极度高估 %", type: "number", presets: [10, 20, 30, 40, 50] },
];

function addCfgDom(item) {
  const block = document.createElement("div");
  block.className = "cfg-block";
  const top = document.createElement("div");
  top.className = "cfg-top";
  const name = document.createElement("span");
  name.className = "cfg-name";
  name.textContent = item.cfg.name ? `${(item.cfg.ticker || "—").toUpperCase()} · ${item.cfg.name}` : (item.cfg.ticker || "—").toUpperCase();
  const saveEl = document.createElement("span");
  saveEl.className = "save-state";
  item.saveEl = saveEl;
  const del = document.createElement("button");
  del.className = "btn-del"; del.textContent = "移除";
  del.addEventListener("click", () => removeItem(item));
  const topRight = document.createElement("span");
  topRight.append(saveEl, del);
  top.append(name, topRight);

  const grid = document.createElement("div");
  grid.className = "cfg-grid";
  FIELDS.forEach((f) => {
    const lab = document.createElement("label");
    lab.className = "field" + (f.k === "ticker" ? " full" : "");
    const span = document.createElement("span");
    span.className = "f-lab"; span.textContent = f.lab;
    const input = document.createElement("input");
    input.type = f.type;
    if (f.type === "number") { input.min = "0"; input.step = "any"; }
    else { input.maxLength = 24; input.spellcheck = false; input.placeholder = "代码 / 名称 / 拼音"; input.autocomplete = "off"; }
    input.value = item.cfg[f.k] ?? "";

    input.addEventListener("input", () => {
      const v = f.type === "number" ? parseFloat(input.value) : input.value.trim();
      const next = { ...item.cfg, [f.k]: v };
      let bad = false;
      if (f.k === "fairLow") bad = !(v > 0);
      if (f.k === "fairHigh") bad = !(v > next.fairLow);
      if (f.k === "mos") bad = !(v > 0 && v < 100);
      if (f.k === "ext") bad = !(v > 0);
      input.classList.toggle("bad", bad && input.value !== "");
      item.cfg = next;
      if (f.k === "ticker") {
        name.textContent = (v || "—").toUpperCase();
        item.live = false; item.gotQuote = false;
        item.cfg = { ...item.cfg, price: 0, symbol: null, name: "" };
        input.classList.remove("ok", "bad");
        renderVerdict(item);
        item.gauge.set(item.cfg);
      }
      if (structValid(item.cfg)) {
        item.gauge.set(item.cfg);
        renderVerdict(item);
        debounceSave(item);
      }
    });

    if (f.k === "ticker") {
      const combo = document.createElement("div");
      combo.className = "combo";
      const list = document.createElement("div");
      list.className = "combo-list"; list.style.display = "none";
      const err = document.createElement("div");
      err.className = "f-err"; err.textContent = "请从下拉中选择标的";
      let opts = [], act = -1, searchTimer = null;
      const close = () => { list.style.display = "none"; act = -1; };
      const markState = () => {
        const txt = input.value.trim();
        if (item.cfg.symbol) { input.classList.add("ok"); input.classList.remove("bad"); err.style.display = "none"; }
        else if (txt) { input.classList.add("bad"); input.classList.remove("ok"); err.style.display = ""; }
        else { input.classList.remove("ok", "bad"); err.style.display = "none"; }
      };
      const pick = (o) => {
        input.value = o.code;
        item.cfg = { ...item.cfg, ticker: o.code, name: o.name, symbol: o.symbol, price: 0 };
        item.live = false; item.gotQuote = false;
        name.textContent = `${o.code} · ${o.name}`;
        if (structValid(item.cfg)) { item.gauge.set(item.cfg); renderVerdict(item); saveItem(item); }
        close(); markState(); fetchQuotes();
      };
      const renderList = (arr) => {
        opts = arr; act = -1; list.innerHTML = "";
        if (!arr.length) { close(); return; }
        arr.forEach((o) => {
          const d = document.createElement("div");
          d.className = "combo-opt";
          d.innerHTML = `<span class="c-code"></span><span class="c-name"></span><span class="c-mkt"></span>`;
          d.children[0].textContent = o.code;
          d.children[1].textContent = o.name;
          d.children[2].textContent = MKT_LABEL[o.mkt];
          d.addEventListener("mousedown", (e) => { e.preventDefault(); pick(o); });
          list.appendChild(d);
        });
        list.style.display = "";
      };
      const highlight = () => {
        [...list.children].forEach((d, i) => d.classList.toggle("act", i === act));
        if (act >= 0) list.children[act].scrollIntoView({ block: "nearest" });
      };
      input.addEventListener("input", () => {
        const q = input.value.trim();
        clearTimeout(searchTimer);
        if (q.length < 1) { close(); return; }
        searchTimer = setTimeout(async () => {
          const arr = await loadHints(q);
          if (arr !== null) renderList(arr);
        }, 250);
      });
      input.addEventListener("keydown", (e) => {
        if (list.style.display === "none") return;
        if (e.key === "ArrowDown") { e.preventDefault(); act = Math.min(opts.length - 1, act + 1); highlight(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); act = Math.max(0, act - 1); highlight(); }
        else if (e.key === "Enter") { e.preventDefault(); if (act >= 0) pick(opts[act]); else if (opts.length) pick(opts[0]); }
        else if (e.key === "Escape") { close(); }
      });
      input.addEventListener("blur", () => { setTimeout(() => { close(); markState(); }, 150); });
      combo.append(input, list);
      lab.append(span, combo, err);
      grid.appendChild(lab);
      if (item.cfg.symbol) input.classList.add("ok");
      return;
    }

    lab.append(span, input);
    if (f.presets) {
      const chips = document.createElement("div");
      chips.className = "chips";
      const chipEls = f.presets.map((p) => {
        const c = document.createElement("button");
        c.type = "button"; c.className = "chip"; c.textContent = p + "%";
        c.addEventListener("click", () => { input.value = p; input.dispatchEvent(new Event("input", { bubbles: true })); });
        chips.appendChild(c);
        return { el: c, val: p };
      });
      const syncChips = () => { const v = parseFloat(input.value); chipEls.forEach(({ el, val }) => el.classList.toggle("on", v === val)); };
      input.addEventListener("input", syncChips);
      syncChips();
      lab.appendChild(chips);
    }
    grid.appendChild(lab);
  });

  block.addEventListener("click", (e) => {
    if (e.target.closest("input,button")) return;
    item.chartEl.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "center" });
  });
  block.append(top, grid);
  cfgList.appendChild(block);
  item.cfgEl = block;
}

/* ---------- 增/删 ---------- */
function addItem(cfg) {
  const item = { id: cfg.id || null, cfg: { ...cfg }, live: false, gotQuote: false };
  items.push(item);
  addChartDom(item);
  addCfgDom(item);
  return item;
}
async function removeItem(item) {
  if (item.id) await fetch(`/api/admin/items/${item.id}`, { method: "DELETE" });
  const idx = items.indexOf(item);
  if (idx >= 0) { item.gauge.destroy(); item.chartEl.remove(); item.cfgEl.remove(); items.splice(idx, 1); }
}
document.getElementById("btnAdd").addEventListener("click", () => {
  const it = addItem({ ticker: "", name: "", symbol: null, price: 0, fairLow: 215, fairHigh: 265, mos: 20, ext: 25, sortOrder: items.length });
  it.cfgEl.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "nearest" });
  const first = it.cfgEl.querySelector("input");
  first && first.focus();
});

/* ---------- 行情 ---------- */
const statusEl = document.getElementById("quoteStatus");
async function fetchQuotes() {
  const map = items.filter((i) => i.cfg.symbol);
  if (!map.length) { statusEl.textContent = "请先从下拉选择标的"; return; }
  statusEl.classList.remove("err"); statusEl.textContent = "获取中…";
  const symbols = [...new Set(map.map((i) => i.cfg.symbol))];
  let data;
  try {
    const res = await fetch("/api/quotes?symbols=" + encodeURIComponent(symbols.join(",")));
    data = await res.json();
  } catch { statusEl.textContent = "接口不可达"; statusEl.classList.add("err"); return; }
  const quotes = data.quotes || {};
  let ok = 0;
  map.forEach((item) => {
    const p = quotes[item.cfg.symbol];
    if (!(p > 0)) return;
    ok++;
    item.cfg = { ...item.cfg, price: p }; item.live = true;
    if (structValid(item.cfg)) {
      const first = !item.gotQuote; item.gotQuote = true;
      item.gauge.set(item.cfg, !first);
      if (first) item.gauge.swingIn();
      renderVerdict(item);
    }
  });
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, "0"), mm = String(t.getMinutes()).padStart(2, "0"), ss = String(t.getSeconds()).padStart(2, "0");
  statusEl.textContent = ok > 0 ? `已更新 ${ok}/${map.length} · ${hh}:${mm}:${ss}` : "未取到报价";
  statusEl.classList.toggle("err", ok === 0);
}
document.getElementById("btnRefresh").addEventListener("click", fetchQuotes);

/* ---------- 启动 ---------- */
tryLoad();
setInterval(fetchQuotes, 60000);
</script>
</body>
</html>
```

- [ ] **Step 2: 抽出 market.js（联想用到 MKT_LABEL，前端复用）**

后台页 import 了 `/shared/market.js`。Create `public/shared/market.js`:
```js
export const MKT_LABEL = { sh: "沪A", sz: "深A", hk: "港股", us: "美股", bj: "北交所" };
```

- [ ] **Step 3: Commit**

```bash
git add public/admin.html public/shared/market.js
git commit -m "feat: admin config page with login gate and autosave"
```

---

## Task 11: 本地联调与部署验证

**Files:**
- Modify: `wrangler.toml`（回填真实 `database_id`）
- Create: `README.md`

- [ ] **Step 1: 跑全部测试**

Run: `npm test`
Expected: core 与 worker 两个 project 全绿。

- [ ] **Step 2: 本地建库并起本地服务**

Run:
```bash
npm run db:init
echo 'ADMIN_PASSWORD = "dev-pass"' > .dev.vars
echo 'SESSION_SECRET = "dev-secret"' >> .dev.vars
npm run dev
```
Expected: `wrangler dev` 起在本地（默认 `http://localhost:8787`），无报错。

- [ ] **Step 3: 手动验证公开页与后台页**

打开浏览器逐项确认：
1. `http://localhost:8787/admin` → 显示登录门；输 `dev-pass` 进入。
2. 后台「添加图表」→ 代码框输入 `AAPL` → 下拉出现联想 → 选中 → 钟摆出现、状态显示「已保存」。
3. 等行情刷新，指针摆入对应区间。
4. 打开 `http://localhost:8787/` → 看到刚配的标的，只读、无配置栏、有现价。
5. 后台移除该标的 → 刷新公开页 → 已消失。
6. 退出后台 → 刷新 `/admin` → 回到登录门；直接访问 `/api/admin/items` 返回 401。

Expected: 上述全部符合。

> 若 `/api/quotes` 返回 502，确认 Worker 运行环境 `TextDecoder("gbk")` 可用；Cloudflare 运行时支持 WHATWG 编码集（含 gbk/gb18030）。本地网络需可达 `qt.gtimg.cn`。

- [ ] **Step 4: 创建远程 D1 并回填 id，部署**

Run:
```bash
npx wrangler d1 create pendulum-db
# 把输出的 database_id 填入 wrangler.toml 的 [[d1_databases]].database_id
npx wrangler d1 execute pendulum-db --remote --file=./schema.sql
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
```
Expected: 部署成功，输出 `*.workers.dev` 地址。访问 `/admin` 登录、配置；`/` 公开只读可见。

- [ ] **Step 5: 写 README**

Create `README.md`：记录架构概述、本地开发（`.dev.vars`、`npm run db:init`、`npm run dev`）、部署步骤（d1 create / secret put / deploy）、两个入口 `/` 与 `/admin` 的说明。

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml README.md
git commit -m "docs: deploy steps and readme; backfill d1 id"
```

---

## Self-Review

**Spec coverage:**
- 公开只读页 `/` → Task 9 ✓
- 后台单一密码 `/admin` → Task 10（登录门）+ Task 3（token）+ Task 6（`/api/login` 校验 `ADMIN_PASSWORD`）✓
- D1 持久化 + 数据模型 → Task 1（schema）+ Task 4（映射）+ Task 6（CRUD）✓
- 接口表（config/quotes/hints/login/logout/admin items）→ Task 6 全覆盖 ✓
- 腾讯行情 Worker 代理 + GBK 转码 → Task 5（解析）+ Task 6（`fetchGbk`）✓
- 代码联想代理 → Task 5（`parseTencentHints`）+ Task 6（`/api/hints`）+ Task 10（前端走 `/api/hints`）✓
- 鉴权 HMAC cookie → Task 3 + Task 6 中间件 ✓
- 移动/桌面自适应 → Task 9（公开页 grid 媒体查询）+ 复用原 880px 断点（styles.css）✓
- 复用 Gauge/动画/verdict → Task 2 + Task 8 ✓

**Placeholder scan:** `wrangler.toml` 的 `database_id` 是唯一占位，已在 Task 11 Step 4 明确回填流程，非代码逻辑占位。无其他 TBD/TODO。

**Type consistency:**
- API 对象统一 camelCase（`fairLow/fairHigh/mos/ext/sortOrder/symbol`），DB 列 snake_case，由 `rowToItem`（Task 4）与 `validateItem` 输出（Task 4）双向对齐，Task 6 SQL 绑定列名与 schema 一致。
- `verdictOf/structValid/computeAnchors/priceToPhi` 签名在 Task 2 定义，Task 8/9/10 调用一致（注意 `priceToPhi(anchors, price)` 为两参，Gauge.set 已按此调用）。
- `MKT_LABEL` 在 Worker 端（`src/quotes.js`，Task 5）与前端（`public/shared/market.js`，Task 10）各有一份——前端只用于下拉显示，Worker 用于过滤，职责不同、可接受的小重复，已在 Task 10 Step 2 显式建立。

无遗漏，无需返工。
