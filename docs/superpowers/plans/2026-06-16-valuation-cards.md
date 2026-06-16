# Valuation Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 估值研究 tab from a single transient calculator into saveable, editable multi-method valuation cards, one of which can be selected to drive the holding's fair-value range.

**Architecture:** Cards persist as a JSON array column on the existing `items` row (plus a `selected_valuation_id` column); `items.fair_low/fair_high` stay the pendulum's only driver, so the rest of the app is unchanged. The detail page becomes owner-only. The polished calculator form is reused as the card editor (完成/取消); the panel toggles between a card-list view and the editor.

**Tech Stack:** Cloudflare Workers + Hono + D1 (SQLite); vanilla ESM frontend; vitest (`core` + `worker` projects).

Spec: `docs/superpowers/specs/2026-06-16-valuation-cards-design.md`.

---

### Task 1: Schema — add two columns to `items`

**Files:**
- Modify: `schema.sql` (canonical, fresh installs)
- Create: `migrations/2026-06-16-valuation-cards.sql`

- [ ] **Step 1: Add columns to canonical schema**

In `schema.sql`, change the `items` table to include the two new columns (add the two lines before `updated_at`):

```sql
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
  valuations            TEXT NOT NULL DEFAULT '[]',
  selected_valuation_id TEXT,
  updated_at  TEXT    NOT NULL
);
```

- [ ] **Step 2: Write the migration file**

Create `migrations/2026-06-16-valuation-cards.sql`:

```sql
-- 估值卡片：每张卡存进 items 行的 JSON 列；selected_valuation_id 指向被选作合理区间的卡。
ALTER TABLE items ADD COLUMN valuations TEXT NOT NULL DEFAULT '[]';
ALTER TABLE items ADD COLUMN selected_valuation_id TEXT;
```

- [ ] **Step 3: Apply migration to the local D1**

Run: `npx wrangler d1 execute DB --local --file=migrations/2026-06-16-valuation-cards.sql`
Expected: `Executed 2 commands` (or success with no error). If a "duplicate column name" error appears, the column already exists — safe to ignore.

- [ ] **Step 4: Commit**

```bash
git add schema.sql migrations/2026-06-16-valuation-cards.sql
git commit -m "feat(db): add valuations + selected_valuation_id columns to items"
```

> **Deploy note (not a step):** before `npm run deploy`, the same migration must run on remote: `npx wrangler d1 execute DB --remote --file=migrations/2026-06-16-valuation-cards.sql`.

---

### Task 2: Backend — `validateItem` + `rowToItem` for cards

**Files:**
- Modify: `src/items.js`
- Test: `test/items.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/items.test.js` (inside the file, after the existing `rowToItem` describe block):

```js
describe("validateItem with valuations", () => {
  const base = { ticker: "AAPL", name: "苹果", symbol: "usAAPL", fairLow: 215, fairHigh: 265, mos: 20, ext: 25 };
  const card = { id: "v1", method: "pe", inputs: { revenue: 4e11, growth: { c: 8, o: 15 } }, low: 211.29, high: 460.13, updatedAt: "2026-06-16T00:00:00Z" };

  it("accepts valid valuations + selectedValuationId", () => {
    const r = validateItem({ ...base, valuations: [card], selectedValuationId: "v1" });
    expect(r.ok).toBe(true);
    expect(r.value.valuations).toHaveLength(1);
    expect(r.value.selectedValuationId).toBe("v1");
  });
  it("defaults valuations to [] when omitted", () => {
    const r = validateItem(base);
    expect(r.ok).toBe(true);
    expect(r.value.valuations).toEqual([]);
    expect(r.value.selectedValuationId).toBe(null);
  });
  it("rejects an unknown method", () => {
    expect(validateItem({ ...base, valuations: [{ ...card, method: "wat" }] }).ok).toBe(false);
  });
  it("rejects a card with high <= low", () => {
    expect(validateItem({ ...base, valuations: [{ ...card, high: 100 }] }).ok).toBe(false);
  });
  it("rejects selectedValuationId that matches no card", () => {
    expect(validateItem({ ...base, valuations: [card], selectedValuationId: "nope" }).ok).toBe(false);
  });
  it("rejects valuations that is not an array", () => {
    expect(validateItem({ ...base, valuations: { id: "v1" } }).ok).toBe(false);
  });
});

describe("rowToItem with valuations", () => {
  const row = { id: 1, ticker: "AAPL", name: "苹果", symbol: "usAAPL", fair_low: 215, fair_high: 265, mos: 20, ext: 25, sort_order: 0, updated_at: "x" };
  it("parses valuations JSON and selected id", () => {
    const out = rowToItem({ ...row, valuations: '[{"id":"v1","method":"pe","inputs":{},"low":1,"high":2,"updatedAt":"x"}]', selected_valuation_id: "v1" });
    expect(out.valuations).toHaveLength(1);
    expect(out.valuations[0].id).toBe("v1");
    expect(out.selectedValuationId).toBe("v1");
  });
  it("falls back to [] on missing/bad JSON", () => {
    expect(rowToItem(row).valuations).toEqual([]);
    expect(rowToItem({ ...row, valuations: "not json" }).valuations).toEqual([]);
    expect(rowToItem(row).selectedValuationId).toBe(null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project worker test/items.test.js`
