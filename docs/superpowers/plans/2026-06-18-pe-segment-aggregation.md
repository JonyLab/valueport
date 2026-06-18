# PE 分部加总 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 PE 估值模型加可选的「分部加总」表——逐业务填当前营收 + 增速{保守,乐观} + 净利率{保守,乐观},自下而上算出第 n 年合计净利 E,精确驱动 PE 的营收/增速/净利率三字段。

**Architecture:** 纯聚合逻辑放新模块 `valuation/segments.js`(可单测);`valuation-ui.js` 在 PE 表单顶部加一块「分部」区(开关式),开启时分部表驱动三字段并置只读;过程存进卡片 `segments`,服务端放行,重开还原。数学上 ΣEᵢ × PE 与"回填混合增速+净利率"恒等。

**Tech Stack:** 原生 ESM(无打包);vitest(core/worker);Cloudflare Workers + D1;`wrangler dev` localhost:8787;部署 `./node_modules/.bin/wrangler deploy`。

**测试现实:** core 逻辑用 vitest(`test-core/**`),worker 用 `test/**`;`valuation-ui.js`/`index.html` 无 DOM 单测,靠浏览器验证(控制器执行)。

---

## File Structure

- **Create** `public/shared/valuation/segments.js` — `aggregateSegments(rows, n)` 纯聚合。
- **Create** `test-core/valuation-segments.test.js` — 单测。
- **Modify** `src/items.js` — `validateValuations` 放行卡片 `segments`。
- **Modify** `test/items.test.js` — segments 存取用例。
- **Modify** `public/shared/valuation-ui.js` — 线程 `initialSegments`/onDone `segments`;`fieldEls` 引用图;`buildSegmentSection`;renderForm 在 PE 顶部挂分部区。
- **Modify** `public/index.html` — `showEditor` 透传 `initialSegments`、onDone 存 `segments`;`.vc-seg*` 样式。

---

## Task 1: 分部聚合(纯逻辑,TDD)

**Files:**
- Create: `public/shared/valuation/segments.js`
- Test: `test-core/valuation-segments.test.js`

- [ ] **Step 1: 写失败测试**

Create `test-core/valuation-segments.test.js`:

```js
import { describe, it, expect } from "vitest";
import { aggregateSegments } from "../public/shared/valuation/segments.js";

describe("aggregateSegments", () => {
  const rows = [
    { revenue: 120e8, growth: { c: 5, o: 9 }, netMargin: { c: 18, o: 20 } },
    { revenue: 45e8, growth: { c: 18, o: 25 }, netMargin: { c: 10, o: 14 } },
  ];
  const n = 5;
  const segE = (k) => rows.reduce((s, x) => s + x.revenue * Math.pow(1 + x.growth[k] / 100, n) * x.netMargin[k] / 100, 0);

  it("合计当前营收 = 各部之和", () => {
    expect(aggregateSegments(rows, n).revenue).toBe(165e8);
  });
  it("回填的混合增速+净利率重算 E 精确等于 ΣEᵢ", () => {
    const r = aggregateSegments(rows, n);
    const reE = (k) => r.revenue * Math.pow(1 + r.growth[k] / 100, n) * r.netMargin[k] / 100;
    expect(reE("c")).toBeCloseTo(segE("c"), 1);
    expect(reE("o")).toBeCloseTo(segE("o"), 1);
  });
  it("futNi 直接给出合计净利 E(保守/乐观)", () => {
    const r = aggregateSegments(rows, n);
    expect(r.futNi.c).toBeCloseTo(segE("c"), 1);
    expect(r.futNi.o).toBeCloseTo(segE("o"), 1);
  });
  it("n 缺失 / 0 行 / 合计营收<=0 → null", () => {
    expect(aggregateSegments(rows, 0)).toBe(null);
    expect(aggregateSegments([], 5)).toBe(null);
    expect(aggregateSegments([{ revenue: 0, growth: { c: 5, o: 5 }, netMargin: { c: 10, o: 10 } }], 5)).toBe(null);
  });
  it("空增速/净利率按 0 处理", () => {
    const r = aggregateSegments([{ revenue: 100, growth: { c: "", o: "" }, netMargin: { c: "", o: "" } }], 5);
    expect(r.growth.c).toBeCloseTo(0);
    expect(r.netMargin.c).toBeCloseTo(0);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `./node_modules/.bin/vitest run --project core test-core/valuation-segments.test.js`
Expected: FAIL（unresolved import）

- [ ] **Step 3: 写实现**

Create `public/shared/valuation/segments.js`:

```js
/**
 * valuation/segments.js — PE 分部加总。
 * 各分部 { revenue, growth:{c,o}, netMargin:{c,o} } → 第 n 年合计营收/合计净利,
 * 反解出可回填 PE 模型的 混合增速{c,o} 与 混合净利率{c,o}(与 ΣEᵢ 数学恒等)。
 */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

