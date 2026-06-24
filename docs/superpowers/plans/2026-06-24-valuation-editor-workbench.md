# Valuation Editor Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the add/edit valuation editor as a screenshot-style white-gray workbench with left-side inputs and right-side summary, chart, and sensitivity panels.

**Architecture:** Keep `mountValuationCalc` as the public API and keep the existing valuation models, input persistence shape, derivation storage, segment storage, and `onDone` payload. Add a small pure helper module for chart/sensitivity data so the generic calculation parts are testable in Node, then use those helpers from `valuation-ui.js` while replacing the editor DOM structure and scoped CSS.

**Tech Stack:** Browser ESM, vanilla DOM, SVG, Vitest core project, existing Hono/Cloudflare Worker app.

---

## Files

- Create: `public/shared/valuation/workbench.js`
  - Pure helper functions for mid-scenario values, chart series normalization, and 5x5 sensitivity matrix generation.
- Create: `test-core/valuation-workbench.test.js`
  - Node tests for the helper functions.
- Modify: `public/shared/valuation-ui.js`
  - Replace the editor shell with workbench DOM, wire helper functions into recompute, render SVG chart and sensitivity table, and move note/save into the input panel.
- Modify: `public/index.html`
  - Replace old valuation editor CSS with scoped workbench styles under `.vc-*` classes and adjust valuation edit page spacing/background.

## Task 1: Add Pure Workbench Helpers

**Files:**
- Create: `public/shared/valuation/workbench.js`
- Create: `test-core/valuation-workbench.test.js`

- [ ] **Step 1: Write tests for midpoint conversion, schedule series, and sensitivity eligibility**

Create `test-core/valuation-workbench.test.js`:

```js
import { describe, expect, it } from "vitest";
import { midpointForm, scheduleSeries, sensitivityMatrix } from "../public/shared/valuation/workbench.js";

const model = {
  key: "demo",
  fields: [
    { k: "base", col: "single" },
    { k: "growth", col: "dual", unit: "%" },
    { k: "multiple", col: "dual" },
  ],
};

describe("valuation workbench helpers", () => {
  it("builds midpoint form from dual scenario fields", () => {
    const form = {
      base: 10,
      growth: { c: 5, o: 15 },
      multiple: { c: 8, o: 12 },
    };

    expect(midpointForm(model, null, form)).toEqual({
      base: 10,
      growth: 10,
      multiple: 10,
    });
  });

  it("normalizes schedule rows into finite chart points", () => {
    const series = scheduleSeries({
      rows: [
        { year: 1, cf: 100, pv: 90 },
        { year: 2, cf: 125, pv: 100 },
        { year: 3, cf: NaN, pv: 95 },
      ],
    });

    expect(series).toEqual([
      { label: "1", value: 100, pv: 90 },
      { label: "2", value: 125, pv: 100 },
    ]);
  });

  it("creates a centered 5x5 sensitivity matrix for two numeric assumptions", () => {
    const matrix = sensitivityMatrix({
      model,
      mode: null,
      form: {
        base: 10,
        growth: { c: 5, o: 15 },
        multiple: { c: 8, o: 12 },
      },
      ctx: {},
      run: (m, f) => ({ low: f.base * f.growth * f.multiple, high: f.base * f.growth * f.multiple }),
      lang: "en",
    });

    expect(matrix).not.toBeNull();
    expect(matrix.x.key).toBe("growth");
    expect(matrix.y.key).toBe("multiple");
    expect(matrix.rows).toHaveLength(5);
    expect(matrix.rows[2].cells[2].center).toBe(true);
    expect(matrix.rows[2].cells[2].value).toBe(1000);
  });

  it("returns null sensitivity when fewer than two numeric assumptions are available", () => {
    const singleFieldModel = {
      fields: [
        { k: "base", col: "single" },
      ],
    };

    expect(sensitivityMatrix({
      model: singleFieldModel,
      mode: null,
      form: { base: 10 },
      ctx: {},
      run: () => ({ low: 10, high: 10 }),
      lang: "en",
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run helper tests and confirm they fail because the module is missing**

Run:

```bash
npm test -- --project core test-core/valuation-workbench.test.js
```

Expected: FAIL with an import/module-not-found error for `valuation/workbench.js`.

- [ ] **Step 3: Implement `workbench.js`**

Create `public/shared/valuation/workbench.js`:

```js
import { modeFields } from "./index.js";