Expected: FAIL — new assertions fail (`r.value.valuations` is undefined, etc.).

- [ ] **Step 3: Implement in `src/items.js`**

Replace the entire contents of `src/items.js` with:

```js
// 估值方法白名单（与 public/shared/valuation/* 的 model.key 一致）
const METHODS = new Set(["fcff", "fcfe", "ddm", "pe", "peg", "pb", "ps", "evebitda"]);

// 校验估值卡片数组。返回 { ok, value } 或 { ok:false }。
function validateValuations(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const out = [];
  for (const card of raw) {
    if (!card || typeof card !== "object") return { ok: false };
    if (typeof card.id !== "string" || !card.id) return { ok: false };
    if (!METHODS.has(card.method)) return { ok: false };
    if (!card.inputs || typeof card.inputs !== "object") return { ok: false };
    const low = Number(card.low), high = Number(card.high);
    if (!(low > 0) || !(high > low)) return { ok: false };
    out.push({ id: card.id, method: card.method, inputs: card.inputs, low, high,
      updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : "" });
  }
  return { ok: true, value: out };
}

// 校验后台提交的配置；ok=false 时 errors 描述原因。
export function validateItem(b) {
  const errors = [];
  const fairLow = Number(b.fairLow), fairHigh = Number(b.fairHigh);
  const mos = Number(b.mos), ext = Number(b.ext);
  if (!b.symbol || typeof b.symbol !== "string") errors.push("symbol required");
  if (!b.ticker || typeof b.ticker !== "string") errors.push("ticker required");
  if (!(fairLow > 0)) errors.push("fairLow must be > 0");
  else if (!(fairHigh > fairLow)) errors.push("fairHigh must be > fairLow");
  if (!(mos > 0 && mos < 100)) errors.push("mos must be in (0,100)");
  if (!(ext > 0)) errors.push("ext must be > 0");

  const vals = validateValuations(b.valuations);
  if (!vals.ok) errors.push("valuations invalid");
  let selectedValuationId = (typeof b.selectedValuationId === "string" && b.selectedValuationId) ? b.selectedValuationId : null;
  if (vals.ok && selectedValuationId && !vals.value.some((c) => c.id === selectedValuationId)) {
    errors.push("selectedValuationId not found");
  }

  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { ticker: b.ticker, name: b.name || "", symbol: b.symbol,
        fairLow, fairHigh, mos, ext, sortOrder: Number(b.sortOrder) || 0,
        valuations: vals.value, selectedValuationId } };
}

export function rowToItem(r) {
  let valuations = [];
  try { const p = r.valuations ? JSON.parse(r.valuations) : []; if (Array.isArray(p)) valuations = p; } catch { /* 坏 JSON 兜底空 */ }
  return {
    id: r.id, ticker: r.ticker, name: r.name, symbol: r.symbol,
    fairLow: r.fair_low, fairHigh: r.fair_high, mos: r.mos, ext: r.ext, sortOrder: r.sort_order,
    valuations, selectedValuationId: r.selected_valuation_id ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project worker test/items.test.js`
