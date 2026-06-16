# Longbridge Financials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull Longbridge financial reports (IS/BS/CF) into the holding detail page — a multi-period 财报 tab — and prefill the calculator's revenue / net income / net debt from the latest annual report.

**Architecture:** A new signed HTTP GET to `/v1/quote/financial-reports` (host `https://openapi.longportapp.com`, same HMAC signing as `getOtp`). Pure parsers (`parseFinancials`, `pickLatestAnnual`, `symbolToCounterId`) are unit-tested against a captured fixture. A new `GET /api/financials` route proxies + caches and returns `{ financials, latest }`. The frontend renders three data-driven statement tables and injects `latest` into the calculator context for prefill.

**Tech Stack:** Cloudflare Workers + Hono + WebCrypto (HMAC/SHA-1) + fetch; vanilla ESM frontend; vitest (`core` plain-node + `worker` pool).

Spec: `docs/superpowers/specs/2026-06-16-longbridge-financials-design.md`. Endpoint/fields already confirmed live; fixture at `test-core/fixtures/financials-aapl.json`.

---

### Task 1: Pure parsers in `src/longbridge.js` (TDD)

**Files:**
- Modify: `src/longbridge.js` (add three exported pure functions; place them after `longportToTencent`, before the `/* ---------- 工具 ---------- */` section)
- Test: `test-core/financials.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test-core/financials.test.js`:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFinancials, pickLatestAnnual, symbolToCounterId } from "../src/longbridge.js";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/financials-aapl.json", import.meta.url)), "utf8"));

describe("symbolToCounterId", () => {
  it("maps longport symbols to ST/<MARKET>/<CODE>", () => {
    expect(symbolToCounterId("AAPL.US")).toBe("ST/US/AAPL");
    expect(symbolToCounterId("700.HK")).toBe("ST/HK/700");
    expect(symbolToCounterId("600519.SH")).toBe("ST/SH/600519");
  });
});

describe("parseFinancials", () => {
  it("flattens list[kind].indicators[].accounts[] into {IS,BS,CF}", () => {
    const f = parseFinancials(fixture);
    expect(Object.keys(f)).toEqual(expect.arrayContaining(["IS", "BS", "CF"]));
    const rev = f.IS.find((a) => a.field === "OperatingRevenue");
    expect(rev.name).toContain("营业收入");
    expect(rev.values[0].year).toBe(2025);
    expect(rev.values[0].value).toBeCloseTo(416161000000, 0);
    expect(rev.currency).toBe("USD");
  });
  it("returns null on error/empty payloads", () => {
    expect(parseFinancials({ code: 404000, data: null })).toBe(null);
    expect(parseFinancials(null)).toBe(null);
    expect(parseFinancials({ code: 0, data: {} })).toBe(null);
  });
});