const finite = (n) => typeof n === "number" && Number.isFinite(n);

export function fieldsFor(model, mode) {
  return model ? modeFields(model, mode) : [];
}

export function midpointForm(model, mode, form) {
  const out = {};
  for (const field of fieldsFor(model, mode)) {
    const value = form[field.k];
    if (field.col === "dual") {
      const c = value && typeof value === "object" ? Number(value.c) : NaN;
      const o = value && typeof value === "object" ? Number(value.o) : NaN;
      out[field.k] = finite(c) && finite(o) ? (c + o) / 2 : (finite(c) ? c : o);
    } else {
      out[field.k] = Number(value);
    }
  }
  if (model && model.modes) out._mode = mode || model.defaultMode;
  if (form.assets) out.assets = form.assets;
  if (form.prices) out.prices = form.prices;
  return out;
}

export function scheduleSeries(schedule) {
  if (!schedule || !Array.isArray(schedule.rows)) return [];
  return schedule.rows
    .filter((row) => finite(Number(row.cf)))
    .map((row) => ({
      label: String(row.year),
      value: Number(row.cf),
      pv: finite(Number(row.pv)) ? Number(row.pv) : null,
    }));
}

export function sensitivityMatrix({ model, mode, form, ctx, run, lang }) {
  if (!model || typeof run !== "function") return null;
  const fields = fieldsFor(model, mode);
  const candidates = fields
    .filter((field) => field.col === "dual" && numericDual(form[field.k]))
    .concat(fields.filter((field) => field.col !== "dual" && finite(Number(form[field.k]))));
  if (candidates.length < 2) return null;

  const x = candidates[0];
  const y = candidates[1];
  const xVals = stepsForField(x, form[x.k]);
  const yVals = stepsForField(y, form[y.k]);
  if (!xVals || !yVals) return null;

  const rows = yVals.map((yv, yi) => ({
    label: formatAxisValue(yv, y),
    value: yv,
    cells: xVals.map((xv, xi) => {
      const varied = cloneForm(form);
      setFieldMid(varied, x, xv);
      setFieldMid(varied, y, yv);
      let result = null;
      try { result = run(model, varied, ctx); } catch { result = null; }
      const low = result && finite(Number(result.low)) ? Number(result.low) : null;
      const high = result && finite(Number(result.high)) ? Number(result.high) : null;
      const value = low === null || high === null ? null : (low + high) / 2;
      return { value, center: xi === 2 && yi === 2 };
    }),
  }));

  return {
    x: axisMeta(x, lang),
    y: axisMeta(y, lang),
    columns: xVals.map((v) => ({ label: formatAxisValue(v, x), value: v })),
    rows,
  };
}

function numericDual(value) {
  if (!value || typeof value !== "object") return false;
  return finite(Number(value.c)) || finite(Number(value.o));
}

function stepsForField(field, value) {
  let center;
  let spread;
  if (field.col === "dual") {
    const c = value && typeof value === "object" ? Number(value.c) : NaN;
    const o = value && typeof value === "object" ? Number(value.o) : NaN;
    if (finite(c) && finite(o)) {
      center = (c + o) / 2;
      spread = Math.abs(o - c) / 2;
    } else {
      center = finite(c) ? c : o;
      spread = Math.max(Math.abs(center) * 0.1, 1);
    }
  } else {
    center = Number(value);
    spread = Math.max(Math.abs(center) * 0.1, field.unit === "%" ? 1 : 0.5);
  }
  if (!finite(center)) return null;
  if (!finite(spread) || spread === 0) spread = Math.max(Math.abs(center) * 0.1, field.unit === "%" ? 1 : 0.5);
  return [-2, -1, 0, 1, 2].map((n) => round(center + n * spread));
}