Expected: PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/items.js test/items.test.js
git commit -m "feat(items): validate + map valuation cards and selected id"
```

---

### Task 3: Backend — persist columns in POST/PUT

**Files:**
- Modify: `src/index.js:146-164` (the `POST /api/my/items` and `PUT /api/my/items/:id` handlers)

- [ ] **Step 1: Update the INSERT (POST handler)**

Replace the `POST /api/my/items` handler body's prepare/bind with:

```js
  const { meta } = await c.env.DB.prepare(
    "INSERT INTO items (user_id,ticker,name,symbol,fair_low,fair_high,mos,ext,sort_order,valuations,selected_valuation_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(c.get("uid"), it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder,
    JSON.stringify(it.valuations), it.selectedValuationId, new Date().toISOString()).run();
```

- [ ] **Step 2: Update the UPDATE (PUT handler)**

Replace the `PUT /api/my/items/:id` handler body's prepare/bind with:

```js
  const { meta } = await c.env.DB.prepare(
    "UPDATE items SET ticker=?,name=?,symbol=?,fair_low=?,fair_high=?,mos=?,ext=?,sort_order=?,valuations=?,selected_valuation_id=?,updated_at=? WHERE id=? AND user_id=?"
  ).bind(it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder,
    JSON.stringify(it.valuations), it.selectedValuationId, new Date().toISOString(),
    Number(c.req.param("id")), c.get("uid")).run();
```

- [ ] **Step 3: Verify the worker route tests still pass**

Run: `npx vitest run --project worker`
Expected: PASS (no regressions; routes.test.js / items.test.js green).

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat(api): persist valuations + selected_valuation_id on item save"
```

---

### Task 4: Frontend — carry cards through cfg and saveItem

**Files:**
- Modify: `public/index.html` (the add-default in the board render ~line 670; `saveItem` payload ~line 701; import block ~line 391)

- [ ] **Step 1: Import MODELS for card rendering**

After the existing `import { mountValuationCalc } from "/shared/valuation-ui.js";` line, add:

```js
import { MODELS } from "/shared/valuation/index.js";
```

- [ ] **Step 2: Seed cards on new holdings**

In the `addCardEl` click handler, extend the `addChart({...})` default config to include the two new fields:

```js
      const item = addChart({ ticker: "", name: "", symbol: null, price: 0, fairLow: "", fairHigh: "", mos: 50, ext: 40, sortOrder: items.length, valuations: [], selectedValuationId: null });
```

- [ ] **Step 3: Include cards in the save payload**

In `saveItem`, extend `payload` to send the cards:

```js
  const payload = {
    ticker: item.cfg.ticker, name: item.cfg.name, symbol: item.cfg.symbol,
    fairLow: item.cfg.fairLow, fairHigh: item.cfg.fairHigh, mos: item.cfg.mos, ext: item.cfg.ext,
    sortOrder: item.cfg.sortOrder || 0,
    valuations: item.cfg.valuations || [], selectedValuationId: item.cfg.selectedValuationId || null,
  };
```

- [ ] **Step 4: Verify in browser (no test harness for frontend)**

Run: `npm run dev` (if not already running). In a browser console on `http://localhost:8787/b/demo`, confirm a loaded item exposes the fields:
Manual check — the board still loads; `/api/config?slug=demo` response items now include `valuations: []` and `selectedValuationId: null`. No visual change yet.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): carry valuation cards through item cfg + save payload"
```

---

### Task 5: Frontend — refactor `valuation-ui.js` into a card editor

**Files:**
- Modify: `public/shared/valuation-ui.js` (full rewrite of the public signature + footer; form rendering keeps current worksheet)

- [ ] **Step 1: Rewrite the module**

Replace the entire contents of `public/shared/valuation-ui.js` with:

```js
/**
 * valuation-ui.js — 估值卡片编辑器（方法选择 + 前提/情景假设工作表 + 实时低~高 + 区间条预览）。
 * 依赖：MODELS/runModel（valuation/index.js）、Bar（bar.js）。
 * 导出：mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, onDone, onCancel })
 *   onDone({ method, inputs, low, high })  —— 用户点「完成」、且低~高有效时触发
 *   onCancel()                              —— 用户点「取消」
 *   initialMethod / initialInputs           —— 编辑既有卡片时回填（否则用 prefill/default）
 */
import { MODELS, runModel } from "/shared/valuation/index.js";
import { Bar } from "/shared/bar.js";

const TX = {
  zh: { intrinsic: "内在价值", relative: "相对估值", facts: "前提", assume: "情景假设",
        conservative: "保守", optimistic: "乐观", fair: "合理价值", done: "完成", cancel: "取消", dash: "—" },
  en: { intrinsic: "Intrinsic", relative: "Relative", facts: "Inputs", assume: "Assumptions",
        conservative: "Conservative", optimistic: "Optimistic", fair: "Fair value", done: "Done", cancel: "Cancel", dash: "—" },
};

