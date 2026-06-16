# Detail Page + Bar Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the valuation viz two forms — a horizontal 5-segment bar in list rows, and the full pendulum on a real-route detail page (`/b/<slug>/<code>`) with key-info header + three tabs (基本面 / 财报 / 估值研究).

**Architecture:** Vanilla ESM SPA on Cloudflare Workers (Hono + Static Assets). New `Bar` div-based renderer mirrors `Gauge`'s `priceToPhi` mapping. Detail page is client-routed via History API; the worker serves the same `index.html` for the detail path. 基本面 metrics are computed from Longbridge `SecurityStaticInfo` (already fetched for names) × current price.

**Tech Stack:** Cloudflare Workers, Hono, D1, vanilla JS/ESM, vitest (`@cloudflare/vitest-pool-workers`).

**Conventions:** Commit when the user asks (they run trunk-based on `main`). Verify UI in-browser via chrome-devtools MCP against `npm run dev` (localhost:8787, board `/b/demo`). Keep all 57 existing tests green.

---

## File Structure

- `public/shared/bar.js` **(new)** — `Bar` renderer (div-based horizontal 5-segment bar). One responsibility: render+animate the bar form. Imports zones/mapping from `core.js`, `LANG` from `i18n.js`.
- `public/shared/gauge.js` — full pendulum reused for detail. Remove the now-unused list `compact` path *only if trivially clean*; otherwise leave it (the detail uses non-compact).
- `public/shared/i18n.js` — add keys for detail page (tabs, 基本面 metric labels, 返回, 财报占位, 估值研究 fields).
- `public/index.html` — list rows use `Bar`; client router (list/detail/settings); detail view markup + render; row click-through; store `item.statics`.
- `src/longbridge.js` — extend `parseStaticInfo` to read more fields; `fetchLongbridgeNames` returns full static object. Export `parseStaticInfo` for unit test.
- `src/index.js` — add `GET /b/:slug/:code` → serve root index.html; `/api/names` returns extended static object.
- `test/longbridge.test.js` — add unit test for extended `parseStaticInfo`.

---

## Task 1: Server route for the detail path

**Files:** Modify `src/index.js` (near the existing `app.get("/b/:slug", ...)`, ~line with `/* 公开页路由 */`).

- [ ] **Step 1: Add the detail route**

In `src/index.js`, immediately after the existing line:
```js
app.get("/b/:slug", (c) => { const url = new URL(c.req.url); url.pathname = "/"; return c.env.ASSETS.fetch(new Request(url, { method: "GET" })); });
```
add:
```js
// 标的详情页：同一个 SPA，前端按 /b/<slug>/<code> 解析后渲染详情
app.get("/b/:slug/:code", (c) => { const url = new URL(c.req.url); url.pathname = "/"; return c.env.ASSETS.fetch(new Request(url, { method: "GET" })); });
```

- [ ] **Step 2: Verify it serves the SPA**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/b/demo/AAPL`
Expected: `200` (and `curl -s http://localhost:8787/b/demo/AAPL | grep -c ValuePort` ≥ 1 — it's the board index.html).

- [ ] **Step 3: Commit** (only when the user asks to commit/deploy)

---

## Task 2: Extend Longbridge static-info parsing (backend) + test

**Files:** Modify `src/longbridge.js` (`parseStaticInfo`, `fetchLongbridgeNames`), `src/index.js` (`/api/names`), `test/longbridge.test.js`.

Field numbers per Longbridge quote proto `SecurityStaticInfo`: `symbol=1, name_cn=2, name_en=3, name_hk=4, exchange=5, currency=6, total_shares=8 (varint), eps_ttm=12 (string), bps=13 (string), dividend_yield=14 (string)`. **Verify against the live dev response in Step 5** (names 2/3 already verified working).

- [ ] **Step 1: Write the failing test**