// 返回 { revenue, growth:{c,o}, netMargin:{c,o}, futRev:{c,o}, futNi:{c,o} } 或 null(输入不足)
export function aggregateSegments(rows, n) {
  const years = Number(n);
  if (!Array.isArray(rows) || rows.length === 0 || !(years > 0)) return null;
  const revOf = (r) => { const v = num(r && r.revenue); return v > 0 ? v : 0; };
  const R0 = rows.reduce((s, r) => s + revOf(r), 0);
  if (!(R0 > 0)) return null;
  const side = (k) => {
    let futRev = 0, futNi = 0;
    for (const r of rows) {
      const rev = revOf(r); if (!(rev > 0)) continue;
      const g = num(r.growth && r.growth[k]); const mg = num(r.netMargin && r.netMargin[k]);
      const fr = rev * Math.pow(1 + (Number.isFinite(g) ? g : 0) / 100, years);
      futRev += fr;
      futNi += fr * (Number.isFinite(mg) ? mg : 0) / 100;
    }
    return { growth: (Math.pow(futRev / R0, 1 / years) - 1) * 100, netMargin: futRev > 0 ? futNi / futRev * 100 : 0, futRev, futNi };
  };
  const c = side("c"), o = side("o");
  return { revenue: R0, growth: { c: c.growth, o: o.growth }, netMargin: { c: c.netMargin, o: o.netMargin }, futRev: { c: c.futRev, o: o.futRev }, futNi: { c: c.futNi, o: o.futNi } };
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `./node_modules/.bin/vitest run --project core test-core/valuation-segments.test.js`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add public/shared/valuation/segments.js test-core/valuation-segments.test.js
git commit -m "feat(valuation): segment aggregation for PE (sum-of-segments earnings)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 服务端放行卡片 segments(TDD)

**Files:**
- Modify: `src/items.js`(`validateValuations` 的 `out.push`)
- Test: `test/items.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/items.test.js` 的 `describe("validateItem with valuations", ...)` 块内追加:

```js
  it("keeps a segments object on the card", () => {
    const c2 = { id: "v1", method: "pe", inputs: {},
      segments: { enabled: true, rows: [{ name: "A", revenue: 120e8, growth: { c: 5, o: 9 }, netMargin: { c: 18, o: 20 } }] },
      low: 100, high: 200 };
    const r = validateItem({ ...base, valuations: [c2] });
    expect(r.ok).toBe(true);
    expect(r.value.valuations[0].segments.enabled).toBe(true);
    expect(r.value.valuations[0].segments.rows).toHaveLength(1);
  });
  it("coerces a non-object segments to {}", () => {
    const c2 = { id: "v1", method: "pe", inputs: {}, segments: "nope", low: 100, high: 200 };
    expect(validateItem({ ...base, valuations: [c2] }).value.valuations[0].segments).toEqual({});
  });
```

- [ ] **Step 2: 运行,确认失败**

Run: `./node_modules/.bin/vitest run --project worker test/items.test.js`
Expected: FAIL（`segments` undefined）

- [ ] **Step 3: 写实现**

在 `src/items.js` 的 `validateValuations` 中,`out.push({...})` 现为(含上一特性的 `derivations`):

```js
    out.push({ id: card.id, method: card.method, inputs: card.inputs, low, high,
      note: typeof card.note === "string" ? card.note.slice(0, 2000) : "",
      derivations: (card.derivations && typeof card.derivations === "object" && !Array.isArray(card.derivations)) ? card.derivations : {},
      updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : "" });
```

在 `derivations:` 行之后插入 `segments:` 行:

```js
    out.push({ id: card.id, method: card.method, inputs: card.inputs, low, high,
      note: typeof card.note === "string" ? card.note.slice(0, 2000) : "",
      derivations: (card.derivations && typeof card.derivations === "object" && !Array.isArray(card.derivations)) ? card.derivations : {},
      segments: (card.segments && typeof card.segments === "object" && !Array.isArray(card.segments)) ? card.segments : {},
      updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : "" });
```

(若实际文本略有差异,只在 `out.push` 对象里 `derivations` 之后加这一行 `segments:`。先读文件确认。)

- [ ] **Step 4: 运行,确认通过**

Run: `./node_modules/.bin/vitest run --project worker test/items.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/items.js test/items.test.js
git commit -m "feat(items): persist per-card PE segments

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 分部区 UI(PE 专属)— 浏览器验证

**Files:**
- Modify: `public/shared/valuation-ui.js`

PE 表单顶部加「分部加总」开关区;开启时分部表驱动 `revenue`/`growth`/`netMargin` 三字段(置只读、隐藏营收增速 ▾ 推导),实时写回 + 刷新结果。**不要做浏览器测试 — 控制器做。**

- [ ] **Step 1: import + mount 参数 + 状态**

文件顶部 import 区(已有 `import { derivationForMeta } from "/shared/valuation/derivations.js";`)后加:

```js
import { aggregateSegments } from "/shared/valuation/segments.js";
```

mount 签名加 `initialSegments`:

```js
export function mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, initialDerivations, initialSegments, refData, verdict, onDone, onCancel }) {
```

在 `const derivations = ...;` 那一行之后加:

```js
  const segments = (initialSegments && typeof initialSegments === "object" && Array.isArray(initialSegments.rows))
    ? JSON.parse(JSON.stringify(initialSegments)) : { enabled: false, rows: [] };
```

- [ ] **Step 2: onDone 带上 segments**

把 onDone 调用(含 `derivations: currentDerivations(),`)改为追加 `segments,`:

```js
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, derivations: currentDerivations(), segments, low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh), note: noteInput.value.trim() });
```

- [ ] **Step 3: 加 buildSegmentSection(在 renderForm 之前定义,与其它 build* 同级)**

在 `function renderForm() {` 之前插入:

```js
  function segNum(inp) { return inp.value !== "" ? Number(inp.value) : NaN; }
  // PE 分部加总区:开关 + 分部表,驱动 revenue/growth/netMargin 三字段
  function buildSegmentSection(fieldEls, recompute) {
    const wrap = el("div", "vc-seg");
    const head = el("div", "vc-seg-head");
    const title = el("span", "vc-seg-title"); title.textContent = lang === "zh" ? "分部加总" : "Segment build-up";
    const toggle = el("input", "vc-seg-toggle", { type: "checkbox" });
    const togLab = el("label", "vc-seg-togglab"); togLab.append(toggle, document.createTextNode(lang === "zh" ? " 启用" : " On"));
    head.append(title, togLab);
    const body = el("div", "vc-seg-body");
    const table = el("div", "vc-seg-rows");
    const addBtn = el("button", "vc-seg-add", { type: "button" }); addBtn.textContent = lang === "zh" ? "＋ 添加分部" : "＋ Add segment";
    const summary = el("div", "vc-seg-sum");
    body.append(table, addBtn, summary);
    wrap.append(head, body);

    let rowEls = [];
    const heads = lang === "zh" ? ["业务", "当前营收", "增速·保守", "增速·乐观", "净利率·保守", "净利率·乐观", ""] : ["Segment", "Revenue", "g·cons", "g·opt", "margin·cons", "margin·opt", ""];
    const colHead = el("div", "vc-seg-row vc-seg-colhead");
    heads.forEach((t) => { const c = el("div", "vc-seg-cell"); c.textContent = t; colHead.appendChild(c); });
    table.appendChild(colHead);

    const collect = () => rowEls.map((r) => ({ name: r.name.value, revenue: moneyVal(r.rev), growth: { c: segNum(r.gc), o: segNum(r.go) }, netMargin: { c: segNum(r.mc), o: segNum(r.mo) } }));

    function setDriven(on) {
      if (fieldEls.revenue) fieldEls.revenue.input.readOnly = on;
      if (fieldEls.growth) { fieldEls.growth.c.readOnly = on; fieldEls.growth.o.readOnly = on; const d = fieldEls.growth.arow.querySelector(".vc-deriv"); if (d) d.style.display = on ? "none" : ""; }
      if (fieldEls.netMargin) { fieldEls.netMargin.c.readOnly = on; fieldEls.netMargin.o.readOnly = on; }
      [fieldEls.revenue, fieldEls.growth, fieldEls.netMargin].forEach((fe) => { if (fe && fe.arow) fe.arow.classList.toggle("vc-driven", on); if (fe && fe.fld) fe.fld.classList.toggle("vc-driven", on); });
    }

    function recomputeSeg() {
      segments.rows = collect();
      const n = fieldEls.n ? segNum(fieldEls.n.input) : NaN;
      const agg = aggregateSegments(segments.rows, n);
      if (agg) {
        if (fieldEls.revenue) { fieldEls.revenue.input.value = fmtMoney(agg.revenue); fieldEls.revenue.input.dataset.raw = String(agg.revenue); }
        if (fieldEls.growth) { fieldEls.growth.c.value = String(round2(agg.growth.c)); fieldEls.growth.o.value = String(round2(agg.growth.o)); }
        if (fieldEls.netMargin) { fieldEls.netMargin.c.value = String(round2(agg.netMargin.c)); fieldEls.netMargin.o.value = String(round2(agg.netMargin.o)); }
        if (derivations.growth) delete derivations.growth;
        summary.textContent = lang === "zh"
          ? `合计营收 ${fmtMoney(agg.revenue)} · 合计净利 E 保守 ${fmtMoney(agg.futNi.c)} / 乐观 ${fmtMoney(agg.futNi.o)}`
          : `Total rev ${fmtMoney(agg.revenue)} · E cons ${fmtMoney(agg.futNi.c)} / opt ${fmtMoney(agg.futNi.o)}`;
      } else {
        summary.textContent = lang === "zh" ? "填写分部:当前营收 + 增速 + 净利率(并先填预测年数)" : "Add segments: revenue + growth + margin (set forecast years first)";
      }
      recompute();
    }

    function makeRow(seed) {
      const r = el("div", "vc-seg-row");
      const name = el("input", "vc-input vc-seg-name", { type: "text" }); name.placeholder = lang === "zh" ? "业务名" : "Segment"; if (seed && seed.name) name.value = seed.name;
      const rev = makeMoneyInput(seed && Number.isFinite(Number(seed.revenue)) ? Number(seed.revenue) : "");
      const gc = makeInput(seed && seed.growth ? seed.growth.c : ""), go = makeInput(seed && seed.growth ? seed.growth.o : "");
      const mc = makeInput(seed && seed.netMargin ? seed.netMargin.c : ""), mo = makeInput(seed && seed.netMargin ? seed.netMargin.o : "");
      const del = el("button", "vc-seg-del", { type: "button" }); del.textContent = "✕";
      const cell = (inp) => { const c = el("div", "vc-seg-cell"); c.appendChild(inp); return c; };
      [name, rev, gc, go, mc, mo].forEach((inp) => inp.addEventListener("input", recomputeSeg));
      r.append(cell(name), cell(rev), cell(gc), cell(go), cell(mc), cell(mo), del);
      const rec = { name, rev, gc, go, mc, mo, el: r };
      del.addEventListener("click", () => { rowEls = rowEls.filter((x) => x !== rec); r.remove(); recomputeSeg(); });
      table.appendChild(r); rowEls.push(rec); return rec;
    }

    addBtn.addEventListener("click", () => { makeRow(); recomputeSeg(); });
    if (fieldEls.n) fieldEls.n.input.addEventListener("input", () => { if (segments.enabled) recomputeSeg(); });

    function setEnabled(on) { segments.enabled = on; toggle.checked = on; body.style.display = on ? "" : "none"; setDriven(on); if (on) recomputeSeg(); else recompute(); }
    toggle.addEventListener("change", () => setEnabled(toggle.checked));

    if (segments.rows && segments.rows.length) segments.rows.forEach((row) => makeRow(row));
    setEnabled(!!segments.enabled);
    return wrap;
  }
```

- [ ] **Step 4: renderForm 内建 fieldEls 引用图**

在 `const recompute = () => compute(buildForm(readers));`(renderForm 内)之后加:

```js
    const fieldEls = {};
```

单字段循环里,在 `fld.append(lab, input);` 之后加:

```js
        fieldEls[field.k] = { input, fld };
```

双字段循环里,在 `arow.append(lab, inC, inO);` 之后加:

```js
        fieldEls[field.k] = { c: inC, o: inO, arow };
```

- [ ] **Step 5: renderForm 末尾为 PE 挂分部区**

把 renderForm 末尾的:

```js
    recompute();
  }