function el(tag, cls, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) Object.assign(node, attrs);
  return node;
}
function fmt(v, dash) { return (v !== null && isFinite(v)) ? Number(v).toFixed(2) : dash; }
function initialFor(field, ctx) {
  let v = "";
  if (typeof field.prefill === "function") { try { v = field.prefill(ctx); } catch { v = ""; } }
  const blank = v === "" || v === undefined || v === null || (typeof v === "number" && !isFinite(v));
  if (blank && field.default !== undefined) v = field.default;
  return v;
}

export function mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, onDone, onCancel }) {
  const L = TX[lang] || TX.zh;
  const tx = (k) => L[k];

  let activeIdx = Math.max(0, MODELS.findIndex((m) => m.key === initialMethod));
  let lastLow = null, lastHigh = null;

  mount.innerHTML = "";
  const root = el("div", "vc");
  mount.appendChild(root);

  // 方法选择：内在/相对 两组 chip
  const methodsBar = el("div", "vc-methods");
  root.appendChild(methodsBar);
  const methodBtns = [];
  [{ key: "intrinsic", models: MODELS.filter((m) => m.group === "intrinsic") },
   { key: "relative", models: MODELS.filter((m) => m.group === "relative") }].forEach((g) => {
    if (!g.models.length) return;
    const gwrap = el("div", "vc-mgroup");
    const glabel = el("span", "vc-mglabel"); glabel.textContent = tx(g.key); gwrap.appendChild(glabel);
    g.models.forEach((model) => {
      const idx = MODELS.indexOf(model);
      const btn = el("button", "vc-method"); btn.type = "button";
      btn.textContent = (model.label && model.label[lang]) || model.key;
      btn.addEventListener("click", () => { if (activeIdx === idx) return; activeIdx = idx; refreshMethodBtns(); renderForm(); });
      methodBtns[idx] = btn; gwrap.appendChild(btn);
    });
    methodsBar.appendChild(gwrap);
  });

  const formWrap = el("div", "vc-form");
  root.appendChild(formWrap);

  // 结果 hero
  const result = el("div", "vc-result");
  root.appendChild(result);
  const nums = el("div", "vc-rnums");
  const outLabel = el("span", "vc-out-label"); outLabel.textContent = tx("fair");
  const outLow = el("span", "vc-rlow");
  const outDash = el("span", "vc-rdash"); outDash.textContent = "~";
  const outHigh = el("span", "vc-rhigh");
  nums.append(outLabel, outLow, outDash, outHigh);
  result.appendChild(nums);
  const barMount = el("div", "vc-bar-mount");
  result.appendChild(barMount);
  let bar = null;

  // 完成 / 取消
  const actions = el("div", "vc-actions");
  const doneBtn = el("button", "vc-done"); doneBtn.type = "button"; doneBtn.textContent = tx("done"); doneBtn.disabled = true;
  doneBtn.addEventListener("click", () => {
    if (lastLow === null || lastHigh === null || !isFinite(lastLow) || !isFinite(lastHigh)) return;
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh) });
  });
  const cancelBtn = el("button", "vc-cancel"); cancelBtn.type = "button"; cancelBtn.textContent = tx("cancel");
  cancelBtn.addEventListener("click", () => onCancel && onCancel());
  actions.append(doneBtn, cancelBtn);
  result.appendChild(actions);

  let lastForm = {};

  function refreshMethodBtns() { methodBtns.forEach((btn, i) => { if (btn) btn.classList.toggle("on", i === activeIdx); }); }

  function compute(formData) {
    lastForm = formData;
    const model = MODELS[activeIdx];
    let r = { low: null, high: null };
    try { r = runModel(model, formData, ctx); } catch { /* 输入不完整 */ }
    lastLow = r.low; lastHigh = r.high;
    const dash = tx("dash");
    const valid = lastLow !== null && lastHigh !== null && isFinite(lastLow) && isFinite(lastHigh);
    outLow.textContent = fmt(lastLow, dash); outHigh.textContent = fmt(lastHigh, dash);
    outDash.style.opacity = valid ? "1" : ".4";
    if (valid && ctx.price > 0) {
      if (!bar) bar = new Bar(barMount);
      barMount.style.display = "";
      bar.set({ price: ctx.price, fairLow: Math.min(lastLow, lastHigh), fairHigh: Math.max(lastLow, lastHigh), mos: ctx.mos || 0, ext: ctx.ext || 0 }, true);
    } else { barMount.style.display = "none"; }
    doneBtn.disabled = !valid;
  }

  function fieldLabel(field) {
    const lab = el("div", "vc-label");
    lab.textContent = (field.label && field.label[lang]) || field.k;
    if (field.unit === "%") { const u = el("span", "vc-unit"); u.textContent = "%"; lab.appendChild(u); }
    return lab;
  }

  // 单列初值：编辑态优先用 initialInputs，否则 prefill/default
  function singleInit(field) {
    if (initialInputs && Object.prototype.hasOwnProperty.call(initialInputs, field.k)) {
      const v = initialInputs[field.k];
      if (typeof v === "number") return v;
    }
    return initialFor(field, ctx);
  }
  function dualInit(field) {
    if (initialInputs && initialInputs[field.k] && typeof initialInputs[field.k] === "object") {
      return { c: initialInputs[field.k].c, o: initialInputs[field.k].o };
    }
    const d = field.default ?? "";
    return { c: d, o: d };
  }

  function renderForm() {
    formWrap.innerHTML = "";
    const model = MODELS[activeIdx];
    const fields = model.fields || [];
    const readers = [];
    const singles = fields.filter((f) => f.col !== "dual");
    const duals = fields.filter((f) => f.col === "dual");
    const sheet = el("div", "vc-sheet");

    if (singles.length) {
      const h = el("div", "vc-shead"); h.textContent = tx("facts"); sheet.appendChild(h);
      singles.forEach((field) => {
        sheet.appendChild(fieldLabel(field));
        const input = makeInput(singleInit(field));
        if (field.hint && field.hint[lang]) input.placeholder = field.hint[lang];
        readers.push({ field, getVal: () => input.value !== "" ? Number(input.value) : NaN });
        input.addEventListener("input", () => compute(buildForm(readers)));
        sheet.appendChild(input);
        sheet.appendChild(el("div"));
      });
    }
    if (duals.length) {
      const h = el("div", "vc-shead"); h.textContent = tx("assume"); sheet.appendChild(h);
      sheet.appendChild(el("div"));
      const hc = el("div", "vc-chead"); hc.textContent = tx("conservative"); sheet.appendChild(hc);
      const ho = el("div", "vc-chead"); ho.textContent = tx("optimistic"); sheet.appendChild(ho);
      duals.forEach((field) => {
        sheet.appendChild(fieldLabel(field));
        const init = dualInit(field);
        const inC = makeInput(init.c), inO = makeInput(init.o);
        readers.push({ field, getVal: () => ({ c: inC.value !== "" ? Number(inC.value) : NaN, o: inO.value !== "" ? Number(inO.value) : NaN }) });
        inC.addEventListener("input", () => compute(buildForm(readers)));
        inO.addEventListener("input", () => compute(buildForm(readers)));
        sheet.append(inC, inO);
      });
    }
    formWrap.appendChild(sheet);
    compute(buildForm(readers));
  }

  function buildForm(readers) { const form = {}; readers.forEach(({ field, getVal }) => { form[field.k] = getVal(); }); return form; }
  function makeInput(initVal) {
    const inp = el("input", "vc-input", { type: "number", inputMode: "decimal", step: "any" });
    if (initVal !== "" && initVal !== undefined && initVal !== null) inp.value = String(initVal);
    return inp;
  }

  refreshMethodBtns();
  renderForm();
}
```

- [ ] **Step 2: Add CSS for the 完成/取消 row**

In `public/index.html`, replace the existing `.vc-apply` rules (the three lines `.vc-apply{...}`, `.vc-apply:hover{...}`, `.vc-apply:disabled{...}`) with:

```css
  .vc-actions{margin-top:18px;display:flex;gap:10px}
  .vc-done{height:36px;padding:0 16px;border:1px solid var(--ink);border-radius:8px;background:var(--ink);color:var(--bg);cursor:pointer;font-family:var(--font);font-size:13px;font-weight:500;transition:opacity .12s}
  .vc-done:hover{opacity:.88}
  .vc-done:disabled{opacity:.32;cursor:not-allowed}
  .vc-cancel{height:36px;padding:0 14px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--ink-soft);cursor:pointer;font-family:var(--font);font-size:13px;font-weight:500}
  .vc-cancel:hover{color:var(--ink);border-color:var(--node)}