Add to `test/longbridge.test.js`:
```js
import { tencentToLongport, longportToTencent, parseStaticInfo } from "../src/longbridge.js";

describe("parseStaticInfo extracts fundamentals", () => {
  // build a SecurityStaticInfoResponse{ secu_static_info=1 { symbol=1, name_cn=2, name_en=3, exchange=5, currency=6, total_shares=8, eps_ttm=12, bps=13, dividend_yield=14 } }
  const pstr = (field, s) => { const b = new TextEncoder().encode(s); return [(field << 3) | 2, b.length, ...b]; };
  const pvar = (field, n) => { const o = [(field << 3) | 0]; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
  const inner = [
    ...pstr(1, "AAPL.US"), ...pstr(2, "苹果"), ...pstr(3, "Apple"),
    ...pstr(5, "NASDAQ"), ...pstr(6, "USD"), ...pvar(8, 15000000000),
    ...pstr(12, "6.5"), ...pstr(13, "4.2"), ...pstr(14, "0.5"),
  ];
  const body = new Uint8Array([(1 << 3) | 2, inner.length, ...inner]);

  it("parses symbol, names, and fundamental fields", () => {
    const out = parseStaticInfo(body);
    expect(out).toHaveLength(1);
    const r = out[0];
    expect(r.sym).toBe("AAPL.US");
    expect(r.cn).toBe("苹果");
    expect(r.en).toBe("Apple");
    expect(r.exchange).toBe("NASDAQ");
    expect(r.currency).toBe("USD");
    expect(r.totalShares).toBe(15000000000);
    expect(r.epsTtm).toBe("6.5");
    expect(r.bps).toBe("4.2");
    expect(r.dividendYield).toBe("0.5");
  });
});
```
(Note: `total_shares` test value is < 2^53 so plain number arithmetic in `pvar`/parser is fine.)

- [ ] **Step 2: Run test, expect FAIL**

Run: `npm test -- longbridge 2>&1 | tail -20`
Expected: FAIL — `parseStaticInfo` is not exported / returns objects without `exchange/currency/totalShares/...`.

- [ ] **Step 3: Implement — extend `parseStaticInfo` and export it**

In `src/longbridge.js`, replace the current `parseStaticInfo` with:
```js
export function parseStaticInfo(body) { // SecurityStaticInfoResponse{repeated secu_static_info=1}; StaticInfo{symbol=1,name_cn=2,name_en=3,name_hk=4,exchange=5,currency=6,total_shares=8,eps_ttm=12,bps=13,dividend_yield=14}
  const dec = new TextDecoder();
  const out = [];
  for (const [f, wt, val] of pbFields(body)) {
    if (f === 1 && wt === 2) {
      let sym = null, cn = "", en = "", hk = "", exchange = "", currency = "", totalShares = 0, epsTtm = "", bps = "", dividendYield = "";
      for (const [ff, ww, vv] of pbFields(val)) {
        if (ff === 1 && ww === 2) sym = dec.decode(vv);
        else if (ff === 2 && ww === 2) cn = dec.decode(vv);
        else if (ff === 3 && ww === 2) en = dec.decode(vv);
        else if (ff === 4 && ww === 2) hk = dec.decode(vv);
        else if (ff === 5 && ww === 2) exchange = dec.decode(vv);
        else if (ff === 6 && ww === 2) currency = dec.decode(vv);
        else if (ff === 8 && ww === 0) totalShares = vv;
        else if (ff === 12 && ww === 2) epsTtm = dec.decode(vv);
        else if (ff === 13 && ww === 2) bps = dec.decode(vv);
        else if (ff === 14 && ww === 2) dividendYield = dec.decode(vv);
      }
      if (sym) out.push({ sym, cn, en, hk, exchange, currency, totalShares, epsTtm, bps, dividendYield });
    }
  }
  return out;
}
```

- [ ] **Step 4: Update `fetchLongbridgeNames` to return the full object**

In `src/longbridge.js`, in the cmd-10 handler of `fetchLongbridgeNames`, replace:
```js
            for (const { sym, cn, en, hk } of parseStaticInfo(fr.body)) {
              const tc = lpToTc.get(sym);
              if (tc) out[tc] = { cn: cn || "", en: en || hk || "" };
            }
```
with:
```js
            for (const r of parseStaticInfo(fr.body)) {
              const tc = lpToTc.get(r.sym);
              if (tc) out[tc] = {
                cn: r.cn || "", en: r.en || r.hk || "",
                exchange: r.exchange || "", currency: r.currency || "",
                totalShares: r.totalShares || 0, epsTtm: r.epsTtm || "", bps: r.bps || "", dividendYield: r.dividendYield || "",
              };
            }
```