describe("pickLatestAnnual", () => {
  it("picks revenue/netIncome/netDebt from the latest annual period", () => {
    const latest = pickLatestAnnual(parseFinancials(fixture));
    expect(latest.revenue).toBeCloseTo(416161000000, 0);
    expect(latest.netIncome).toBeCloseTo(112010000000, 0);
    expect(typeof latest.netDebt).toBe("number");
  });
  it("returns all-null for null financials", () => {
    expect(pickLatestAnnual(null)).toEqual({ revenue: null, netIncome: null, netDebt: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project core test-core/financials.test.js`
Expected: FAIL — `parseFinancials is not a function` (not yet exported).

- [ ] **Step 3: Implement the three functions**

In `src/longbridge.js`, add after the `longportToTencent` function (right before the `/* ---------- 工具 ---------- */` comment):

```js
/* ---------- 财报（Fundamental Financial Report） ---------- */
// LongPort symbol → counter_id：AAPL.US → ST/US/AAPL
export function symbolToCounterId(lp) {
  const i = lp.lastIndexOf(".");
  if (i < 0) return lp;
  return `ST/${lp.slice(i + 1).toUpperCase()}/${lp.slice(0, i)}`;
}

// 解析 /v1/quote/financial-reports 响应 → { IS:[Acct], BS:[Acct], CF:[Acct] } 或 null
// Acct = { field, name, currency, values:[{ year, fpEnd, period, value:Number, yoy }] }（最新期在前）
export function parseFinancials(json) {
  if (!json || json.code !== 0 || !json.data || !json.data.list) return null;
  const list = json.data.list;
  const out = {};
  for (const kind of Object.keys(list)) {
    const inds = (list[kind] && list[kind].indicators) || [];
    const accts = [];
    for (const ind of inds) {
      const cur = ind.currency || "";
      for (const a of ind.accounts || []) {
        accts.push({
          field: a.field, name: a.name, currency: a.currency || cur,
          values: (a.values || []).map((v) => ({ year: v.year, fpEnd: v.fp_end, period: v.period, value: parseFloat(v.value), yoy: v.yoy || "" })),
        });
      }
    }
    out[kind] = accts;
  }
  return Object.keys(out).length ? out : null;
}

// 从已解析财报取最近一期年报的关键数字（取不到为 null）
export function pickLatestAnnual(financials) {
  const pick = (kind, field) => {
    const a = financials && financials[kind] && financials[kind].find((x) => x.field === field);
    const v = a && a.values && a.values[0] && a.values[0].value;
    return Number.isFinite(v) ? v : null;
  };
  return { revenue: pick("IS", "OperatingRevenue"), netIncome: pick("IS", "NetProfit"), netDebt: pick("BS", "NetDebt") };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project core test-core/financials.test.js`
Expected: PASS (8 assertions across 3 describes).

- [ ] **Step 5: Commit**

```bash
git add src/longbridge.js test-core/financials.test.js
git commit -m "feat(longbridge): parse financial reports + pickLatestAnnual (pure, tested)"
```

---

### Task 2: Signed fetch in `src/longbridge.js`

**Files:**
- Modify: `src/longbridge.js` (add `signedGet` + `fetchLongbridgeFinancials`; place right after the three functions from Task 1)

- [ ] **Step 1: Implement the signed fetch**

In `src/longbridge.js`, immediately after `pickLatestAnnual`, add:

```js
// 签名 GET（沿用 getOtp 的 canonical 规则；query 须按 key 字母序，签名与 URL 用同一字符串）
async function signedGet(env, path, query) {
  const ts = (Date.now() / 1000).toFixed(3);
  const names = "authorization;x-api-key;x-timestamp";
  const sh = `authorization:${env.LONGBRIDGE_ACCESS_TOKEN}\nx-api-key:${env.LONGBRIDGE_APP_KEY}\nx-timestamp:${ts}\n`;
  const canonical = `GET|${path}|${query}|${sh}|${names}|`;
  const sig = await hmac256hex(env.LONGBRIDGE_APP_SECRET, "HMAC-SHA256|" + await sha1hex(canonical));
  const res = await fetch(HTTP_HOST + path + (query ? "?" + query : ""), {
    headers: {
      authorization: env.LONGBRIDGE_ACCESS_TOKEN,
      "x-api-key": env.LONGBRIDGE_APP_KEY,
      "x-timestamp": ts,
      "x-api-signature": `HMAC-SHA256 SignedHeaders=${names}, Signature=${sig}`,
    },
  });
  return res.json();
}

// 取财报：report = "af"(年报) | "qf"(季报)。失败/空 → null。
export async function fetchLongbridgeFinancials(env, tencentSymbol, report) {
  const lp = tencentToLongport(tencentSymbol);
  if (!lp) return null;
  const rep = report === "qf" ? "qf" : "af";
  const query = `counter_id=${symbolToCounterId(lp)}&kind=ALL&report=${rep}`; // 已按字母序：counter_id<kind<report
  try { return parseFinancials(await signedGet(env, "/v1/quote/financial-reports", query)); }
  catch { return null; }
}
```

- [ ] **Step 2: Verify the module still imports (no syntax error)**

Run: `npx vitest run --project core test-core/financials.test.js`
Expected: PASS (unchanged — pure tests still green; this proves the file parses with the new code).

- [ ] **Step 3: Commit**

```bash
git add src/longbridge.js
git commit -m "feat(longbridge): signed fetchLongbridgeFinancials over HTTP"
```

---

### Task 3: `GET /api/financials` route

**Files:**
- Modify: `src/index.js` (import + new route; add the route right after the `app.get("/api/names", ...)` handler)
- Test: `test/routes.test.js` (add one case)

- [ ] **Step 1: Write the failing route test**

In `test/routes.test.js`, add this describe block at the end of the file (before the final closing of the file):

```js
describe("financials", () => {
  it("returns {financials:null} when no Longbridge creds are configured", async () => {
    const r = await SELF.fetch("https://x/api/financials?symbol=usAAPL");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty("financials");
    expect(j.financials).toBe(null);
  });
  it("returns {financials:null} for a missing symbol", async () => {
    const r = await SELF.fetch("https://x/api/financials");
    expect(r.status).toBe(200);
    expect((await r.json()).financials).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project worker test/routes.test.js`
Expected: FAIL — `/api/financials` 404s (route not defined) so `r.status` is 404, assertion fails.

- [ ] **Step 3: Add the import**

In `src/index.js`, find the import line that brings in Longbridge helpers (it imports `fetchLongbridgeNames`/`fetchLongbridgeQuotes`). Add `fetchLongbridgeFinancials` and `pickLatestAnnual` to that import list. Example — change:

```js
import { fetchLongbridgeQuotes, fetchLongbridgeNames } from "./longbridge.js";
```
to:
```js
import { fetchLongbridgeQuotes, fetchLongbridgeNames, fetchLongbridgeFinancials, pickLatestAnnual } from "./longbridge.js";
```
(Keep whatever other names are already imported on that line; only add the two new ones.)

- [ ] **Step 4: Add the route**

In `src/index.js`, immediately after the `app.get("/api/names", ...)` handler's closing `});`, add:

```js
// 财报（Fundamental）：按需取 + 缓存一天。无凭据/无权限 → financials:null（前端优雅降级）。
app.get("/api/financials", async (c) => {
  const symbol = (c.req.query("symbol") || "").trim();
  const report = c.req.query("period") === "quarter" ? "qf" : "af";
  let financials = null;
  if (symbol && c.env.LONGBRIDGE_APP_KEY && c.env.LONGBRIDGE_APP_SECRET && c.env.LONGBRIDGE_ACCESS_TOKEN) {
    try { financials = await fetchLongbridgeFinancials(c.env, symbol, report); }
    catch (e) { console.error("financials failed:", e && e.message); financials = null; }
  }
  c.header("Cache-Control", "public, max-age=86400");
  return c.json({ financials, latest: pickLatestAnnual(financials) });
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run --project worker test/routes.test.js`
Expected: PASS (the two new financials cases + all existing).

- [ ] **Step 6: Commit**

```bash
git add src/index.js test/routes.test.js
git commit -m "feat(api): GET /api/financials proxy (cached, graceful null)"
```

---

### Task 4: Calculator prefill from financials

**Files:**
- Modify: `public/shared/valuation/intrinsic.js` (FCFF `revenue`, FCFF `netDebt`, FCFE `netIncome`)
- Modify: `public/shared/valuation/relative.js` (PE `revenue`, PS `revenue`, EV/EBITDA `netDebt`)

- [ ] **Step 1: FCFF revenue prefill (intrinsic.js)**

Change the FCFF `revenue` field (currently `prefill: (ctx) => ""`):

```js
    { k: "revenue", label: { zh: "当前营收", en: "Current revenue" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.revenue)) ? ctx.revenue : "", hint: { zh: "公司总营收（不是每股）", en: "Total revenue, not per share" } },
```

- [ ] **Step 2: FCFF netDebt prefill (intrinsic.js)**

Change the FCFF `netDebt` field (currently `prefill: (ctx) => 0, default: 0`):

```js
    { k: "netDebt", label: { zh: "净负债", en: "Net debt" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.netDebt)) ? ctx.netDebt : 0, default: 0 },
```

- [ ] **Step 3: FCFE netIncome prefill (intrinsic.js)**

Replace the FCFE `netIncome` prefill body (currently computes `epsTtm*shares`) so it prefers `ctx.netIncome`:

```js
      prefill: (ctx) => {
        if (ctx && Number.isFinite(ctx.netIncome)) return ctx.netIncome;
        const v = (ctx && ctx.epsTtm) * (ctx && ctx.shares);
        return Number.isFinite(v) ? v : "";
      },
```

- [ ] **Step 4: PE + PS revenue prefill (relative.js)**

Both the PE and PS models have a `revenue` field with `prefill: (ctx) => ""`. Change BOTH to:

```js
    { k: "revenue", label: { zh: "当前营收", en: "Current revenue" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.revenue)) ? ctx.revenue : "", hint: { zh: "公司总营收（不是每股）", en: "Total revenue, not per share" } },
```

- [ ] **Step 5: EV/EBITDA netDebt prefill (relative.js)**

Change the EV/EBITDA `netDebt` field (currently `prefill: (ctx) => "", default: 0`):

```js
    { k: "netDebt", label: { zh: "净负债", en: "Net debt" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.netDebt)) ? ctx.netDebt : "", default: 0 },
```

- [ ] **Step 6: Verify model unit tests still pass**

Run: `npx vitest run --project core test-core/valuation-intrinsic.test.js test-core/valuation-relative.test.js`
Expected: PASS (prefill changes don't affect `compute`; existing model tests stay green).

- [ ] **Step 7: Commit**

```bash
git add public/shared/valuation/intrinsic.js public/shared/valuation/relative.js
git commit -m "feat(valuation): prefill revenue/netIncome/netDebt from financials ctx"
```

---

### Task 5: i18n strings for the financials tab

**Files:**
- Modify: `public/shared/i18n.js` (add keys in both `zh` and `en`, next to the existing `d_*` detail keys)

- [ ] **Step 1: Add zh keys**

In the `zh` dictionary, right after `d_soon: "即将上线",`, add:

```js
    d_stmt_is: "利润表", d_stmt_bs: "资产负债表", d_stmt_cf: "现金流",
    d_period_annual: "年报", d_period_quarter: "季报",
    d_loading: "加载中…", d_no_financials: "暂无财报数据",
```

- [ ] **Step 2: Add en keys**

In the `en` dictionary, right after `d_soon: "Coming soon",`, add:

```js
    d_stmt_is: "Income", d_stmt_bs: "Balance", d_stmt_cf: "Cash flow",
    d_period_annual: "Annual", d_period_quarter: "Quarterly",
    d_loading: "Loading…", d_no_financials: "No financials available",
```

- [ ] **Step 3: Commit**

```bash
git add public/shared/i18n.js
git commit -m "feat(i18n): financials tab strings"
```

---

### Task 6: 财报 tab rendering + fetch + ctx injection (`public/index.html`)

**Files:**
- Modify: `public/index.html` (import `pickLatestAnnual`; `valuationCtx`; replace the panelEls[1] placeholder; add `renderFinancialsPanel` + helpers; add CSS)

- [ ] **Step 1: Import the client-side picker**

The board already imports from valuation modules. Update the MODELS import line to also bring `pickLatestAnnual` from the shared financials... — NO: `pickLatestAnnual` lives in `src/longbridge.js` (server). The client must NOT import server code. Instead the client reads the `latest` object returned by `/api/financials`. So **no new import is needed** for picking; the client uses the route's `latest`. (This step is a no-op confirmation — do not add an import.)

- [ ] **Step 2: Add the fetch helper + financials table renderers**

In `public/index.html`, immediately before `function renderValuationPanel(` , add:

```js
// 按需取财报（按 period 在 item 上内存缓存本会话）。返回 { financials, latest }。
function loadFinancials(item, period) {
  item._financials = item._financials || {};
  if (item._financials[period]) return Promise.resolve(item._financials[period]);
  const url = `/api/financials?symbol=${encodeURIComponent(item.cfg.symbol)}&period=${period}`;
  return fetch(url).then((r) => r.json()).then((j) => (item._financials[period] = j))
    .catch(() => (item._financials[period] = { financials: null, latest: null }));
}

// 财报数值格式：大额用 fmtBig（按币种），小额（比率/每股）保留两位
function finFmt(n, currency) {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return (n < 0 ? "-" : "") + fmtBig(a, currency);
  return n.toFixed(2);
}

// 一张报表（accounts）→ 多期表格（最多 6 期）
function financialsTable(accounts) {
  const cols = Math.min(6, (accounts[0] && accounts[0].values.length) || 0);
  const table = document.createElement("table"); table.className = "fin-table";
  const thead = document.createElement("thead"); const htr = document.createElement("tr");
  htr.appendChild(document.createElement("th"));
  for (let j = 0; j < cols; j++) { const th = document.createElement("th"); th.textContent = accounts[0].values[j].period; htr.appendChild(th); }
  thead.appendChild(htr); table.appendChild(thead);
  const tb = document.createElement("tbody");
  accounts.forEach((a) => {
    const tr = document.createElement("tr");
    const nm = document.createElement("td"); nm.className = "fin-name"; nm.textContent = a.name; tr.appendChild(nm);
    for (let j = 0; j < cols; j++) { const td = document.createElement("td"); const v = a.values[j]; td.textContent = v ? finFmt(v.value, a.currency) : "—"; tr.appendChild(td); }
    tb.appendChild(tr);
  });
  table.appendChild(tb); return table;
}

// 财报 tab：报表(利润表/资产负债表/现金流) × 周期(年报/季报) 切换 + 表格
function renderFinancialsPanel(item, panel) {
  panel.innerHTML = "";
  let stmt = "IS", period = "annual";
  const controls = document.createElement("div"); controls.className = "fin-controls";
  const stmtSeg = document.createElement("div"); stmtSeg.className = "fin-seg";
  const perSeg = document.createElement("div"); perSeg.className = "fin-seg";
  const body = document.createElement("div"); body.className = "fin-body";
  panel.append(controls, body); controls.append(stmtSeg, perSeg);

  const stmtBtns = [["IS", "d_stmt_is"], ["BS", "d_stmt_bs"], ["CF", "d_stmt_cf"]].map(([k, key]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "fin-segbtn"; b.textContent = t(key);
    b.addEventListener("click", () => { stmt = k; sync(); draw(); }); stmtSeg.appendChild(b); return [k, b];
  });
  const perBtns = [["annual", "d_period_annual"], ["quarter", "d_period_quarter"]].map(([k, key]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "fin-segbtn"; b.textContent = t(key);
    b.addEventListener("click", () => { period = k; sync(); draw(); }); perSeg.appendChild(b); return [k, b];
  });
  function sync() {
    stmtBtns.forEach(([k, b]) => b.classList.toggle("on", k === stmt));
    perBtns.forEach(([k, b]) => b.classList.toggle("on", k === period));
  }
  function draw() {
    body.innerHTML = `<div class="vd-empty">${t("d_loading")}</div>`;
    const reqStmt = stmt, reqPeriod = period;
    loadFinancials(item, period).then(({ financials }) => {
      if (reqStmt !== stmt || reqPeriod !== period) return; // 期间用户又切了，忽略旧结果
      body.innerHTML = "";
      const accts = financials && financials[stmt];
      if (!accts || !accts.length) { const e = document.createElement("div"); e.className = "vd-empty"; e.textContent = t("d_no_financials"); body.appendChild(e); return; }
      body.appendChild(financialsTable(accts));
    });
  }
  sync(); draw();
}
```

- [ ] **Step 3: Wire the financials tab + prefetch on detail open**

In `renderDetail`, replace the financials placeholder line:

```js
  { const e = document.createElement("div"); e.className = "vd-empty"; e.textContent = t("d_soon"); panelEls[1].appendChild(e); }
```
with:
```js
  renderFinancialsPanel(item, panelEls[1]);
  loadFinancials(item, "annual"); // 预取年报，供计算器预填
```

- [ ] **Step 4: Inject financials into the calculator context**

Replace the whole `valuationCtx` function with:

```js
function valuationCtx(item) {
  const c = item.cfg, s = item.statics || {};
  const latest = (item._financials && item._financials.annual && item._financials.annual.latest) || {};
  return { price: c.price || 0, epsTtm: parseFloat(s.epsTtm) || NaN, bps: parseFloat(s.bps) || NaN,
    shares: Number(s.totalShares) || 0, dividendYield: parseFloat(s.dividendYield) || NaN, mos: c.mos || 0, ext: c.ext || 0,
    revenue: Number.isFinite(latest.revenue) ? latest.revenue : undefined,
    netIncome: Number.isFinite(latest.netIncome) ? latest.netIncome : undefined,
    netDebt: Number.isFinite(latest.netDebt) ? latest.netDebt : undefined };
}
```

- [ ] **Step 5: Add CSS for the financials tab**

In `public/index.html`, immediately after the `.vcard-add:hover{...}` rule (end of the valuation-card CSS block), add:

```css
  /* 财报 tab */
  .fin-controls{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:16px}
  .fin-seg{display:flex;gap:4px}
  .fin-segbtn{height:28px;padding:0 11px;border:1px solid var(--border);border-radius:8px;background:transparent;cursor:pointer;font-family:var(--font);font-size:12.5px;color:var(--ink-soft);transition:background .12s,color .12s,border-color .12s}
  .fin-segbtn:hover{color:var(--ink);border-color:var(--node)}
  .fin-segbtn.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
  .fin-table{width:100%;border-collapse:collapse;font-size:13px}
  .fin-table th{text-align:right;padding:8px 10px;font-weight:500;color:var(--ink-mute);font-size:11.5px;border-bottom:1px solid var(--divider);white-space:nowrap}
  .fin-table th:first-child{text-align:left}
  .fin-table td{text-align:right;padding:9px 10px;border-bottom:1px solid var(--border);font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--ink);white-space:nowrap}
  .fin-table td.fin-name{text-align:left;font-family:var(--font);color:var(--ink-soft);white-space:normal}
  .fin-table tr:hover td{background:var(--card)}
```

- [ ] **Step 6: Verify in the browser**

Run `npm run dev` (if not running). As the demo owner on `http://localhost:8787/b/demo/AAPL`:
1. 财报 tab → 利润表 shows a multi-year table (营业收入/净利润/营业利润… with FY columns); toggling 资产负债表/现金流 and 年报/季报 re-renders.
2. 估值研究 → 添加估值 → FCFF or PE: 当前营收 is prefilled with the latest annual revenue (~416B → shows as a big number); FCFF 净负债 prefilled from financials; FCFE 净利润 prefilled.
3. A symbol with no financials (or when creds absent) → 财报 tab shows 「暂无财报数据」 and prefill falls back (revenue empty / netDebt 0).

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): financials tab (IS/BS/CF tables) + calculator prefill"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — previous 97 + new (`financials.test.js` core cases + 2 route cases). `numFailedTests: 0`.

- [ ] **Step 2: Manual matrix (browser, demo owner)**

Confirm: 财报 three statements × annual/quarter render; values formatted (big = B/亿, ratios = 2dp); calculator revenue/netIncome/netDebt prefilled from latest annual; English toggle localizes tab controls; graceful empty state.

- [ ] **Step 3: Final commit (if tidy-ups)**

```bash
git add -A && git commit -m "chore: financials verification tidy-ups" || echo "nothing to commit"
```

> **Deploy note:** no schema change. Financials need the Worker's `LONGBRIDGE_*` secrets (already set for quotes/names). Cache is `max-age=86400`.