```

- [ ] **Step 3: Verify the editor renders (temporary harness)**

Run `npm run dev`. The 估值研究 tab won't be wired to the new editor until Task 6; this step only confirms no syntax errors. In the browser console on `/b/demo/AAPL`:
```js
const m = await import("/shared/valuation-ui.js"); typeof m.mountValuationCalc
```
Expected: `"function"` (module parses and exports).

- [ ] **Step 4: Commit**

```bash
git add public/shared/valuation-ui.js public/index.html
git commit -m "feat(ui): valuation-ui as card editor (done/cancel + initialInputs)"
```

---

### Task 6: Frontend — card-list panel, editor toggle, select/link logic

**Files:**
- Modify: `public/index.html` — replace the 估值研究 panel block in `renderDetail` (~lines 1052-1058, the `summaryBox`/`method`/`calcMount`/`mountValuationCalc` block) and add a `renderValuationPanel` helper + CSS.

- [ ] **Step 1: Replace the panel block in `renderDetail`**

In `renderDetail`, find the block that currently builds `summaryBox`, `method`, `calcMount`, and calls `mountValuationCalc(...)` for `panelEls[2]`. Replace that entire block with:

```js
  renderValuationPanel(item, panelEls[2], idBlock);
```

(Keep the lines above it that fill `panelEls[0]` fundamentals and `panelEls[1]` soon. Keep the `vctx`-building lines? No — `vctx` moves into `renderValuationPanel`. Delete the old `vctx` const and the old `mountValuationCalc` call here.)

- [ ] **Step 2: Add the `renderValuationPanel` helper**

Immediately after the `renderDetail` function (before `currentDetailCode`), add:

```js
// 估值研究面板：摘要 + 估值卡片列表 ⇄ 卡片编辑器。idBlock 用于联动刷新顶部判定。
function newValuationId() { return "v" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

function valuationCtx(item) {
  const c = item.cfg, s = item.statics || {};
  return { price: c.price || 0, epsTtm: parseFloat(s.epsTtm) || NaN, bps: parseFloat(s.bps) || NaN,
    shares: Number(s.totalShares) || 0, dividendYield: parseFloat(s.dividendYield) || NaN, mos: c.mos || 0, ext: c.ext || 0 };
}

// 把某卡设为合理区间：写 fair 区间 + 选中 id，刷新钟摆/顶部判定/列表行，并保存。
function selectValuation(item, card, idBlock) {
  const c = item.cfg;
  c.fairLow = Math.round(Math.min(card.low, card.high) * 100) / 100;
  c.fairHigh = Math.round(Math.max(card.low, card.high) * 100) / 100;
  c.selectedValuationId = card.id;
  if (detailGauge) detailGauge.set(c, true);
  if (idBlock) { const vv = verdictOf(c, VMSGS); const vEl = idBlock.querySelector(".vd-verdict"); vEl.textContent = vv.text; vEl.className = "vd-verdict " + vv.cls; }
  if (item.gauge) item.gauge.set(c, true);
  renderVerdict(item); renderItemHead(item);
  saveItem(item);
}

// 关键假设摘要（dual 字段：标签 保守–乐观）
function assumeSummary(model, inputs) {
  return (model.fields || []).filter((f) => f.col === "dual").map((f) => {
    const v = inputs[f.k]; if (!v || typeof v !== "object") return null;
    const lab = (f.label && f.label[LANG]) || f.k;
    const unit = f.unit === "%" ? "%" : "";
    return `${lab} ${v.c}–${v.o}${unit}`;
  }).filter(Boolean).join(" · ");
}

function renderValuationPanel(item, panel, idBlock) {
  const c = item.cfg;
  panel.innerHTML = "";

  function showList() {
    panel.innerHTML = "";
    const summary = document.createElement("div");
    fillRows(summary, valuationRows(item));
    panel.appendChild(summary);

    const list = document.createElement("div"); list.className = "vcards";
    (c.valuations || []).forEach((card) => list.appendChild(cardEl(card)));
    panel.appendChild(list);

    const add = document.createElement("button"); add.className = "vcard-add"; add.type = "button";
    add.textContent = LANG === "zh" ? "＋ 添加估值" : "＋ Add valuation";
    add.addEventListener("click", () => showEditor(null));
    panel.appendChild(add);

    const method = document.createElement("a"); method.className = "vd-method"; method.href = "/valuation"; method.textContent = t("d_method");
    panel.appendChild(method);
  }

  function cardEl(card) {
    const model = MODELS.find((m) => m.key === card.method);
    const wrap = document.createElement("div");
    wrap.className = "vcard" + (c.selectedValuationId === card.id ? " on" : "");
    const head = document.createElement("div"); head.className = "vcard-head";
    const name = document.createElement("span"); name.className = "vcard-method"; name.textContent = model ? (model.label[LANG] || model.key) : card.method;
    const range = document.createElement("span"); range.className = "vcard-range"; range.textContent = `${card.low.toFixed(2)} ~ ${card.high.toFixed(2)}`;
    head.append(name, range);
    const sum = document.createElement("div"); sum.className = "vcard-assume"; sum.textContent = model ? assumeSummary(model, card.inputs) : "";
    const vinfo = verdictOf({ ...c, fairLow: card.low, fairHigh: card.high }, VMSGS);
    const verd = document.createElement("div"); verd.className = "vcard-verdict " + vinfo.cls; verd.textContent = c.price > 0 ? vinfo.text : "";
    const actions = document.createElement("div"); actions.className = "vcard-actions";
    const sel = document.createElement("button"); sel.type = "button"; sel.className = "vcard-sel" + (c.selectedValuationId === card.id ? " on" : "");
    sel.textContent = c.selectedValuationId === card.id ? (LANG === "zh" ? "● 合理区间" : "● Fair range") : (LANG === "zh" ? "○ 设为合理区间" : "○ Set as fair range");
    sel.addEventListener("click", () => { selectValuation(item, card, idBlock); showList(); });
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "vcard-edit"; edit.textContent = LANG === "zh" ? "编辑" : "Edit";
    edit.addEventListener("click", () => showEditor(card));
    const del = document.createElement("button"); del.type = "button"; del.className = "vcard-del"; del.textContent = LANG === "zh" ? "删除" : "Delete";
    del.addEventListener("click", () => {
      c.valuations = (c.valuations || []).filter((x) => x.id !== card.id);
      if (c.selectedValuationId === card.id) c.selectedValuationId = null;
      saveItem(item); showList();
    });
    actions.append(sel, edit, del);
    wrap.append(head, sum, verd, actions);
    return wrap;
  }

  function showEditor(card) {
    panel.innerHTML = "";
    const host = document.createElement("div"); panel.appendChild(host);
    mountValuationCalc(host, valuationCtx(item), {
      lang: LANG,
      initialMethod: card ? card.method : undefined,
      initialInputs: card ? card.inputs : undefined,
      onCancel: () => showList(),
      onDone: ({ method, inputs, low, high }) => {
        if (!Array.isArray(c.valuations)) c.valuations = [];
        if (card) {
          Object.assign(card, { method, inputs, low, high, updatedAt: new Date().toISOString() });
          if (c.selectedValuationId === card.id) selectValuation(item, card, idBlock);
        } else {
          const fresh = { id: newValuationId(), method, inputs, low, high, updatedAt: new Date().toISOString() };
          c.valuations.push(fresh);
          if (!c.selectedValuationId) selectValuation(item, fresh, idBlock); // 首张/无选中时自动设为合理区间
        }
        saveItem(item); showList();
      },
    });
  }

  showList();
}
```

- [ ] **Step 3: Add CSS for cards**

In `public/index.html`, immediately after the `.vc-cancel:hover{...}` rule added in Task 5, add:

```css
  /* 估值卡片列表 */
  .vcards{margin-top:20px;display:flex;flex-direction:column;gap:10px}
  .vcard{border:1px solid var(--border);border-radius:10px;padding:14px 16px;background:var(--card);transition:border-color .12s,box-shadow .12s}
  .vcard.on{border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)}
  .vcard-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
  .vcard-method{font-size:13.5px;font-weight:600;color:var(--ink)}
  .vcard-range{font-family:var(--mono);font-weight:700;font-size:15px;color:var(--ink);font-variant-numeric:tabular-nums}
  .vcard-assume{margin-top:6px;font-size:12px;color:var(--ink-soft)}
  .vcard-verdict{margin-top:4px;font-size:12px}
  .vcard-verdict.v-under{color:var(--green)} .vcard-verdict.v-over{color:var(--red)} .vcard-verdict.v-fair{color:var(--ink-mute)}
  .vcard-actions{margin-top:12px;display:flex;gap:8px;align-items:center}
  .vcard-sel{height:28px;padding:0 11px;border:1px solid var(--border);border-radius:8px;background:transparent;cursor:pointer;font-family:var(--font);font-size:12px;color:var(--ink-soft)}
  .vcard-sel:hover{color:var(--ink);border-color:var(--node)}
  .vcard-sel.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
  .vcard-edit,.vcard-del{height:28px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;cursor:pointer;font-family:var(--font);font-size:12px;color:var(--ink-mute)}
  .vcard-edit:hover,.vcard-del:hover{color:var(--ink);border-color:var(--border)}
  .vcard-del{margin-left:auto}
  .vcard-add{margin-top:14px;height:34px;padding:0 14px;border:1px dashed var(--node);border-radius:8px;background:transparent;cursor:pointer;font-family:var(--font);font-size:13px;color:var(--ink-soft)}
  .vcard-add:hover{color:var(--ink);border-color:var(--ink)}