- [ ] **Step 5: Run test (PASS) + verify live**

Run: `npm test -- longbridge 2>&1 | tail -6` → Expected: PASS (all longbridge tests).
Run: `curl -s "http://localhost:8787/api/names?symbols=usAAPL,usMU" | head -c 600`
Expected: JSON `names.usAAPL` now includes `currency`, `totalShares`, `epsTtm`, `bps`, `dividendYield` (real values). **If any field is empty for all symbols, the proto field number is wrong — inspect by temporarily logging raw `pbFields` field numbers and correct.**

- [ ] **Step 6: `/api/names` already returns whatever `fetchLongbridgeNames` returns** — no change needed (it returns `names` verbatim). Confirm by re-reading `src/index.js` `/api/names` handler.

- [ ] **Step 7: Run full suite + commit**

Run: `npm test 2>&1 | grep -E "Tests "` → Expected: `Tests  58 passed (58)` (57 + the new one).

---

## Task 3: Bar component (`public/shared/bar.js`)

**Files:** Create `public/shared/bar.js`.

- [ ] **Step 1: Create the file**

```js
// 横向五段色带：钟摆"展平"——同一套 priceToPhi 映射，列表行里用
import { ZONES, computeAnchors, priceToPhi } from "./core.js";
import { LANG } from "./i18n.js";

const REDUCE = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const SEG_DEG = 180 / ZONES.length; // 36
// 区间缩写（与钟摆五区间一一对应：深度低估/低估/合理/高估/极度高估）
const ZONE_SHORT = {
  zh: ["深值", "低估", "合理", "高估", "极高"],
  en: ["Deep", "Under", "Fair", "Over", "Ext"],
};

export class Bar {
  constructor(mount) { this.build(mount); }
  build(mount) {
    const shorts = ZONE_SHORT[LANG] || ZONE_SHORT.en;
    const root = document.createElement("div"); root.className = "vbar";
    const labels = document.createElement("div"); labels.className = "vbar-labels";
    this.labelEls = ZONES.map((z, i) => { const s = document.createElement("span"); s.textContent = shorts[i] || z.en; labels.appendChild(s); return s; });
    const track = document.createElement("div"); track.className = "vbar-track";
    this.segs = ZONES.map(() => { const d = document.createElement("div"); d.className = "vbar-seg"; track.appendChild(d); return d; });
    this.marker = document.createElement("div"); this.marker.className = "vbar-marker"; this.marker.style.left = "50%";
    track.appendChild(this.marker);
    const ticks = document.createElement("div"); ticks.className = "vbar-ticks";
    this.tickEls = [0, 1, 2, 3].map((k) => { const s = document.createElement("span"); s.className = "vbar-tick"; s.style.left = ((k + 1) * 20) + "%"; ticks.appendChild(s); return s; });
    root.append(labels, track, ticks);
    mount.appendChild(root);
    this.root = root;
  }
  set(cfg, animate = true) {
    const anchors = computeAnchors(cfg); // [0, t1, t2, t3, t4, Infinity]
    this.tickEls.forEach((el, k) => { const v = anchors[k + 1]; el.textContent = isFinite(v) ? Math.round(v) : ""; });
    const hasPrice = cfg.price > 0;
    const phi = hasPrice ? priceToPhi(anchors, cfg.price) : 90;
    const zi = hasPrice ? Math.min(ZONES.length - 1, Math.floor(Math.max(0, Math.min(180, phi)) / SEG_DEG)) : -1;
    this.segs.forEach((d, i) => { d.style.background = i === zi ? ZONES[i].hex : "var(--track)"; });
    this.labelEls.forEach((s, i) => { s.style.color = i === zi ? "var(--ink)" : "var(--ink-mute)"; s.style.fontWeight = i === zi ? "600" : "500"; });
    const x = Math.max(0, Math.min(100, phi / 180 * 100));
    this.marker.style.display = hasPrice ? "" : "none";
    if (!animate || REDUCE) { this.marker.style.transition = "none"; this.marker.style.left = x + "%"; }
    else { this.marker.style.transition = "left 1.1s cubic-bezier(.22,1,.36,1)"; requestAnimationFrame(() => { this.marker.style.left = x + "%"; }); }
  }
  destroy() { if (this.root) this.root.remove(); }
}
```

