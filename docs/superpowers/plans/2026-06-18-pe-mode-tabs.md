# PE 输入口径 radio tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PE 估值选中后,顶部一排 radio tab 切换四种输入口径——经典PE(净利润) / EPS / 营收·利润率 / 分业务——同一个 PE 估值,不同输入精细度。

**Architecture:** PE 模型从单一 `fields` 改为 `modes`(每口径自带 fields)+ 按 `vals._mode` 分派的 `compute`/`breakdown`(`segment`≡`revenue`)。新增共享 `modeFields(model,mode)`;`runModel`、valuation-ui 的取字段处、`assumeSummary` 全部走它并注入 `_mode`。「分业务」复用 revenue 算法 + 已有分部表(从开关升级为口径)。

**Tech Stack:** 原生 ESM;vitest(core/worker);Cloudflare Workers + D1;`wrangler dev` localhost:8787;部署 `./node_modules/.bin/wrangler deploy`。

**测试现实:** 模型与 runModel 是纯逻辑(`test-core`,TDD);valuation-ui.js / index.html 无 DOM 单测,浏览器验证(控制器执行)。

---

## File Structure

- **Modify** `public/shared/valuation/relative.js` — PE 改造为 `modes`(去顶层 `fields`)+ 分派 compute/breakdown。
- **Modify** `public/shared/valuation/index.js` — 加 `export modeFields`;`runModel` mode-aware。
- **Modify** `test-core/valuation-relative.test.js` — PE 各口径用例。
- **Modify** `public/shared/valuation-ui.js` — radio tab、`modeFields` 取字段、`currentMode`、`buildForm` 注入 `_mode`、分部门控改 `currentMode==="segment"`、分部区在 segment 口径常开。
- **Modify** `public/index.html` — `assumeSummary` mode-aware;`.vc-modes` 样式。

---

## Task 1: PE 模型改造为 modes(纯逻辑,TDD)