```

改为(在最终 `recompute()` 之前插入 PE 分部区):

```js
    if (model.key === "pe") {
      const segSection = buildSegmentSection(fieldEls, recompute);
      formWrap.insertBefore(segSection, formWrap.firstChild);
    }
    recompute();
  }
```

- [ ] **Step 6: 自检(不可 node 运行,grep 确认)**

Run: `grep -n "buildSegmentSection\|aggregateSegments\|initialSegments\|fieldEls\|vc-seg" public/shared/valuation-ui.js`
确认上述符号都在;重读 `buildSegmentSection` 与 renderForm 改动处,确认括号闭合、无重复定义。

- [ ] **Step 7: 提交**

```bash
git add public/shared/valuation-ui.js
git commit -m "feat(valuation): PE segment build-up section drives revenue/growth/margin

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 编辑器接线 + 样式 — 浏览器验证

**Files:**
- Modify: `public/index.html`(`showEditor` 的 `mountValuationCalc` 调用与 onDone;CSS)

- [ ] **Step 1: 透传 initialSegments + 存 segments**

`showEditor` 里 `mountValuationCalc(mountEl, valuationCtx(item), {` 选项中,`initialDerivations: card ? card.derivations : undefined,` 之后加一行:

```js
      initialSegments: card ? card.segments : undefined,
```