- [ ] **Step 2: No standalone test** (DOM component; verified in Task 4 browser check). Confirm the file imports resolve (no syntax error) by loading the board after Task 4.

---

## Task 4: List rows use `Bar`

**Files:** Modify `public/index.html` — import `Bar`; `addChart` uses `Bar`; CSS for `.vbar*`; `loadNames` stores `item.statics`.

- [ ] **Step 1: Import Bar**

In `public/index.html` `<script type="module">`, next to the gauge import:
```js
import { Gauge } from "/shared/gauge.js";
```
add:
```js
import { Bar } from "/shared/bar.js";
```
(If `Gauge` is imported differently, add the `Bar` import alongside it.)

- [ ] **Step 2: Swap the list renderer in `addChart`**

In `addChart`, replace the right-side gauge block:
```js
  const gwrap = document.createElement("div");
  gwrap.className = "chart-gauge";
  const gauge = new Gauge(gwrap, { compact: true });
  wrap.append(info, gwrap);
```
with:
```js
  const gwrap = document.createElement("div");
  gwrap.className = "chart-bar";
  const gauge = new Bar(gwrap); // 列表行用横向条形图
  wrap.append(info, gwrap);
```
(The `item.gauge` field keeps holding the renderer — `Bar` has the same `set(cfg, animate)` / `destroy()` API, so `gauge.set(...)` calls elsewhere keep working. `gauge.setName` is no longer called for list — name is in `.chart-info` via `renderItemHead`.)

- [ ] **Step 3: Replace `.chart-gauge` CSS with `.chart-bar` + bar styles**

In `public/index.html` `<style>`, replace the `.chart-gauge{...}` and `.chart-gauge svg{...}` rules (and the mobile `.chart-gauge{width:...}`) with:
```css
  .chart-bar{flex:none;width:240px}
  .vbar{width:100%}
  .vbar-labels{display:flex;font-size:10px;letter-spacing:.02em;color:var(--ink-mute);margin-bottom:5px}
  .vbar-labels span{flex:1;text-align:center;transition:color .35s}
  .vbar-track{position:relative;display:flex;height:14px;border:1px solid var(--border);border-radius:3px;overflow:hidden}
  .vbar-seg{flex:1;transition:background .4s ease}
  .vbar-seg + .vbar-seg{border-left:1px solid var(--bg)}
  .vbar-marker{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--hub);transition:left 1.1s cubic-bezier(.22,1,.36,1)}
  .vbar-marker::after{content:"";position:absolute;top:-5px;left:50%;transform:translateX(-50%);border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--hub)}
  .vbar-ticks{position:relative;height:13px;margin-top:4px}
  .vbar-tick{position:absolute;transform:translateX(-50%);font-family:var(--mono);font-size:10.5px;color:var(--ink-soft);font-variant-numeric:tabular-nums;white-space:nowrap}
```
In the `@media (max-width:560px)` block, replace `.chart-gauge{width:...}` with:
```css
    .chart-bar{width:160px}
    .vbar-labels{font-size:9px}
```

- [ ] **Step 4: Store full static info in `loadNames`**

In `public/index.html` `loadNames`, replace:
```js
      item.nameCn = n.cn || ""; item.nameEn = n.en || "";
      renderItemHead(item);
```
with:
```js
      item.nameCn = n.cn || ""; item.nameEn = n.en || "";
      item.statics = n; // {cn,en,exchange,currency,totalShares,epsTtm,bps,dividendYield}
      renderItemHead(item);
```

- [ ] **Step 5: Browser verify**

Reload `http://localhost:8787/b/demo`. Expect each row: left info + right horizontal 5-segment bar; the active zone segment colored, others grey; 4 threshold numbers under boundaries; a marker (with a small triangle) at the price; marker animates in on load. Take a screenshot to confirm marker position roughly matches the verdict (e.g., 高估 → marker in the 4th segment).

- [ ] **Step 6: Run `npm test` (still 58) + commit (when asked)**

---

## Task 5: Client router (list ↔ detail) + row click + back

**Files:** Modify `public/index.html`.