**Files:**
- Modify: `public/shared/valuation/relative.js`(PE,约 14-47 行）
- Test: `test-core/valuation-relative.test.js`

- [ ] **Step 1: 写失败测试**

在 `test-core/valuation-relative.test.js` 末尾追加（文件已 `import { MODELS } ...` 或直接从 relative.js import；按文件现有 import 风格取 PE。若文件已有 `PE` 引用，复用；否则加 `import { RELATIVE } from "../public/shared/valuation/relative.js"; const PE = RELATIVE.find(m=>m.key==="pe");`）：

```js
describe("PE modes", () => {
  const PE = (await import("../public/shared/valuation/relative.js")).RELATIVE.find((m) => m.key === "pe");
  const ctx = { shares: 100 };
  it("netIncome 口径: NI×(1+g)^n/shares×PE", () => {
    const v = PE.compute({ _mode: "netIncome", netIncome: 150, n: 5, growth: 10, targetPE: 20 }, ctx);
    expect(v).toBeCloseTo(48.32, 1); // 150×1.1^5=241.58 /100 ×20
  });
  it("eps 口径: eps×(1+g)^n×PE, 不依赖股本", () => {
    const v = PE.compute({ _mode: "eps", eps: 2.4158, n: 5, growth: 10, targetPE: 20 }, { shares: 0 });
    expect(v).toBeCloseTo(77.82, 1); // 2.4158×1.1^5=3.891 ×20
  });
  it("revenue 口径(缺省 ≡ revenue): 现状算法", () => {
    const v = PE.compute({ revenue: 1000, n: 5, growth: 10, netMargin: 15, targetPE: 20 }, ctx);
    expect(v).toBeCloseTo(48.32, 1);
  });
  it("segment 口径 ≡ revenue", () => {
    const a = PE.compute({ _mode: "segment", revenue: 1000, n: 5, growth: 10, netMargin: 15, targetPE: 20 }, ctx);
    const b = PE.compute({ _mode: "revenue", revenue: 1000, n: 5, growth: 10, netMargin: 15, targetPE: 20 }, ctx);
    expect(a).toBeCloseTo(b, 6);
  });
  it("netIncome 缺股本 → null;eps 不受影响", () => {
    expect(PE.compute({ _mode: "netIncome", netIncome: 150, n: 5, growth: 10, targetPE: 20 }, { shares: 0 })).toBe(null);
    expect(PE.compute({ _mode: "eps", eps: 2, n: 5, growth: 10, targetPE: 20 }, { shares: 0 })).not.toBe(null);
  });
  it("modes 暴露四口径,无顶层 fields", () => {
    expect(PE.modes.map((m) => m.key)).toEqual(["netIncome", "eps", "revenue", "segment"]);
    expect(PE.fields).toBeUndefined();
    expect(PE.defaultMode).toBe("netIncome");
  });
  it("breakdown 按口径返回明细", () => {
    expect(PE.breakdown({ _mode: "eps", eps: 2, n: 5, growth: 10, targetPE: 20 }, ctx).map((r) => r.key)).toEqual(["futEps", "pe"]);
    expect(PE.breakdown({ _mode: "netIncome", netIncome: 150, n: 5, growth: 10, targetPE: 20 }, ctx).map((r) => r.key)).toEqual(["futNi", "eps", "pe"]);
    expect(PE.breakdown({ revenue: 1000, n: 5, growth: 10, netMargin: 15, targetPE: 20 }, ctx).map((r) => r.key)).toEqual(["futRev", "futNi", "pe"]);
  });
});
```

> 注：`await import` 在顶层 describe 回调里不可用。改写为文件顶部 `import { RELATIVE } from "../public/shared/valuation/relative.js";` 一行（若尚无），再 `const PE = RELATIVE.find((m) => m.key === "pe");` 放在 describe 内同步取。实现者按文件现状择一，保证同步取到 PE。

- [ ] **Step 2: 运行,确认失败**

Run: `./node_modules/.bin/vitest run --project core test-core/valuation-relative.test.js`
Expected: FAIL（PE.modes undefined / compute 不识别 _mode）

- [ ] **Step 3: 写实现 —— 替换 relative.js 的 PE 定义**

把 `relative.js` 第 14-47 行的整个 `const PE = {...};` 替换为：

```js
// PE 估值：四种输入口径(modes),按 vals._mode 分派(segment ≡ revenue)。
const PE_N = { k: "n", label: { zh: "预测年数", en: "Years" }, col: "single", unit: "", prefill: () => "", default: 5, meta: "forecastYears" };
const PE_TARGET = { k: "targetPE", label: { zh: "目标 PE", en: "Target P/E" }, col: "dual", unit: "", default: 20, meta: "targetPE" };
const PE_REV_FIELDS = [
  { k: "revenue", label: { zh: "当前营收", en: "Current revenue" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.revenue)) ? ctx.revenue : "", hint: { zh: "公司总营收（不是每股）", en: "Total revenue, not per share" }, meta: "revenue" },
  PE_N,
  { k: "growth", label: { zh: "营收增速", en: "Revenue growth" }, col: "dual", unit: "%", default: 10, meta: "revGrowth" },
  { k: "netMargin", label: { zh: "净利率", en: "Net margin" }, col: "dual", unit: "%", default: 15, meta: "netMargin" },
  PE_TARGET,
];
const PE = {
  key: "pe",
  group: "relative",
  label: { zh: "PE 估值", en: "P/E" },
  defaultMode: "netIncome",
  modes: [
    { key: "netIncome", label: { zh: "经典 PE", en: "Classic (NI)" }, fields: [
      { k: "netIncome", label: { zh: "净利润", en: "Net income" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.netIncome)) ? ctx.netIncome : "", hint: { zh: "公司净利润总额（不是每股）", en: "Total net income, not per share" }, meta: "netIncome" },
      PE_N,
      { k: "growth", label: { zh: "净利润增速", en: "Net income growth" }, col: "dual", unit: "%", default: 10, meta: "niGrowth" },
      PE_TARGET,
    ] },
    { key: "eps", label: { zh: "EPS", en: "EPS" }, fields: [
      { k: "eps", label: { zh: "每股收益", en: "EPS" }, col: "single", unit: "", prefill: (ctx) => (ctx && Number.isFinite(ctx.epsTtm)) ? ctx.epsTtm : "", hint: { zh: "每股收益，默认 TTM", en: "EPS, defaults to TTM" }, meta: "eps" },
      PE_N,
      { k: "growth", label: { zh: "EPS 增速", en: "EPS growth" }, col: "dual", unit: "%", default: 10, meta: "epsGrowth" },
      PE_TARGET,
    ] },
    { key: "revenue", label: { zh: "营收·利润率", en: "Revenue×margin" }, fields: PE_REV_FIELDS },
    { key: "segment", label: { zh: "分业务", en: "By segment" }, fields: PE_REV_FIELDS },
  ],
  compute(vals, ctx) {
    const mode = vals._mode === "segment" ? "revenue" : (vals._mode || "revenue");
    const { n, targetPE } = vals;
    if (![n, vals.growth, targetPE].every(finite)) return null;
    const g = vals.growth / 100;
    if (mode === "eps") {
      if (!finite(vals.eps)) return null;
      return vals.eps * Math.pow(1 + g, n) * targetPE;
    }
    if (!posFinite(ctx.shares)) return null;
    if (mode === "netIncome") {
      if (!finite(vals.netIncome)) return null;
      const futNi = vals.netIncome * Math.pow(1 + g, n);
      return (futNi / ctx.shares) * targetPE;
    }
    if (![vals.revenue, vals.netMargin].every(finite)) return null;
    const futRev = vals.revenue * Math.pow(1 + g, n);
    const eps = (futRev * (vals.netMargin / 100)) / ctx.shares;
    return eps * targetPE;
  },
  breakdown(vals, ctx) {
    const mode = vals._mode === "segment" ? "revenue" : (vals._mode || "revenue");
    const { n, targetPE } = vals;
    const peRow = { key: "pe", label: { zh: "目标 PE", en: "Target P/E" }, value: finite(targetPE) ? targetPE : null, kind: "mult" };
    const pow = (base) => (finite(base) && finite(n) && finite(vals.growth)) ? base * Math.pow(1 + vals.growth / 100, n) : null;
    if (mode === "eps") {
      return [{ key: "futEps", label: { zh: "预期 EPS", en: "Projected EPS" }, value: pow(vals.eps), kind: "num" }, peRow];
    }
    if (mode === "netIncome") {
      const futNi = pow(vals.netIncome);
      const eps = (futNi !== null && posFinite(ctx.shares)) ? futNi / ctx.shares : null;
      return [{ key: "futNi", label: { zh: "预期净利润", en: "Projected net income" }, value: futNi, kind: "money" }, { key: "eps", label: { zh: "隐含 EPS", en: "Implied EPS" }, value: eps, kind: "num" }, peRow];
    }
    const futRev = pow(vals.revenue);
    const futNi = (futRev !== null && finite(vals.netMargin)) ? futRev * (vals.netMargin / 100) : null;
    return [{ key: "futRev", label: { zh: "预期营收（n年后）", en: "Projected revenue" }, value: futRev, kind: "money" }, { key: "futNi", label: { zh: "预期净利润", en: "Projected net income" }, value: futNi, kind: "money" }, peRow];
  },
};
```

确保 `relative.js` 顶部仍有 `posFinite`/`finite` 定义（已存在）。`RELATIVE` 导出数组里 PE 仍在原位。

- [ ] **Step 4: 运行,确认通过**

Run: `./node_modules/.bin/vitest run --project core test-core/valuation-relative.test.js`
Expected: PASS（含新 7 个 + 原有用例；若原有 PE 用例用 `_mode` 缺省，应仍绿——缺省 ≡ revenue）

- [ ] **Step 5: 提交**

```bash
git add public/shared/valuation/relative.js test-core/valuation-relative.test.js
git commit -m "feat(valuation): PE input modes (classic NI / EPS / revenue / segment)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: runModel mode-aware + modeFields(纯逻辑,TDD)

**Files:**
- Modify: `public/shared/valuation/index.js`
- Test: `test-core/valuation-relative.test.js`(经 runModel 验证)

- [ ] **Step 1: 写失败测试**

在 `test-core/valuation-relative.test.js` 顶部 import 加 `runModel`、`modeFields`（与现有 `import { RELATIVE }` 同处）：
```js
import { runModel, modeFields } from "../public/shared/valuation/index.js";
```
在 `describe("PE modes", ...)` 内追加：
```js
  it("runModel 按 _mode 取字段并注入,算出区间", () => {
    const r = runModel(PE, { _mode: "netIncome", netIncome: 150, n: 5, growth: { c: 8, o: 12 }, targetPE: { c: 18, o: 22 } }, { shares: 100 });
    expect(r.low).toBeGreaterThan(0); expect(r.high).toBeGreaterThan(r.low);
  });
  it("modeFields 取对应口径字段", () => {
    expect(modeFields(PE, "eps").map((f) => f.k)).toEqual(["eps", "n", "growth", "targetPE"]);
    expect(modeFields(PE, "segment").map((f) => f.k)).toEqual(["revenue", "n", "growth", "netMargin", "targetPE"]);
  });
```

- [ ] **Step 2: 运行,确认失败**

Run: `./node_modules/.bin/vitest run --project core test-core/valuation-relative.test.js`
Expected: FAIL（`modeFields` 未导出 / runModel 用 model.fields 报错）

- [ ] **Step 3: 写实现 —— `public/shared/valuation/index.js`**

加 `modeFields` 导出，并把 `runModel` 改为 mode-aware：

```js
// 取某模型在某口径下的字段;无 modes 的模型回退到 model.fields。
export function modeFields(model, mode) {
  if (!model.modes) return model.fields || [];
  const key = mode || model.defaultMode || model.modes[0].key;
  const m = model.modes.find((x) => x.key === key) || model.modes.find((x) => x.key === model.defaultMode) || model.modes[0];
  return m.fields;
}

export function runModel(model, form, ctx) {
  const cons = {};
  const opt = {};
  const fields = model.modes ? modeFields(model, form._mode || model.defaultMode) : model.fields;
  for (const field of fields) {
    const v = form[field.k];
    if (field.col === "dual") {
      cons[field.k] = v && typeof v === "object" ? v.c : NaN;
      opt[field.k] = v && typeof v === "object" ? v.o : NaN;
    } else {
      cons[field.k] = v;
      opt[field.k] = v;
    }
  }
  if (model.modes) { cons._mode = opt._mode = form._mode || model.defaultMode; }

  const a = safe(model.compute(cons, ctx));
  const b = safe(model.compute(opt, ctx));
  if (a === null || b === null) return { low: null, high: null };
  return { low: Math.min(a, b), high: Math.max(a, b) };
}
```
（`safe` 保持不变。）

- [ ] **Step 4: 运行,确认通过**

Run: `./node_modules/.bin/vitest run --project core`
Expected: 全 core 绿（relative + 其它模型未受影响）。

- [ ] **Step 5: 提交**

```bash
git add public/shared/valuation/index.js test-core/valuation-relative.test.js
git commit -m "feat(valuation): mode-aware runModel + modeFields helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 口径 radio tab + UI mode-aware(valuation-ui.js)— 浏览器验证

**Files:**
- Modify: `public/shared/valuation-ui.js`

实现 radio tab、`currentMode`、按口径取字段、`buildForm` 注入 `_mode`、分部区从「开关」改为「segment 口径常开」。**不要做浏览器测试 — 控制器做。**

- [ ] **Step 1: import modeFields + currentMode 状态**

import 区把 `import { MODELS, runModel } from "/shared/valuation/index.js";` 改为：
```js
import { MODELS, runModel, modeFields } from "/shared/valuation/index.js";
```
在 `let lastLow = null, lastHigh = null, lastForm = {};` 之后(与 `const segments=...` 同处)加：
```js
  let currentMode = null;
  function activeFields() { const model = MODELS[activeIdx]; return model ? modeFields(model, currentMode) : []; }
```

- [ ] **Step 2: currentDerivations / consOpt / midVals 改用 activeFields + 注入 _mode**

把 `currentDerivations` 里 `const keys = new Set((model.fields || []).map((f) => f.k));` 改为：
```js
    const keys = new Set(modeFields(model, currentMode).map((f) => f.k));
```
把 `consOpt(model, form)` 函数体改为（用 activeFields + 注入 _mode）：
```js
  function consOpt(model, form) {
    const cons = {}, opt = {};
    for (const f of modeFields(model, currentMode)) {
      const v = form[f.k];
      if (f.col === "dual") { cons[f.k] = v && typeof v === "object" ? v.c : NaN; opt[f.k] = v && typeof v === "object" ? v.o : NaN; }
      else { cons[f.k] = v; opt[f.k] = v; }
    }
    if (model.modes) { cons._mode = opt._mode = currentMode; }
    return { cons, opt };
  }
```
把 `midVals(model, form)` 里 `for (const f of model.fields) {` 改为 `for (const f of modeFields(model, currentMode)) {`，并在 return 前加：`if (model.modes) v._mode = currentMode;`（`v` 为它构造的对象名，按现有代码名）。

- [ ] **Step 3: buildForm 注入 _mode**

把 `function buildForm(readers) { const form = {}; readers.forEach(({ field, getVal }) => { form[field.k] = getVal(); }); return form; }` 改为：
```js
  function buildForm(readers) { const form = {}; readers.forEach(({ field, getVal }) => { form[field.k] = getVal(); }); if (MODELS[activeIdx] && MODELS[activeIdx].modes) form._mode = currentMode; return form; }
```

- [ ] **Step 4: renderForm 解析 currentMode + 渲染 radio tab + 用 activeFields**

在 `function renderForm() {` 开头(`formWrap.innerHTML = "";` 之后、`activeIdx < 0` 判断之前或之后均可，但需在用到 model 之前)加 currentMode 解析；在 `const model = MODELS[activeIdx];` 之后：
```js
    if (model.modes) {
      if (!currentMode || !model.modes.some((m) => m.key === currentMode)) {
        currentMode = (initialInputs && initialInputs._mode)
          || (initialInputs && segments && segments.enabled ? "segment" : (initialInputs ? "revenue" : (model.defaultMode || model.modes[0].key)));
        if (!model.modes.some((m) => m.key === currentMode)) currentMode = model.modes[0].key;
      }
    } else { currentMode = null; }
```
把 `const fields = model.fields || [];` 改为：
```js
    const fields = modeFields(model, currentMode);
```
在 singles/duals 卡片构建之前(紧接 `const fieldEls = {};` 之后)插入 radio tab 渲染：
```js
    if (model.modes) {
      const tabs = el("div", "vc-modes");
      model.modes.forEach((mo) => {
        const b = el("button", "vc-modetab" + (mo.key === currentMode ? " on" : ""), { type: "button" });
        b.textContent = (mo.label && mo.label[lang]) || mo.key;
        b.addEventListener("click", () => { if (currentMode !== mo.key) { currentMode = mo.key; renderForm(); } });
        tabs.appendChild(b);
      });
      formWrap.appendChild(tabs);
    }
```

- [ ] **Step 5: 方法切换时重置 currentMode**

把 `select.addEventListener("change", () => { activeIdx = Number(select.value); renderForm(); });` 改为：
```js
  select.addEventListener("change", () => { activeIdx = Number(select.value); currentMode = null; renderForm(); });
```

- [ ] **Step 6: 分部区从开关改为「segment 口径常开」**

把 renderForm 末尾的：
```js
    if (model.key === "pe") {
      const segSection = buildSegmentSection(fieldEls, recompute);
      formWrap.insertBefore(segSection, formWrap.firstChild);
    }
```
改为（仅 segment 口径渲染，且插在 radio tab 之下、卡片之上 —— 用 appendChild 让它排在 tab 之后、表单卡之前需要顺序控制；简单起见插在 formWrap 末尾上方，见下）：
```js
    if (currentMode === "segment") {
      const segSection = buildSegmentSection(fieldEls, recompute);
      formWrap.insertBefore(segSection, formWrap.children[1] || null); // 排在 radio tab 之后、表单卡之前
    }
```
并把 `buildSegmentSection` 改为「无开关、常开」：将其中
```js
    function setEnabled(on) { segments.enabled = on; toggle.checked = on; body.style.display = on ? "" : "none"; setDriven(on); if (on) recomputeSeg(); else recompute(); }
    toggle.addEventListener("change", () => setEnabled(toggle.checked));

    if (segments.rows && segments.rows.length) segments.rows.forEach((row) => makeRow(row));
    setEnabled(!!segments.enabled);
    return wrap;
```
改为：
```js
    function setEnabled(on) { segments.enabled = on; body.style.display = on ? "" : "none"; setDriven(on); if (on) recomputeSeg(); else recompute(); }

    if (segments.rows && segments.rows.length) segments.rows.forEach((row) => makeRow(row)); else makeRow();
    head.removeChild(togLab); // 口径即开关,去掉行内开关
    setEnabled(true);
    return wrap;
  }
```
（`togLab` 是 buildSegmentSection 里那个含 checkbox 的 label；移除它即可，标题保留。`makeRow()` 在无存档行时给一个空行起步。）

- [ ] **Step 7: onDone segments 按口径输出**

把 onDone 调用里的 `segments,` 改为按口径输出已启用状态：在 onDone 之前已有 `segments` 闭包对象。把
```js
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, derivations: currentDerivations(), segments, low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh), note: noteInput.value.trim() });
```
改为：
```js
    const segOut = currentMode === "segment" ? { enabled: true, rows: segments.rows } : { enabled: false, rows: segments.rows || [] };
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, derivations: currentDerivations(), segments: segOut, low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh), note: noteInput.value.trim() });
```

- [ ] **Step 8: 自检（grep）**

Run: `grep -n "modeFields\|currentMode\|vc-modes\|activeFields\|_mode" public/shared/valuation-ui.js`
确认改动到位；重读 renderForm / consOpt / buildSegmentSection,确认括号闭合、`model` 在使用前已定义。

- [ ] **Step 9: 提交**

```bash
git add public/shared/valuation-ui.js
git commit -m "feat(valuation): PE input-mode radio tabs; segment becomes a mode

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: assumeSummary mode-aware + 样式(index.html)— 浏览器验证

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: assumeSummary 按 card 口径取字段**

`assumeSummary(model, inputs)` 现为 `return (model.fields || []).filter((f) => f.col === "dual").map(...)`。文件已 `import { MODELS } ...`；把 import 行加上 `modeFields`：找到 `import { MODELS } from "/shared/valuation/index.js";` 改为 `import { MODELS, modeFields } from "/shared/valuation/index.js";`（若该 import 已含其它项，仅追加 `modeFields`）。把 assumeSummary 第一行改为：
```js
  const fields = model.modes ? modeFields(model, inputs._mode || model.defaultMode) : (model.fields || []);
  return fields.filter((f) => f.col === "dual").map((f) => {
```
（其余 map 体不变。注意 `inputs` 是该函数入参。）

- [ ] **Step 2: 加 radio tab 样式**

在 `.vc-empty-method{...}` 那条样式之后插入：
```css
  .vc-modes{display:flex;gap:4px;margin-bottom:14px;background:var(--accent);border-radius:8px;padding:3px;width:fit-content}
  .vc-modetab{appearance:none;background:none;border:0;padding:6px 12px;font-size:12.5px;color:var(--ink-soft);border-radius:6px;cursor:pointer;font-weight:500}
  .vc-modetab.on{background:#fff;color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06)}
```

- [ ] **Step 3: 提交**

```bash
git add public/index.html
git commit -m "feat(detail): mode-aware assume summary + PE mode-tab styles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 浏览器端到端 + 全量测试 + 部署(控制器执行)

- [ ] **Step 1: 程序化验证(挂载 PE,切四口径)**

`http://localhost:8787/b/demo` 控制台挂载 PE,验证 4 个 tab、各口径字段、结果:
```js
const m = await import('/shared/valuation-ui.js?t=' + Date.now());
const host = document.createElement('div'); host.id='__pe'; document.body.appendChild(host);
m.mountValuationCalc(host, { shares: 1e9, price: 50, epsTtm: 3, netIncome: 4e9, revenue: 4e10 },
  { lang:'zh', initialMethod:'pe', refData:{sources:{}}, verdict:()=>null, onDone(){}, onCancel(){} });
const tabs = [...host.querySelectorAll('.vc-modetab')].map(b=>b.textContent);
const defaultOn = host.querySelector('.vc-modetab.on').textContent;
// 默认应是「经典 PE」。切到「分业务」:
const segTab = [...host.querySelectorAll('.vc-modetab')].find(b=>b.textContent.includes('分业务')); segTab.click();
const hasSeg = !!host.querySelector('.vc-seg');
host.remove();
return { tabs, defaultOn, hasSegOnSegmentTab: hasSeg };
```
Expected: `tabs=["经典 PE","EPS","营收·利润率","分业务"]`;`defaultOn="经典 PE"`;`hasSegOnSegmentTab=true`。

- [ ] **Step 2: 端到端(真实编辑器:经典PE 存档→重开)**

创建临时未估值标的 → 详情「估值研究」→ 添加估值 → 选 PE → 默认「经典 PE」tab → 填净利润(预填或手填)+ 预测年数 + 增速 + 目标PE → 保存。`/api/config` 确认卡片 `inputs._mode==="netIncome"`;重开编辑确认默认停在「经典 PE」tab、值还原。再切「分业务」tab 填分部 → 保存 → 确认 `inputs._mode==="segment"` 且 `segments.enabled===true`。完成后删除临时标的(demo 保持 4 只)。

- [ ] **Step 3: 全量测试**

Run: `./node_modules/.bin/vitest run`
Expected: 全绿。

- [ ] **Step 4: 部署 + 冒烟**

```bash
./node_modules/.bin/wrangler deploy
curl -s "https://valuation-pendulum.jonyf176.workers.dev/shared/valuation/index.js" -o /tmp/idx.js && grep -c "modeFields" /tmp/idx.js
```
Expected: 部署成功;grep ≥ 1。

---

## 自查覆盖

- spec 四口径(netIncome/eps/revenue/segment)→ Task 1 modes + compute/breakdown 分派。
- 默认口径(新卡 netIncome / 旧卡 revenue / 旧开关分部→segment)→ Task 3 Step 4 currentMode 解析。
- ★ runModel mode-aware + _mode 注入 → Task 2。
- ★ assumeSummary mode-aware → Task 4 Step 1。
- UI 取字段统一 modeFields(currentDerivations/consOpt/midVals/renderForm)→ Task 3 Step 2、4。
- radio tab → Task 3 Step 4 + Task 4 Step 2 样式。
- 分业务=口径、复用 revenue、分部表常开 → Task 3 Step 6;`segment`≡`revenue` compute → Task 1。
- 持久化 `_mode` + `segments` → 透传(items.js 无需改),onDone 输出 → Task 3 Step 7。
- 去顶层 fields → Task 1(PE 无 `fields`);所有读取走 modeFields(Task 2/3/4)。
- 边界(eps 不依赖股本;缺股本 null)→ Task 1 compute + 测试。