onDone 解构与两处写卡加 `segments`(现含 `derivations`):

```js
      onDone: ({ method, inputs, low, high, note, derivations, segments }) => {
        if (!Array.isArray(c.valuations)) c.valuations = [];
        if (card) {
          Object.assign(card, { method, inputs, low, high, note, derivations, segments, updatedAt: new Date().toISOString() });
          if (c.selectedValuationId === card.id) selectValuation(item, card, idBlock);
        } else {
          const fresh = { id: newValuationId(), method, inputs, low, high, note, derivations, segments, updatedAt: new Date().toISOString() };
          c.valuations.push(fresh);
          if (!c.selectedValuationId) selectValuation(item, fresh, idBlock);
        }
        saveItem(item); finishValEdit();
      },
```

- [ ] **Step 2: 加 CSS**

在 `.vc-deriv-tip{...}` 那条样式之后插入:

```css
  .vc-seg{border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:16px;background:var(--card)}
  .vc-seg-head{display:flex;align-items:center;justify-content:space-between}
  .vc-seg-title{font-size:13px;font-weight:600;color:#31679b}
  .vc-seg-togglab{font-size:12px;color:var(--ink-soft);display:inline-flex;align-items:center;gap:4px;cursor:pointer}
  .vc-seg-body{margin-top:10px;display:grid;gap:8px}
  .vc-seg-rows{display:grid;gap:6px}
  .vc-seg-row{display:grid;grid-template-columns:1.4fr 1.4fr 1fr 1fr 1fr 1fr auto;gap:6px;align-items:center}
  .vc-seg-colhead{font-size:11px;color:var(--ink-mute)}
  .vc-seg-cell{min-width:0}
  .vc-seg-cell .vc-input{width:100%}
  .vc-seg-del{appearance:none;background:none;border:0;color:var(--ink-mute);cursor:pointer;font-size:12px}
  .vc-seg-add{appearance:none;background:none;border:1px dashed var(--border);border-radius:6px;padding:6px 10px;font-size:12px;color:var(--ink-soft);cursor:pointer;width:fit-content}
  .vc-seg-sum{font-family:var(--mono);font-size:12px;color:var(--ink-soft);font-variant-numeric:tabular-nums}
  .vc-driven .vc-input{background:var(--accent);color:var(--ink-mute)}
```