Background: slug is parsed at startup via `location.pathname.match(/^\/b\/([^/]+)/)` into `boardSlug`. Detail adds a 2nd segment = ticker code. There is an existing `setView(v)` used by the topnav (board/settings) — Task 6 will fold it into `showView`. This task wires routing + click + back using a `route()` function that calls `showList()` / `showDetail(item)` (defined in Task 6). For this task, stub `showDetail` to `console.log` if Task 6 isn't done yet; if doing tasks in order, Task 6 defines them.

- [ ] **Step 1: Add `route()` + popstate, call after initial render**

In `public/index.html`, after the board render completes (right after `loadNames(items.map((i) => i.cfg.symbol));` at the end of the render function), add:
```js
  route();
```
And define near the view functions (Task 6 area):
```js
function currentDetailCode() {
  const m = location.pathname.match(/^\/b\/[^/]+\/([^/]+)/);
  return m ? decodeURIComponent(m[1]).toUpperCase() : null;
}
function route() {
  const code = currentDetailCode();
  const item = code ? items.find((i) => (i.cfg.ticker || "").toUpperCase() === code) : null;
  if (item) showDetail(item); else showList();
}
window.addEventListener("popstate", route);
```

- [ ] **Step 2: Row click navigates to detail**

In `addChart`, after `wrap.append(info, gwrap);` (and before the owner edit button, so the button's own click can `stopPropagation`), add a row click handler:
```js
  wrap.addEventListener("click", (e) => {
    if (e.target.closest(".card-edit")) return; // 编辑按钮不触发进详情
    const code = (item.cfg.ticker || "").toUpperCase();
    if (!code) return;
    history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug) + "/" + encodeURIComponent(code));
    showDetail(item);
  });
  wrap.style.cursor = "pointer";
```

- [ ] **Step 3: Verify (after Task 6) — deferred.** Commit with Task 6.

---

## Task 6: Detail view (header + full pendulum + tabs) and unified `showView`

**Files:** Modify `public/index.html` (markup + JS), `public/shared/i18n.js` (keys).

- [ ] **Step 1: Add i18n keys**

In `public/shared/i18n.js`, add to BOTH `zh` and `en` dictionaries (place near the board keys). zh:
```js
    d_back: "← 返回",
    d_tab_fundamentals: "基本面",
    d_tab_financials: "财报",
    d_tab_valuation: "估值研究",
    d_soon: "即将上线",
    d_market_cap: "市值",
    d_pe_ttm: "市盈率 PE(TTM)",
    d_pb: "市净率 PB",
    d_div_yield: "股息率",
    d_eps_ttm: "每股收益 EPS(TTM)",
    d_bps: "每股净资产 BPS",
    d_exchange: "交易所",
    d_currency: "货币",
    d_no_fundamentals: "暂无基本面数据",
    d_fair_range: "合理价值区间",
    d_mos: "安全边际",
    d_ext: "极度高估",
    d_price: "现价",
    d_verdict: "判定",
    d_thresholds: "五区间阈值",
    d_method: "什么是合理价值？常见估值方法 →",
```
en:
```js
    d_back: "← Back",
    d_tab_fundamentals: "Fundamentals",
    d_tab_financials: "Financials",
    d_tab_valuation: "Valuation",
    d_soon: "Coming soon",
    d_market_cap: "Market cap",
    d_pe_ttm: "P/E (TTM)",
    d_pb: "P/B",
    d_div_yield: "Dividend yield",
    d_eps_ttm: "EPS (TTM)",
    d_bps: "Book value/share",
    d_exchange: "Exchange",
    d_currency: "Currency",
    d_no_fundamentals: "No fundamentals available",
    d_fair_range: "Fair-value range",
    d_mos: "Margin of safety",
    d_ext: "Extreme overvalue",
    d_price: "Price",
    d_verdict: "Verdict",
    d_thresholds: "Zone thresholds",
    d_method: "What is fair value? Methods →",
```

- [ ] **Step 2: Add the detail view container to the markup**

In `public/index.html`, right after `<div class="view-settings hidden" id="viewSettings"> ... </div>` (its closing tag), add:
```html
  <div class="view-detail hidden" id="viewDetail"></div>
```

- [ ] **Step 3: Add detail CSS**

In `public/index.html` `<style>` (near `.view-settings`):
```css
  .view-detail{max-width:900px;margin:0 auto;padding-top:4px}
  .vd-back{display:inline-flex;align-items:center;font-size:13.5px;color:var(--ink-soft);text-decoration:none;margin-bottom:18px}
  .vd-back:hover{color:var(--ink)}
  .vd-top{display:flex;gap:24px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--divider);padding-bottom:24px;margin-bottom:20px}
  .vd-id .vd-name{font-family:var(--serif);font-style:italic;font-weight:700;font-size:26px;letter-spacing:-.01em}
  .vd-id .vd-code{font-family:var(--mono);font-size:13px;color:var(--ink-mute);margin-left:8px}
  .vd-meta{font-size:12px;color:var(--ink-mute);margin:6px 0 12px}
  .vd-price{font-family:var(--mono);font-weight:700;font-size:30px;letter-spacing:-.01em}
  .vd-verdict{font-size:14px;font-weight:500;margin-top:2px}
  .vd-verdict.v-under{color:var(--green)} .vd-verdict.v-over{color:var(--red)} .vd-verdict.v-fair{color:var(--ink-mute)}
  .vd-gauge{flex:none;width:340px}
  .vd-gauge svg{display:block;width:100%;height:auto;overflow:visible}
  .vd-tabs{display:flex;gap:2px;border-bottom:1px solid var(--divider);margin-bottom:18px}
  .vd-tab{height:40px;padding:0 14px;border:0;background:none;cursor:pointer;font-family:var(--font);font-size:13.5px;font-weight:500;color:var(--ink-mute);border-bottom:2px solid transparent;margin-bottom:-1px}
  .vd-tab:hover{color:var(--ink)}
  .vd-tab.on{color:var(--ink);border-bottom-color:var(--ink)}
  .vd-panel{display:none}
  .vd-panel.on{display:block}
  .vd-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:0 24px}
  .vd-row{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--border)}
  .vd-row .k{color:var(--ink-soft);font-size:13.5px}
  .vd-row .v{font-family:var(--mono);font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
  .vd-empty{color:var(--ink-mute);font-size:13.5px;padding:24px 0}
  .vd-method{display:inline-block;margin-top:16px;font-size:13px;color:var(--ink-soft);text-decoration:underline;text-underline-offset:2px}
  @media (max-width:680px){ .vd-top{flex-direction:column;align-items:flex-start} .vd-gauge{width:100%;max-width:340px} .vd-grid{grid-template-columns:1fr} }
```

- [ ] **Step 4: Add `showView` / `showList` / `showDetail` + `renderDetail` + fundamentals helpers**

In `public/index.html` JS, near the existing `setView`, add (and route the existing topnav/gear through `showView`):
```js
const viewDetail = document.getElementById("viewDetail");
const pageHeadEl2 = document.querySelector(".page-head");
const sectionDividerEl = document.getElementById("boardDivider");
let detailGauge = null;

function showView(v) { // v: "list" | "settings" | "detail"
  const isList = v === "list", isSettings = v === "settings", isDetail = v === "detail";
  pageHeadEl2.classList.toggle("hidden", !isList);
  sectionDividerEl.classList.toggle("hidden", !isList);
  layoutEl.classList.toggle("hidden", !isList);
  viewSettings.classList.toggle("hidden", !isSettings);
  viewDetail.classList.toggle("hidden", !isDetail);
  document.querySelectorAll(".nav-tab").forEach((x) => x.classList.toggle("on", x.dataset.view === "board" && (isList || isDetail)));
  btnSettings.classList.toggle("on", isSettings);
}
function showList() { showView("list"); }
function showSettings() { showView("settings"); }
function showDetail(item) {
  renderDetail(item);
  showView("detail");
  window.scrollTo(0, 0);
}

// 大数字格式：按货币用 亿/万亿（CNY/HKD）或 K/M/B/T（USD 等）
function fmtBig(n, currency) {
  if (!(n > 0)) return "—";
  const cjk = currency === "CNY" || currency === "HKD" || currency === "CNH";
  if (cjk) { const yi = n / 1e8; return yi >= 10000 ? (yi / 1e4).toFixed(2) + " 万亿" : yi.toFixed(2) + " 亿"; }
  const u = [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]];
  for (const [s, base] of u) if (n >= base) return (n / base).toFixed(2) + s;
  return String(Math.round(n));
}
function fundamentalsRows(item) {
  const s = item.statics || {}, price = item.cfg.price || 0, rows = [];
  const epsTtm = parseFloat(s.epsTtm), bps = parseFloat(s.bps), div = parseFloat(s.dividendYield), shares = Number(s.totalShares) || 0;
  if (shares > 0 && price > 0) rows.push([t("d_market_cap"), fmtBig(shares * price, s.currency)]);
  if (price > 0 && epsTtm > 0) rows.push([t("d_pe_ttm"), (price / epsTtm).toFixed(2)]);
  if (price > 0 && bps > 0) rows.push([t("d_pb"), (price / bps).toFixed(2)]);
  if (div > 0) rows.push([t("d_div_yield"), div.toFixed(2) + "%"]);
  if (epsTtm > 0) rows.push([t("d_eps_ttm"), s.epsTtm]);
  if (bps > 0) rows.push([t("d_bps"), s.bps]);
  if (s.exchange) rows.push([t("d_exchange"), s.exchange]);
  if (s.currency) rows.push([t("d_currency"), s.currency]);
  return rows;
}
function valuationRows(item) {
  const c = item.cfg, a = computeAnchors(c), rows = [];
  rows.push([t("d_fair_range"), (c.fairLow || "—") + " – " + (c.fairHigh || "—")]);
  rows.push([t("d_mos"), (c.mos || 0) + "%"]);
  rows.push([t("d_ext"), (c.ext || 0) + "%"]);
  rows.push([t("d_price"), c.price > 0 ? VMSGS.px(c.price) : "—"]);
  const v = verdictOf(c, VMSGS);
  rows.push([t("d_verdict"), v.text]);
  rows.push([t("d_thresholds"), [a[1], a[2], a[3], a[4]].map((x) => isFinite(x) ? Math.round(x) : "—").join(" · ")]);
  return rows;
}
function rowsHtml(rows) {
  return '<div class="vd-grid">' + rows.map(([k, vv]) => `<div class="vd-row"><span class="k"></span><span class="v"></span></div>`).join("") + "</div>";
}
function fillRows(container, rows) {
  const grid = document.createElement("div"); grid.className = "vd-grid";
  rows.forEach(([k, vv]) => { const r = document.createElement("div"); r.className = "vd-row";
    const ke = document.createElement("span"); ke.className = "k"; ke.textContent = k;
    const ve = document.createElement("span"); ve.className = "v"; ve.textContent = vv;
    r.append(ke, ve); grid.appendChild(r); });
  container.appendChild(grid);
}
function renderDetail(item) {
  const c = item.cfg;
  viewDetail.innerHTML = "";
  if (detailGauge) { detailGauge.destroy && detailGauge.destroy(); detailGauge = null; }

  const back = document.createElement("a"); back.className = "vd-back"; back.href = "/b/" + boardSlug; back.textContent = t("d_back");
  back.addEventListener("click", (e) => { e.preventDefault(); history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug)); showList(); });

  const top = document.createElement("div"); top.className = "vd-top";
  const idBlock = document.createElement("div");
  const s = item.statics || {};
  const meta = [s.exchange, s.currency].filter(Boolean).join(" · ");
  const v = verdictOf(c, VMSGS);
  idBlock.innerHTML = `<div class="vd-id"><span class="vd-name"></span><span class="vd-code"></span></div>
    <div class="vd-meta"></div><div class="vd-price"></div><div class="vd-verdict ${v.cls}"></div>`;
  idBlock.querySelector(".vd-name").textContent = displayName(item);
  idBlock.querySelector(".vd-code").textContent = (c.ticker || "").toUpperCase();
  idBlock.querySelector(".vd-meta").textContent = meta;
  idBlock.querySelector(".vd-price").textContent = c.price > 0 ? VMSGS.px(c.price) : "—";
  idBlock.querySelector(".vd-verdict").textContent = v.text;
  const gwrap = document.createElement("div"); gwrap.className = "vd-gauge";
  top.append(idBlock, gwrap);

  // tabs
  const tabsNav = document.createElement("div"); tabsNav.className = "vd-tabs";
  const panels = document.createElement("div");
  const defs = [
    { key: "fundamentals", label: t("d_tab_fundamentals") },
    { key: "financials", label: t("d_tab_financials") },
    { key: "valuation", label: t("d_tab_valuation") },
  ];
  const tabEls = [], panelEls = [];
  defs.forEach((d, i) => {
    const b = document.createElement("button"); b.className = "vd-tab" + (i === 0 ? " on" : ""); b.textContent = d.label;
    const p = document.createElement("div"); p.className = "vd-panel" + (i === 0 ? " on" : "");
    b.addEventListener("click", () => { tabEls.forEach((x) => x.classList.remove("on")); panelEls.forEach((x) => x.classList.remove("on")); b.classList.add("on"); p.classList.add("on"); });
    tabsNav.appendChild(b); panels.appendChild(p); tabEls.push(b); panelEls.push(p);
  });
  // panel 0: fundamentals
  const fr = fundamentalsRows(item);
  if (fr.length) fillRows(panelEls[0], fr);
  else { const e = document.createElement("div"); e.className = "vd-empty"; e.textContent = t("d_no_fundamentals"); panelEls[0].appendChild(e); }
  // panel 1: financials placeholder
  { const e = document.createElement("div"); e.className = "vd-empty"; e.textContent = t("d_soon"); panelEls[1].appendChild(e); }
  // panel 2: valuation
  fillRows(panelEls[2], valuationRows(item));
  const method = document.createElement("a"); method.className = "vd-method"; method.href = "/valuation"; method.textContent = t("d_method");
  panelEls[2].appendChild(method);

  viewDetail.append(back, top, tabsNav, panels);
  // full pendulum (non-compact)
  detailGauge = new Gauge(gwrap);
  detailGauge.set(c, false);
  if (c.price > 0) detailGauge.swingIn();
}
```
(Note: `rowsHtml` above is unused scaffolding — delete it; use `fillRows`. Keeping the plan honest: only `fillRows` is used.)

- [ ] **Step 5: Route the topnav/gear/brand through the new view functions**

In `public/index.html`, update existing handlers:
- The nav-tab click handler (the one that calls `setView`): for `data-view="board"` → `history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug)); showList();`. (Macro is disabled — unchanged.)
- The settings gear (`btnSettings.addEventListener("click", () => setView("settings"))`) → `showSettings()`.
- The brand click (`document.getElementById("brand")...`) → `history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug)); showList();`.
- Delete the old `setView` function (replaced by `showView`/`showList`/`showSettings`); ensure no remaining references to `setView` (grep).

- [ ] **Step 6: Browser verify**

1. Reload `/b/demo`. Click a row → URL becomes `/b/demo/AAPL`, detail shows: header (name/code/exchange·currency/price/verdict) + full pendulum on the right (with swing-in), tabs below. 基本面 shows market-cap/PE/PB/etc. (real Longbridge data); 财报 shows "即将上线"; 估值研究 shows fair range/MOS/EXT/price/verdict/thresholds + method link.
2. Browser Back → returns to list. 返回 link → list.
3. Deep link: open `/b/demo/AAPL` directly → loads board then shows that detail.
4. Switch language (EN) → labels + name translate.
5. Settings gear still works; Watchlist tab / brand return to list.
Take screenshots of the detail page (both tabs) to confirm.

- [ ] **Step 7: `npm test` (58) + commit (when asked)**

---

## Self-Review Notes (addressed)

- **Spec coverage:** bar (Task 3-4), detail route (Task 1, 5), detail layout+tabs (Task 6), 基本面 from Longbridge (Task 2 + Task 6 `fundamentalsRows`), 估值研究 (Task 6 `valuationRows`), 财报 placeholder (Task 6), data plumbing (Task 2, Task 4 Step 4). ✓
- **Placeholder scan:** `rowsHtml` flagged as unused — Step 4 note says delete it; only `fillRows` is used. No other placeholders.
- **Type/name consistency:** renderer field stays `item.gauge` (both `Gauge` and `Bar` expose `set`/`destroy`); `item.statics` keys match between `loadNames` (Task 4) and `fundamentalsRows` (Task 6): `currency, totalShares, epsTtm, bps, dividendYield, exchange`. `verdictOf`, `computeAnchors`, `VMSGS`, `displayName`, `boardSlug`, `layoutEl`, `btnSettings`, `viewSettings` are all existing symbols in `index.html`.
- **Verification gate:** Task 2 Step 5 verifies the proto field numbers against the live API before relying on them.