```

- [ ] **Step 4: Verify the full flow in the browser**

Run `npm run dev`. On `http://localhost:8787/b/demo/AAPL` → 估值研究 tab (logged in as the demo owner):
1. Click 添加估值 → editor appears. Pick PE, fill revenue + assumptions → 低~高 + bar update → 完成.
2. A card appears, auto-selected (● 合理区间); the top verdict + pendulum reflect the new range.
3. Add a second card (PB) → it is NOT auto-selected; click ○ 设为合理区间 → pendulum switches to it.
4. Edit the selected card, change an assumption, 完成 → range follows (实时跟随).
5. Delete the selected card → selection clears; fair range stays.
Reload the page → cards persist (read from D1).

- [ ] **Step 5: Restore demo data and commit**

Restoring demo AAPL is optional (dev data). Commit:

```bash
git add public/index.html
git commit -m "feat(ui): valuation card list, editor toggle, select-as-fair-range"
```

---

### Task 7: Frontend — visitor gating (detail is owner-only)

**Files:**
- Modify: `public/index.html` — the row click handler (~line 547) and `route()` (~line 1129)

- [ ] **Step 1: Gate the row click**

In `addChart`, replace the row-click setup:

```js
  // 整行可点 → 进详情（仅主人；访客只看列表）
  if (owner) {
    wrap.style.cursor = "pointer";
    wrap.addEventListener("click", (e) => {
      if (e.target.closest(".card-edit")) return;
      const code = (item.cfg.ticker || "").toUpperCase();
      if (!code) return;
      history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug) + "/" + encodeURIComponent(code));
      showDetail(item);
    });
  }
```