- [ ] **Step 3: 提交**

```bash
git add public/index.html
git commit -m "feat(detail): wire PE segments through editor (persist + restore) + styles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 浏览器端到端验证 + 全量测试 + 部署(控制器执行)

- [ ] **Step 1: 程序化验证(挂载 PE + 分部驱动)**

在 `http://localhost:8787/b/demo` 控制台(chrome-devtools evaluate)挂载 PE 计算器,开启分部、填两个分部,断言三字段被驱动、结果有效:

```js
const m = await import('/shared/valuation-ui.js?seg=' + Date.now());
const host = document.createElement('div'); host.id='__seg'; document.body.appendChild(host);
m.mountValuationCalc(host, { shares: 1e9, price: 50, epsTtm: 3 },
  { lang:'zh', initialMethod:'pe', refData:{sources:{}}, verdict:()=>null, onDone(){}, onCancel(){} });
const seg = host.querySelector('.vc-seg');
seg.querySelector('.vc-seg-toggle').click();              // 启用
// 预测年数 n
const nInput = [...host.querySelectorAll('.vc-card input[type=number]')][0]; nInput.value='5'; nInput.dispatchEvent(new Event('input',{bubbles:true}));
seg.querySelector('.vc-seg-add').click();
const fill = (row, vals) => { const ins = row.querySelectorAll('input'); vals.forEach((v,i)=>{ ins[i].value=String(v); ins[i].dispatchEvent(new Event('input',{bubbles:true})); }); };
const rows = [...seg.querySelectorAll('.vc-seg-row')].filter(r=>!r.classList.contains('vc-seg-colhead'));
fill(rows[0], ['主力', '12000000000', 5, 9, 18, 20]);
const summary = seg.querySelector('.vc-seg-sum').textContent;
const out = { low: host.querySelector('.vc-rlow').textContent, high: host.querySelector('.vc-rhigh').textContent };
host.remove();
return { summary, out };
```
Expected: `summary` 含"合计营收 12.00B · 合计净利 E ...";`out.low/high` 为有限数(非 —)。