function setFieldMid(form, field, value) {
  if (field.col === "dual") form[field.k] = { c: value, o: value };
  else form[field.k] = value;
}

function axisMeta(field, lang) {
  return {
    key: field.k,
    label: (field.label && field.label[lang]) || (field.label && field.label.en) || field.k,
    unit: field.unit || "",
  };
}

function formatAxisValue(value, field) {
  if (!finite(value)) return "—";
  const s = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
  return field.unit === "%" ? `${s}%` : s;
}

function cloneForm(form) {
  return JSON.parse(JSON.stringify(form || {}));
}

function round(n) {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 4: Run helper tests and confirm they pass**

Run:

```bash
npm test -- --project core test-core/valuation-workbench.test.js
```

Expected: PASS for `valuation-workbench.test.js`.

- [ ] **Step 5: Commit helper work**

Run:

```bash
git add public/shared/valuation/workbench.js test-core/valuation-workbench.test.js
git commit -m "Add valuation workbench helpers"
```

## Task 2: Rebuild Valuation Editor DOM

**Files:**
- Modify: `public/shared/valuation-ui.js`

- [ ] **Step 1: Import helper functions**

In `public/shared/valuation-ui.js`, update imports:

```js
import { MODELS, runModel, modeFields } from "/shared/valuation/index.js";
import { midpointForm, scheduleSeries, sensitivityMatrix } from "/shared/valuation/workbench.js";
```

- [ ] **Step 2: Replace the root layout creation**

Replace the current root creation block:

```js
const root = el("div", "vc");
const main = el("div", "vc-main");
const side = el("div", "vc-side");
root.append(main, side);
mount.appendChild(root);
```

with:

```js
const root = el("div", "vc vc-workbench");
const top = el("div", "vc-top");
const methodTitle = el("div", "vc-method-title");
const shell = el("div", "vc-shell");
const inputPanel = el("div", "vc-input-panel");
const resultsPanel = el("div", "vc-results-panel");
const inputBody = el("div", "vc-input-body");
const inputFooter = el("div", "vc-input-footer");
const summaryCard = el("section", "vc-result-card vc-summary-card");
const vizGrid = el("div", "vc-viz-grid");
const chartCard = el("section", "vc-result-card vc-chart-card");
const sensitivityCard = el("section", "vc-result-card vc-sens-card");

inputPanel.append(inputBody, inputFooter);
resultsPanel.append(summaryCard, vizGrid);
vizGrid.append(chartCard, sensitivityCard);
shell.append(inputPanel, resultsPanel);
root.append(top, shell);
mount.appendChild(root);
```

- [ ] **Step 3: Move method selector into the header**

Keep the existing select creation logic, but append it to `top` instead of `main`.

The top section should end with:

```js
const titleText = activeIdx >= 0
  ? ((MODELS[activeIdx].label && MODELS[activeIdx].label[lang]) || MODELS[activeIdx].key)
  : (lang === "zh" ? "添加估值" : "Add valuation");
methodTitle.textContent = titleText;
mblock.append(mlabel, select);
top.append(methodTitle, mblock);
```

- [ ] **Step 4: Move form wrapper into left panel**

Replace:

```js
const formWrap = el("div", "vc-form");
main.appendChild(formWrap);
```

with:

```js
const panelHead = el("div", "vc-panel-head");
panelHead.textContent = lang === "zh" ? "Inputs" : "Inputs";
const formWrap = el("div", "vc-form");
inputBody.append(panelHead, formWrap);
```

- [ ] **Step 5: Move note and submit into left footer**

Keep the existing note and submit creation, but append them to `inputFooter`:

```js
inputFooter.append(noteWrap, submitBtn);
```

Remove the old `side.appendChild(noteWrap)` and `side.appendChild(submitBtn)` calls.

- [ ] **Step 6: Rebuild the summary card**

Replace the old `rcard` append logic with summary-specific nodes:

```js
const summaryHead = el("div", "vc-card-title");
summaryHead.textContent = lang === "zh" ? "估值摘要" : "Valuation Summary";
const summaryLabel = el("div", "vc-summary-label");
summaryLabel.textContent = lang === "zh" ? "合理价值区间" : "Fair value range";
const nums = el("div", "vc-rnums");
const outLow = el("span", "vc-rlow"), outDash = el("span", "vc-rdash"), outHigh = el("span", "vc-rhigh");
outDash.textContent = "–";
nums.append(outLow, outDash, outHigh);
const verdictEl = el("div", "vc-rverdict");
const bdMount = el("div", "vc-summary-metrics");
const schedMount = el("div", "vc-sched");
summaryCard.append(summaryHead, summaryLabel, nums, verdictEl, bdMount, schedMount);
```

Keep variable names `outLow`, `outHigh`, `outDash`, `verdictEl`, `bdMount`, and `schedMount` so existing compute logic still references them.

- [ ] **Step 7: Add chart rendering function**

Inside `mountValuationCalc`, add:

```js
function renderChart(model, form, valid) {
  chartCard.innerHTML = "";
  chartCard.style.display = "none";
  if (!valid || typeof model.schedule !== "function") return;
  let schedule = null;
  try { schedule = model.schedule(midpointForm(model, currentMode, form), ctx); } catch { schedule = null; }
  const series = scheduleSeries(schedule);
  if (!series.length) return;

  chartCard.style.display = "";
  const title = el("div", "vc-card-title");
  title.textContent = model.key === "ddm"
    ? (lang === "zh" ? "逐年股息" : "Dividend year by year")
    : (lang === "zh" ? "逐年现金流" : "Cash flow year by year");
  chartCard.append(title, lineChart(series));
}
```

Add this SVG helper below it:

```js
function lineChart(series) {
  const wrap = el("div", "vc-chart-wrap");
  const w = 640, h = 260, pad = 34;
  const vals = series.map((p) => p.value);
  const min = Math.min(0, ...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => pad + (series.length === 1 ? 0 : i * (w - pad * 2) / (series.length - 1));
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = series.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const area = `${pad},${h - pad} ${pts} ${x(series.length - 1)},${h - pad}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "vc-chart");
  svg.innerHTML = `
    <polyline class="vc-chart-area" points="${area}"></polyline>
    <polyline class="vc-chart-line" points="${pts}"></polyline>
    ${series.map((p, i) => `<circle class="vc-chart-dot" cx="${x(i)}" cy="${y(p.value)}" r="3"></circle>`).join("")}
    ${series.map((p, i) => `<text class="vc-chart-x" x="${x(i)}" y="${h - 10}" text-anchor="middle">${p.label}</text>`).join("")}
  `;
  wrap.appendChild(svg);
  return wrap;
}
```

- [ ] **Step 8: Add sensitivity rendering function**

Inside `mountValuationCalc`, add:

```js
function renderSensitivity(model, form, valid) {
  sensitivityCard.innerHTML = "";
  sensitivityCard.style.display = "none";
  if (!valid) return;
  const matrix = sensitivityMatrix({
    model,
    mode: currentMode,
    form,
    ctx,
    run: runModel,
    lang,
  });
  if (!matrix) return;

  sensitivityCard.style.display = "";
  const title = el("div", "vc-card-title");
  title.textContent = lang === "zh" ? "敏感性分析" : "Sensitivity analysis";
  const table = el("div", "vc-sens-table");
  const head = el("div", "vc-sens-row vc-sens-head");
  const corner = el("div", "vc-sens-axis");
  corner.textContent = matrix.x.label;
  head.appendChild(corner);
  matrix.columns.forEach((col) => {
    const cell = el("div", "vc-sens-hcell");
    cell.textContent = col.label;
    head.appendChild(cell);
  });
  table.appendChild(head);
  matrix.rows.forEach((row) => {
    const tr = el("div", "vc-sens-row");
    const yLab = el("div", "vc-sens-y");
    yLab.textContent = row.label;
    tr.appendChild(yLab);
    row.cells.forEach((cell) => {
      const td = el("div", "vc-sens-cell" + (cell.center ? " center" : ""));
      td.textContent = cell.value === null ? "—" : fmt(cell.value, tx("dash"));
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  const yTitle = el("div", "vc-sens-ytitle");
  yTitle.textContent = matrix.y.label;
  sensitivityCard.append(title, yTitle, table);
}
```

- [ ] **Step 9: Call chart and sensitivity renderers from `compute`**

In `compute(formData)`, after `renderSchedule(model, formData, valid);`, add:

```js
renderChart(model, formData, valid);
renderSensitivity(model, formData, valid);
```

Keep `renderSchedule` for the expandable detailed table in the summary card.

- [ ] **Step 10: Update method title on method changes**

Inside `renderForm()`, after resolving `model`, add:

```js
methodTitle.textContent = activeIdx >= 0
  ? ((model.label && model.label[lang]) || model.key)
  : (lang === "zh" ? "添加估值" : "Add valuation");
```

Also in the empty method branch, hide both visualization cards:

```js
chartCard.style.display = "none";
sensitivityCard.style.display = "none";
```

- [ ] **Step 11: Run core helper tests**

Run:

```bash
npm test -- --project core test-core/valuation-workbench.test.js
```

Expected: PASS.

- [ ] **Step 12: Commit DOM rebuild**

Run:

```bash
git add public/shared/valuation-ui.js
git commit -m "Rebuild valuation editor workbench"
```

## Task 3: Replace Scoped Workbench Styles

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Update valuation edit page wrapper styles**

In the `<style>` block of `public/index.html`, replace the valuation editor layout rules for `.view-detail.view-valedit`, `.vc`, `.vc-main`, `.vc-side`, `.vc-mount`, `.vc-card`, `.vc-rcard`, `.vc-submit`, and related result/sidebar rules with scoped workbench styles.

Use this CSS block as the new valuation editor baseline:

```css
  body.ve-mode{background:#e9e9ec}
  body.ve-mode .page{max-width:none;border:0;background:#e9e9ec}
  body.ve-mode .frame-foot{display:none}
  .view-detail.view-valedit{padding:26px 30px 34px;background:#e9e9ec;min-height:100vh}
  .vc-mount{margin-top:0;padding-top:0;border-top:0}
  .vc-workbench{display:flex;flex-direction:column;gap:14px;color:#050505}
  .vc-top{display:flex;align-items:center;justify-content:space-between;gap:18px;background:#fff;border-radius:22px 22px 0 0;padding:24px 26px;border-bottom:1px solid #e8e8ea}
  .vc-method-title{font-size:28px;font-weight:700;letter-spacing:0;color:#050505}
  .vc-mblock{margin:0;display:flex;align-items:center;gap:10px}
  .vc-mlabel{font-size:12px;color:#8c8c93;margin:0}
  .vc-select{height:36px;min-width:210px;border:1px solid #dfdfe4;border-radius:10px;background-color:#fff;color:#050505;font-size:13px;box-shadow:none}
  .vc-shell{display:grid;grid-template-columns:432px minmax(0,1fr);gap:10px;background:#fff;border-radius:0 0 22px 22px;padding:10px}
  .vc-input-panel{min-height:720px;background:#f7f7fa;border:1px solid #e7e7ec;border-radius:16px;display:flex;flex-direction:column;overflow:hidden}
  .vc-panel-head{font-size:24px;font-weight:700;padding:24px 26px;border-bottom:1px solid #e7e7ec}
  .vc-input-body{min-height:0;flex:1;overflow:auto}
  .vc-form{padding:24px 26px 18px}
  .vc-input-footer{padding:0 26px 22px;margin-top:auto}
  .vc-results-panel{display:flex;flex-direction:column;gap:10px;min-width:0}
  .vc-result-card{background:#fff;border:1px solid #e2e2e7;border-radius:16px;padding:26px 28px;min-width:0}
  .vc-summary-card{min-height:222px}
  .vc-viz-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
  .vc-chart-card,.vc-sens-card{min-height:440px}
  .vc-card-title{font-size:24px;font-weight:700;letter-spacing:-.01em;margin-bottom:24px;color:#050505}
  .vc-summary-label{font-size:15px;color:#8c8c93;margin-bottom:8px}
  .vc-rnums{font-family:var(--font);display:flex;align-items:baseline;gap:0;color:#050505}
  .vc-rlow,.vc-rhigh{font-size:42px;font-weight:700;letter-spacing:-.01em;color:#050505}
  .vc-rdash{font-size:42px;font-weight:700;color:#050505}
  .vc-rverdict{font-size:14px;margin-top:10px}
  .vc-summary-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:26px}
  .vc-rrow{display:flex;flex-direction:column;align-items:flex-start;gap:5px;background:#f8f8fa;border-radius:12px;padding:12px 14px;font-size:13px}
  .vc-rk{color:#8c8c93}
  .vc-rv{font-family:var(--mono);font-size:14px;font-weight:600;color:#050505}
  .vc-card{background:transparent;border:0;border-radius:0;padding:0;margin:0 0 26px}
  .vc-card-head{font-size:18px;font-weight:700;color:#050505;margin-bottom:20px}
  .vc-card + .vc-card{border-top:1px dashed #e2e2e8;padding-top:26px}
  .vc-singles-grid{display:grid;grid-template-columns:1fr;gap:14px}
  .vc-fld{margin-bottom:18px}
  .vc-flabel,.vc-label{font-size:16px;color:#8c8c93;margin-bottom:8px}
  .vc-input{height:36px;border:0;border-radius:8px;background:#fff;font-size:14px;box-shadow:none}
  .vc-input:focus{outline:none;box-shadow:0 0 0 2px rgba(0,0,0,.14)}
  .vc-arow{display:grid;grid-template-columns:minmax(0,1fr) 104px 104px;gap:8px;align-items:center;margin-bottom:14px}
  .vc-chead{font-size:13px;color:#8c8c93;text-align:center}
  .vc-modes{background:#ededf2;border-radius:10px;padding:4px;margin-bottom:22px}
  .vc-modetab{border-radius:8px}
  .vc-modetab.on{background:#fff;color:#050505}
  .vc-note{margin:18px 0 16px}
  .vc-note-label{font-size:14px;color:#8c8c93;margin-bottom:8px}
  .vc-note-input{border:0;border-radius:10px;background:#fff;min-height:72px;box-shadow:none}
  .vc-submit{margin-top:0;width:100%;height:44px;border:0;border-radius:22px;background:#000;color:#fff;font-size:16px;box-shadow:none}
  .vc-submit:disabled{opacity:.28}
  .vc-chart-wrap{width:100%;overflow:hidden}
  .vc-chart{width:100%;height:auto;display:block}
  .vc-chart-area{fill:rgba(74,211,116,.16);stroke:none}
  .vc-chart-line{fill:none;stroke:#55d56f;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
  .vc-chart-dot{fill:#55d56f}
  .vc-chart-x{font-size:12px;fill:#8c8c93}
  .vc-sens-ytitle{font-size:12px;color:#8c8c93;margin:-14px 0 10px}
  .vc-sens-table{display:grid;gap:2px;overflow-x:auto}
  .vc-sens-row{display:grid;grid-template-columns:86px repeat(5,minmax(78px,1fr));gap:2px}
  .vc-sens-axis,.vc-sens-hcell,.vc-sens-y,.vc-sens-cell{min-height:50px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px}
  .vc-sens-axis,.vc-sens-hcell,.vc-sens-y{background:#f7f7fa;color:#5f6068;font-family:var(--font)}
  .vc-sens-cell{background:#e4fae9;color:#3d4650;border-radius:4px}
  .vc-sens-cell.center{outline:2px solid #222;background:#d2f6dc;font-weight:700;color:#111}
  @media (max-width:980px){
    .view-detail.view-valedit{padding:14px}
    .vc-top{border-radius:18px 18px 0 0;align-items:flex-start;flex-direction:column}
    .vc-shell{grid-template-columns:1fr}
    .vc-results-panel{order:-1}
    .vc-viz-grid{grid-template-columns:1fr}
    .vc-input-panel{min-height:0}
  }
  @media (max-width:560px){
    .vc-method-title{font-size:24px}
    .vc-shell{padding:8px}
    .vc-result-card{padding:20px 18px}
    .vc-summary-metrics{grid-template-columns:1fr}
    .vc-arow{grid-template-columns:1fr 1fr;gap:7px}
    .vc-arow .vc-label{grid-column:1 / -1}
  }
```

- [ ] **Step 2: Remove conflicting old result/sidebar rules**

Search for these selectors and delete or update old definitions that conflict with the new workbench:

```bash
rg -n "vc-main|vc-side|vc-rcard|vc-rcard-top|vc-rcard-rows|vc-viz-grid|vc-result-card" public/index.html
```

Expected after cleanup:

- No `.vc-main` or `.vc-side` rules remain.
- `.vc-rcard*` rules are gone because the new summary card uses `.vc-summary-card`.
- `.vc-result-card` and `.vc-viz-grid` exist only in the new workbench block.

- [ ] **Step 3: Run syntax/import smoke test**

Run:

```bash
node --check public/shared/valuation-ui.js
node --check public/shared/valuation/workbench.js
```

Expected: both commands exit 0.

- [ ] **Step 4: Run project tests**

Run:

```bash
npm test
```

Expected: all existing core and worker tests pass.

- [ ] **Step 5: Commit styles**

Run:

```bash
git add public/index.html
git commit -m "Style valuation editor workbench"
```

## Task 4: Browser Verification

**Files:**
- No code files expected unless visual verification finds layout defects.

- [ ] **Step 1: Start local dev server**

Run:

```bash
npm run dev
```

Expected: Wrangler dev server starts, usually at `http://localhost:8787`.

- [ ] **Step 2: Open the app and reach a valuation editor**

Use the local browser to open the app. If no user/data exists locally, use the owner flow to create an activation code and register a test user, then add a ticker and open its valuation editor.

Expected:

- The add valuation page has the screenshot-like white-gray workbench.
- Method selector appears in the top header.
- Left panel shows inputs and Save.
- Right panel shows summary.

- [ ] **Step 3: Verify method-specific panels**

Manual scenarios:

- PE classic: summary and sensitivity appear after valid inputs.
- PE segment mode: segment build-up appears only in segment mode.
- FCFF or FCFE: year-by-year chart appears after valid inputs.
- Resource NAV/SOTP: commodity/asset panels appear only for resource model.

Expected:

- Advanced modules are not visible for unrelated methods.
- Save stays disabled until the range is valid.
- Saving returns to the detail page and creates/updates a valuation card.

- [ ] **Step 4: Verify responsive layout**

Check at desktop width and mobile width.

Expected:

- Desktop: left panel and right results are side by side.
- Mobile: summary appears before inputs, then method-specific panels/chart/sensitivity stack.
- No text overlaps buttons, cards, fields, or matrix cells.

- [ ] **Step 5: Fix any visual defects and rerun tests**

For any defects found, patch `public/index.html` or `public/shared/valuation-ui.js`, then rerun:

```bash
node --check public/shared/valuation-ui.js
node --check public/shared/valuation/workbench.js
npm test
```

Expected: syntax checks and tests pass.

- [ ] **Step 6: Commit verification fixes if any**

If fixes were needed, run:

```bash
git add public/index.html public/shared/valuation-ui.js public/shared/valuation/workbench.js test-core/valuation-workbench.test.js
git commit -m "Polish valuation workbench verification"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

- Spec coverage: The plan covers the new layout, method-specific advanced modules, sensitivity analysis, schedule chart, unchanged data flow, scoped styling, desktop/mobile behavior, and verification.
- Placeholder scan: No `TODO`, `TBD`, or unspecified implementation steps remain.
- Type consistency: The plan consistently uses `mountValuationCalc`, `runModel`, `modeFields`, `inputs`, `derivations`, `segments`, `low`, `high`, `note`, and the new helper names `midpointForm`, `scheduleSeries`, and `sensitivityMatrix`.