- [ ] **Step 2: Gate the route**

In `route()`, require owner to open detail:

```js
function route() {
  const code = currentDetailCode();
  const item = code ? items.find((i) => (i.cfg.ticker || "").toUpperCase() === code) : null;
  if (item && owner) showDetail(item); else showList();
}
```

- [ ] **Step 3: Verify gating in the browser**

- As the demo owner: clicking a row still opens detail; `/b/demo/AAPL` shows detail.
- Open `/b/demo/AAPL` in a private window (not logged in / not the demo owner): it should fall back to the list, and list rows should not be clickable (no pointer cursor, no navigation).

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): detail page is owner-only; visitors see list only"
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS — 88 prior tests + the new `items.test.js` valuation cases (numTotalTests increases; numFailedTests = 0).

- [ ] **Step 2: Manual matrix (browser, logged in as demo owner)**

Confirm each: add card (PE/FCFF), auto-select first card, add second card unselected, set-as-fair-range switches pendulum, edit selected card follows live, delete selected clears selection, cards persist across reload, English (toggle lang) renders card labels/buttons, visitor cannot enter detail.

- [ ] **Step 3: Confirm no stray console errors**

In the browser console on the detail page, confirm no red errors during the add/edit/select/delete flow.

- [ ] **Step 4: Final commit (if any tidy-ups)**

```bash
git add -A
git commit -m "chore: valuation cards verification tidy-ups" || echo "nothing to commit"
```

> **Deploy note:** run the remote migration (Task 1 deploy note) before `npm run deploy`.