- [ ] **Step 2: 端到端(真实编辑器存档→重开还原)**

创建临时未估值标的 → 进详情「估值研究」→ 添加估值 → 选 PE → 启用分部、填 1-2 个分部、填预测年数与目标 PE → 保存。再 `/api/config?slug=demo` 确认该卡片 `segments.enabled===true` 且 `rows` 落库;重开卡片编辑确认分部表还原、三字段只读。完成后删除临时标的,保持 demo 4 只不变。

参考(创建+查存档+清理):
```js
// 创建
await fetch('/api/my/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticker:"NFLX",name:"奈飞",symbol:"usNFLX",fairLow:0,fairHigh:0,mos:30,ext:30,sortOrder:97,valuations:[],selectedValuationId:null})});
// …UI 操作后查:
await fetch('/api/config?slug=demo').then(r=>r.json()).then(j=>(j.items.find(i=>i.ticker==='NFLX').valuations||[]).map(v=>({m:v.method,seg:v.segments})));
```

- [ ] **Step 3: 全量测试**

Run: `./node_modules/.bin/vitest run`
Expected: 全绿(原有 + segments/items 新增)。

- [ ] **Step 4: 部署 + 冒烟**

```bash
./node_modules/.bin/wrangler deploy
curl -s "https://valuation-pendulum.jonyf176.workers.dev/shared/valuation/segments.js" -o /tmp/seg.js && grep -c aggregateSegments /tmp/seg.js
```
Expected: 部署成功;grep ≥ 1。

---

## 自查覆盖

- spec「仅 PE」→ Task 3 `if (model.key === "pe")`。
- 每分部 当前营收 + 增速{c,o} + 净利率{c,o} → Task 3 `makeRow`/`collect`;聚合 Task 1。
- 驱动 revenue/growth/netMargin + n 共用 → Task 3 `recomputeSeg`/`fieldEls`。
- ΣEᵢ × PE 精确 → Task 1 测试(回填重算 == ΣEᵢ)。
- 合计净利 E 汇总展示 → Task 3 `summary`(futNi)。
- 开关 + 只读"由分部得出" + 隐藏营收增速 ▾ 推导 → Task 3 `setEnabled`/`setDriven`;样式 `.vc-driven` Task 4。
- 持久化 + 还原 → Task 2(服务端)+ Task 3(还原 `segments.rows`)+ Task 4(接线)。
- 边界(不 FCFF/不分部级折现/不再拆行业份额提价)→ 未实现即不做,范围由 `model.key==="pe"` 与字段集合限定。
