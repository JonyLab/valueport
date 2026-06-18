# 估值输入「展开推导」框架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给估值编辑器的"假设型"双输入字段(折现率、营收增速、目标倍数)加可选的「展开推导」面板,把假设搭成可解释、可存档的分量。

**Architecture:** 新增 `valuation/derivations.js` 注册表(按字段 meta 挂载推导描述符);`valuation-ui.js` 据此在双字段下渲染 `▾ 推导` 折叠面板,推导结果写回字段保守/乐观两格,过程存进卡片 `derivations`;服务端放行该字段。两种形态:求和型(CAPM、营收增速)与锚点型(目标倍数,复用现有参考筹码)。

**Tech Stack:** 原生 ESM(无打包);vitest(core 项目跑纯逻辑);Cloudflare Workers + D1(`wrangler dev` localhost:8787);部署 `./node_modules/.bin/wrangler deploy`。

**关键约定(brainstorm 结论):** 每分量分保守|乐观→产出低~高写回双值;目标倍数用历史/同业分位重估(锚点);推导过程持久化。

**测试现实:** 本仓库 core 逻辑用 vitest 单测(`test-core/**`),worker 路由用 `test/**`;**UI(valuation-ui.js / index.html)无 DOM 单测,靠浏览器人工验证**。故纯逻辑任务走 TDD,UI 任务走浏览器验证。

---

## File Structure

- **Create** `public/shared/valuation/derivations.js` — 推导注册表 + compute + `derivationForMeta`。唯一职责:推导的"是什么/怎么算"。
- **Create** `test-core/valuation-derivations.test.js` — 纯逻辑单测。
- **Modify** `src/items.js` — `validateValuations` 放行卡片 `derivations` 对象。
- **Modify** `test/items.test.js` — derivations 存取用例。
- **Modify** `public/shared/valuation-ui.js` — 引入 `derivationForMeta`;mount 增 `initialDerivations`;onDone 带 `derivations`;双字段挂 `▾ 推导` 面板(求和型 + 锚点型);写回/解除/还原。
- **Modify** `public/index.html` — `showEditor` 透传 `initialDerivations`、onDone 存 `derivations`;`.vc-deriv*` 样式。

---

## Task 1: 推导注册表与计算(纯逻辑,TDD)

**Files:**
- Create: `public/shared/valuation/derivations.js`
- Test: `test-core/valuation-derivations.test.js`

- [ ] **Step 1: 写失败测试**

Create `test-core/valuation-derivations.test.js`:

```js
import { describe, it, expect } from "vitest";
import { CAPM, REV_GROWTH, derivationForMeta } from "../public/shared/valuation/derivations.js";

describe("CAPM derivation", () => {
  it("股权成本 = Rf + β×ERP", () => {
    expect(CAPM.compute({ rf: 3, beta: 1.2, erp: 5 }, { meta: "costOfEquity" })).toBeCloseTo(9);
  });
  it("WACC 按股权权重混合税后债务成本", () => {
    // Ke = 3 + 1×5 = 8;ew=80% → 0.8×8 + 0.2×3 = 7
    expect(CAPM.compute({ rf: 3, beta: 1, erp: 5, kd: 3, ew: 80 }, { meta: "wacc" })).toBeCloseTo(7);
  });
  it("costOfEquity 口径忽略债务段", () => {
    expect(CAPM.compute({ rf: 3, beta: 1, erp: 5, kd: 99, ew: 0 }, { meta: "costOfEquity" })).toBeCloseTo(8);
  });
  it("componentsFor 仅 wacc 显示债务行", () => {
    expect(CAPM.componentsFor("costOfEquity").map((c) => c.key)).toEqual(["rf", "beta", "erp"]);
    expect(CAPM.componentsFor("wacc").map((c) => c.key)).toEqual(["rf", "beta", "erp", "kd", "ew"]);
  });
});

describe("revenue-growth derivation", () => {
  it("行业+份额+提价 求和", () => {
    expect(REV_GROWTH.compute({ industry: 4, share: 1, price: 2 })).toBeCloseTo(7);
  });
  it("空值按 0 处理", () => {
    expect(REV_GROWTH.compute({ industry: 8 })).toBeCloseTo(8);
  });
});

describe("derivationForMeta", () => {
  it("字段 meta → 推导", () => {
    expect(derivationForMeta("wacc").id).toBe("capm");
    expect(derivationForMeta("costOfEquity").id).toBe("capm");
    expect(derivationForMeta("revGrowth").id).toBe("revGrowth");
    expect(derivationForMeta("targetPE").id).toBe("multipleAnchor");
    expect(derivationForMeta("targetMultiple").id).toBe("multipleAnchor");
    expect(derivationForMeta("netDebt")).toBe(null);
  });
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `./node_modules/.bin/vitest run --project core test-core/valuation-derivations.test.js`
Expected: FAIL（`Failed to resolve import ".../derivations.js"`）

- [ ] **Step 3: 写实现**

Create `public/shared/valuation/derivations.js`:

```js
/**
 * valuation/derivations.js — 估值「假设型」输入的展开推导注册表。
 * 按字段 meta 挂载;valuation-ui 据此渲染 ▾ 推导 面板。
 *   shape "sum"   : 分量求和（各分量分保守|乐观）,compute(parts,{meta}) → 单情景值
 *   shape "anchor": 锚点引导（目标倍数）,无 compute,面板复用 fieldReference 锚点筹码
 */
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export const CAPM = {
  id: "capm", shape: "sum", appliesToMeta: ["wacc", "costOfEquity"],
  components: [
    { key: "rf",   label: { zh: "无风险利率", en: "Risk-free rate" }, unit: "%", default: 3 },
    { key: "beta", label: { zh: "β（贝塔）", en: "Beta" }, unit: "", default: 1 },
    { key: "erp",  label: { zh: "股权风险溢价", en: "Equity risk premium" }, unit: "%", default: 5 },
    { key: "kd",   label: { zh: "税后债务成本", en: "After-tax cost of debt" }, unit: "%", default: 3, debtOnly: true },
    { key: "ew",   label: { zh: "股权权重", en: "Equity weight" }, unit: "%", default: 100, debtOnly: true },
  ],
  componentsFor(meta) { return this.components.filter((c) => meta === "wacc" || !c.debtOnly); },
  compute(parts, opts) {
    const ke = num(parts.rf) + num(parts.beta) * num(parts.erp);
    if (opts && opts.meta === "wacc") {
      const ew = num(parts.ew) / 100;
      return ke * ew + num(parts.kd) * (1 - ew);
    }
    return ke;
  },
};

export const REV_GROWTH = {
  id: "revGrowth", shape: "sum", appliesToMeta: ["revGrowth"],
  components: [
    { key: "industry", label: { zh: "行业增速", en: "Industry growth" }, unit: "%", default: "", hint: { zh: "该品类/行业的市场增速（β）", en: "Category/market growth (β)" } },
    { key: "share",    label: { zh: "份额贡献", en: "Share gain" }, unit: "%", default: "", hint: { zh: "抢/丢市场份额带来的增减（α）", en: "From gaining/losing share (α)" } },
    { key: "price",    label: { zh: "提价/结构", en: "Price / mix" }, unit: "%", default: "", hint: { zh: "提价与产品结构升级带来的增量", en: "Price hikes and mix upgrade" } },
  ],
  componentsFor() { return this.components; },
  compute(parts) { return num(parts.industry) + num(parts.share) + num(parts.price); },
};

export const MULTIPLE_ANCHOR = {
  id: "multipleAnchor", shape: "anchor",
  appliesToMeta: ["targetPE", "targetPB", "targetPS", "targetMultiple"],
};

const ALL = [CAPM, REV_GROWTH, MULTIPLE_ANCHOR];

export function derivationForMeta(meta) {
  return ALL.find((d) => d.appliesToMeta.includes(meta)) || null;
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `./node_modules/.bin/vitest run --project core test-core/valuation-derivations.test.js`
Expected: PASS（11 个断言）

- [ ] **Step 5: 提交**

```bash
git add public/shared/valuation/derivations.js test-core/valuation-derivations.test.js
git commit -m "feat(valuation): derivation registry (CAPM / revenue growth / multiple anchor)"
```

---

## Task 2: 服务端放行卡片 derivations(TDD)

**Files:**
- Modify: `src/items.js`(`validateValuations`,约 5-21 行)
- Test: `test/items.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/items.test.js` 的 `describe("validateItem with valuations", ...)` 块内追加：

```js
  it("keeps a derivations object on the card", () => {
    const card = { id: "v1", method: "fcff", inputs: { wacc: { c: 9, o: 8 } },
      derivations: { wacc: { method: "capm", parts: { rf: { c: 3, o: 3 }, beta: { c: 1, o: 1 }, erp: { c: 5, o: 5 } } } },
      low: 100, high: 200 };
    const r = validateItem({ ...base, valuations: [card], selectedValuationId: "v1" });
    expect(r.ok).toBe(true);
    expect(r.value.valuations[0].derivations.wacc.method).toBe("capm");
  });
  it("coerces a non-object derivations to {}", () => {
    const card = { id: "v1", method: "fcff", inputs: {}, derivations: "nope", low: 100, high: 200 };
    const r = validateItem({ ...base, valuations: [card] });
    expect(r.ok).toBe(true);
    expect(r.value.valuations[0].derivations).toEqual({});
  });
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `./node_modules/.bin/vitest run --project worker test/items.test.js`
Expected: FAIL（`derivations` 为 undefined）

- [ ] **Step 3: 写实现**

在 `src/items.js` 的 `validateValuations` 里,`out.push({...})` 改为带 `derivations`：

```js
    out.push({ id: card.id, method: card.method, inputs: card.inputs, low, high,
      note: typeof card.note === "string" ? card.note.slice(0, 2000) : "",
      derivations: (card.derivations && typeof card.derivations === "object" && !Array.isArray(card.derivations)) ? card.derivations : {},
      updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : "" });
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `./node_modules/.bin/vitest run --project worker test/items.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/items.js test/items.test.js
git commit -m "feat(items): persist per-card valuation derivations"
```

---

## Task 3: 求和型推导面板(CAPM / 营收增速)— 浏览器验证

**Files:**
- Modify: `public/shared/valuation-ui.js`

实现"▾ 推导"折叠 + 求和子面板:每分量一行(标签 + 保守 + 乐观),编辑任一分量即重算并写回字段双格、存进 `derivations`;手动改字段两格则解除推导;已存档则还原并展开。

**写回/计算规则(避免静默覆盖):** 只在 (a) 还原存档、(b) 用户编辑了某个分量 时才写回 inC/inO。仅打开面板不写。

- [ ] **Step 1: 引入依赖 + mount 参数 + 状态**

`public/shared/valuation-ui.js` 第 10-11 行的 import 后追加：

```js
import { derivationForMeta } from "/shared/valuation/derivations.js";
```

把 mount 签名(第 69 行)改为带 `initialDerivations`：

```js
export function mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, initialDerivations, refData, verdict, onDone, onCancel }) {
```

在 `let lastLow = null, lastHigh = null, lastForm = {};`(约 73 行)之后追加状态与小工具：

```js
  const derivations = (initialDerivations && typeof initialDerivations === "object") ? JSON.parse(JSON.stringify(initialDerivations)) : {};
  const round2 = (n) => Math.round(n * 100) / 100;
  // 仅保留当前模型字段的推导,存档时用
  function currentDerivations() {
    const model = MODELS[activeIdx]; if (!model) return {};
    const keys = new Set((model.fields || []).map((f) => f.k));
    const out = {}; for (const k in derivations) if (keys.has(k)) out[k] = derivations[k];
    return out;
  }
```

- [ ] **Step 2: onDone 带上 derivations**

第 131 行 onDone 调用改为：

```js
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, derivations: currentDerivations(), low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh), note: noteInput.value.trim() });
```

- [ ] **Step 3: 加求和面板构件**

在 `buildRefRow` 函数定义之后(约第 265 行 `}` 之后)插入：

```js
  // 「▾ 推导」折叠 + 子面板;写回 inC/inO 并维护 derivations[field.k]
  function derivToggleText(open) { return (open ? "▴ " : "▾ ") + (lang === "zh" ? "推导" : "Derive"); }
  function buildDerivation(field, deriv, inC, inO, recompute) {
    const wrap = el("div", "vc-deriv"); wrap.style.gridColumn = "1 / -1";
    const toggle = el("button", "vc-deriv-toggle", { type: "button" });
    const bodyBox = el("div", "vc-deriv-body");
    let open = false;
    const sync = () => { toggle.textContent = derivToggleText(open); bodyBox.style.display = open ? "" : "none"; };
    toggle.addEventListener("click", () => { open = !open; sync(); });
    wrap.append(toggle, bodyBox);
    if (deriv.shape === "sum") buildSumPanel(field, deriv, inC, inO, recompute, bodyBox);
    else buildAnchorPanel(field, inC, inO, recompute, bodyBox);
    if (derivations[field.k]) open = true; // 有存档默认展开
    sync();
    return wrap;
  }
  function buildSumPanel(field, deriv, inC, inO, recompute, bodyBox) {
    const comps = deriv.componentsFor(field.meta);
    const saved = (derivations[field.k] && derivations[field.k].parts) || {};
    const rows = comps.map((comp) => {
      const r = el("div", "vc-arow");
      const lab = el("div", "vc-label");
      const span = el("span"); span.textContent = (comp.label && comp.label[lang]) || comp.key; lab.appendChild(span);
      if (comp.unit === "%") { const u = el("span", "vc-unit"); u.textContent = "%"; lab.appendChild(u); }
      const sc = saved[comp.key] || {};
      const ic = makeInput(sc.c ?? comp.default), io = makeInput(sc.o ?? comp.default);
      ic.addEventListener("input", apply); io.addEventListener("input", apply);
      r.append(lab, ic, io); bodyBox.appendChild(r);
      return { comp, ic, io };
    });
    const out = el("div", "vc-deriv-out"); bodyBox.appendChild(out);
    const read = (which) => { const p = {}; rows.forEach(({ comp, ic, io }) => { const s = (which === "c" ? ic : io).value; p[comp.key] = s !== "" ? Number(s) : NaN; }); return p; };
    function apply() {
      const vc = deriv.compute(read("c"), { meta: field.meta });
      const vo = deriv.compute(read("o"), { meta: field.meta });
      const parts = {}; rows.forEach(({ comp, ic, io }) => { parts[comp.key] = { c: ic.value !== "" ? Number(ic.value) : "", o: io.value !== "" ? Number(io.value) : "" }; });
      derivations[field.k] = { method: deriv.id, parts };
      inC.value = Number.isFinite(vc) ? String(round2(vc)) : "";
      inO.value = Number.isFinite(vo) ? String(round2(vo)) : "";
      out.textContent = `= ${tx("conservative")} ${fmt(vc, tx("dash"))} / ${tx("optimistic")} ${fmt(vo, tx("dash"))}`;
      recompute();
    }
    if (derivations[field.k]) apply(); // 还原存档:回填字段 + 展示
  }
```

(`buildAnchorPanel` 在 Task 4 定义;本任务先放一个占位以免引用未定义。)在 `buildSumPanel` 之后追加临时占位：

```js
  function buildAnchorPanel(field, inC, inO, recompute, bodyBox) { /* Task 4 实现 */ }
```

- [ ] **Step 4: 双字段循环挂上推导 + 解除逻辑**

把 `renderForm` 里 `duals.forEach((field) => {...})`(约 374-386 行)整体替换为(解除时**就地复位面板**,不整页重渲染,避免丢失其它字段已输入值)：

```js
      duals.forEach((field) => {
        const arow = el("div", "vc-arow");
        const { lab, guideRow } = buildLabel(field);
        const init = dualInit(field);
        const inC = makeInput(init.c), inO = makeInput(init.o);
        readers.push({ field, getVal: () => ({ c: inC.value !== "" ? Number(inC.value) : NaN, o: inO.value !== "" ? Number(inO.value) : NaN }) });
        const deriv = derivationForMeta(field.meta);
        let derivEl = null;
        // 手动改字段两格 ⇒ 解除该字段推导,就地复位面板(与卡片选区间的解除一致)
        const onEdit = () => {
          if (deriv && derivations[field.k]) {
            delete derivations[field.k];
            if (derivEl) { derivEl.remove(); derivEl = buildDerivation(field, deriv, inC, inO, recompute); arow.appendChild(derivEl); }
          }
          recompute();
        };
        inC.addEventListener("input", onEdit); inO.addEventListener("input", onEdit);
        arow.append(lab, inC, inO);
        // 锚点型:参考筹码进推导面板;其余:筹码照旧在字段下
        const anchorType = deriv && deriv.shape === "anchor";
        if (!anchorType) {
          const refRow = buildRefRow(field, (v) => { inC.value = String(v); inO.value = String(v); recompute(); }, (lo, hi) => { inC.value = String(lo); inO.value = String(hi); recompute(); });
          if (refRow) { refRow.style.gridColumn = "2 / -1"; arow.appendChild(refRow); }
        }
        if (guideRow) { guideRow.style.gridColumn = "1 / -1"; arow.appendChild(guideRow); }
        if (deriv) { derivEl = buildDerivation(field, deriv, inC, inO, recompute); arow.appendChild(derivEl); }
        card.appendChild(arow);
      });
```

> 注:`apply()` 写回时直接设 `inC.value`(不派发 input 事件),故不会触发 `onEdit` 的解除——只有用户真正键入才解除。

- [ ] **Step 5: 浏览器验证(CAPM + 营收增速)**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/   # 期望 200
```

用 chrome-devtools 打开 `http://localhost:8787/b/demo/AAPL` →「估值研究」→「＋ 添加估值」→ 选 `FCFF 两阶段`：
- WACC 行下出现 `▾ 推导`;展开 → 5 行(无风险利率/β/股权风险溢价/税后债务成本/股权权重),各有保守|乐观;
- 把保守列 Rf=3.5、β=1.1、ERP=5.5、Kd=3、股权权重=80 → 面板底显示 `= 保守 ... / 乐观 ...`,且 WACC 字段两格被写入;右侧结果卡随之更新;
- 营收增速行下 `▾ 推导` 展开 → 3 行(行业/份额/提价),填 4/1/2 → 营收增速写回 7;
- 手动改 WACC 保守格任一数字 → 推导面板收起复位(解除)。

记录:截图确认。无 console error。

- [ ] **Step 6: 提交**

```bash
git add public/shared/valuation-ui.js
git commit -m "feat(valuation): sum-type derivation panel (CAPM / revenue growth) with write-back + detach"
```

---

## Task 4: 锚点型推导面板(目标倍数)— 浏览器验证

**Files:**
- Modify: `public/shared/valuation-ui.js`(`buildAnchorPanel` 占位)

把目标倍数字段(targetPE/PB/PS/targetMultiple)的参考锚点收进 `▾ 推导` 面板:面板内放 `buildRefRow`(套用区间 + 当前/自身5年均/行业中位 一键套用)+ 一句口径提示。targetMultiple 无 ref 数据则只显示提示。

- [ ] **Step 1: 实现 buildAnchorPanel**

把 Task 3 里的占位 `buildAnchorPanel` 替换为：

```js
  function buildAnchorPanel(field, inC, inO, recompute, bodyBox) {
    const tip = el("div", "vc-deriv-tip");
    tip.textContent = lang === "zh" ? "锚定当前 / 自身历史 / 行业中位,定保守与乐观目标。" : "Anchor to current / own history / industry median; set conservative & optimistic targets.";
    bodyBox.appendChild(tip);
    const refRow = buildRefRow(field,
      (v) => { inC.value = String(v); inO.value = String(v); recompute(); },
      (lo, hi) => { inC.value = String(lo); inO.value = String(hi); recompute(); });
    if (refRow) bodyBox.appendChild(refRow);
  }
```

- [ ] **Step 2: 浏览器验证(目标倍数)**

chrome-devtools:`http://localhost:8787/b/demo/AAPL` →「添加估值」→ 选 `PE 估值`：
- 目标 PE 行下有 `▾ 推导`;展开 → 提示句 + 套用区间/当前/自身5年均/行业中位 筹码(有数据时);点筹码 → 目标 PE 两格被写入;
- 选 `EV/EBITDA 估值` → 目标倍数行下 `▾ 推导` 仅显示提示句(无 ref 数据),不报错。

记录:截图确认。无 console error。

- [ ] **Step 3: 提交**

```bash
git add public/shared/valuation-ui.js
git commit -m "feat(valuation): anchor-type derivation panel for target multiples"
```

---

## Task 5: 编辑器接线 + 样式 + 端到端存档还原 — 浏览器验证

**Files:**
- Modify: `public/index.html`(`showEditor` 的 `mountValuationCalc` 调用与 `onDone`;CSS)

- [ ] **Step 1: showEditor 透传 initialDerivations + 存 derivations**

在 `public/index.html` 的 `showEditor` 内 `mountValuationCalc(mountEl, valuationCtx(item), {...})` 调用里：
- `initialInputs: card ? card.inputs : undefined,` 之后加一行：

```js
      initialDerivations: card ? card.derivations : undefined,
```

- `onDone` 的解构与写卡改为带 `derivations`：

```js
      onDone: ({ method, inputs, low, high, note, derivations }) => {
        if (!Array.isArray(c.valuations)) c.valuations = [];
        if (card) {
          Object.assign(card, { method, inputs, low, high, note, derivations, updatedAt: new Date().toISOString() });
          if (c.selectedValuationId === card.id) selectValuation(item, card, idBlock);
        } else {
          const fresh = { id: newValuationId(), method, inputs, low, high, note, derivations, updatedAt: new Date().toISOString() };
          c.valuations.push(fresh);
          if (!c.selectedValuationId) selectValuation(item, fresh, idBlock);
        }
        saveItem(item); finishValEdit();
      },
```

- [ ] **Step 2: 加 CSS**

在 `public/index.html` 的 `.vc-empty-method{...}` 那条样式(约 296 行)之后插入：

```css
  .vc-deriv{margin-top:8px}
  .vc-deriv-toggle{appearance:none;background:none;border:0;padding:0;cursor:pointer;font-size:12px;color:#31679b;font-weight:600}
  .vc-deriv-body{margin-top:8px;padding:12px;border:1px dashed var(--border);border-radius:6px;background:var(--card);display:grid;gap:8px}
  .vc-deriv-out{font-family:var(--mono);font-size:12px;color:var(--ink-soft);font-variant-numeric:tabular-nums;padding-top:2px}
  .vc-deriv-tip{font-size:12px;color:var(--ink-mute);line-height:1.6}
```

- [ ] **Step 3: 端到端验证(存档 → 重开还原)**

chrome-devtools:`http://localhost:8787/b/demo/AAPL` →「添加估值」→ `现金流折现`:
- 折现率 `▾ 推导` 展开,填保守 Rf3.5/β1.1/ERP5.5/Kd3/股权权重80、乐观 Rf3/β1/ERP5/Kd3/股权权重100;
- 填好其它必填项使结果有效 → 点「保存」;
- 回到估值卡列表 → 该卡存在 → 点「编辑」重开 → 折现率推导面板**自动展开且分量被还原**(保守 3.5/1.1/5.5/3/80),折现率两格 = 还原后的计算值。

用 evaluate 核对落库(确认 derivations 进了 D1)：

```js
// 在 /b/demo 控制台:取 AAPL 卡片的 derivations
await fetch('/api/config?slug=demo').then(r=>r.json())
  .then(j => (j.items.find(i=>i.ticker==='AAPL').valuations||[]).map(v=>({m:v.method, d:v.derivations})));
```
Expected: 能看到 `derivations: { discount: { method:"capm", parts:{ rf:{c:3.5,o:3}, ... } } }`。

> 注意:验证用的临时卡片,验证完删除,保持 demo 数据干净(AAPL 复原成 136.9–170.97 + PE 卡)。

- [ ] **Step 4: 提交**

```bash
git add public/index.html
git commit -m "feat(detail): wire valuation derivations through the editor (restore + persist) + styles"
```

---

## Task 6: 全量测试 + 部署

- [ ] **Step 1: 跑全量测试**

Run: `./node_modules/.bin/vitest run`
Expected: 全绿(原有 + 新增 derivations/items 用例)。

- [ ] **Step 2: 部署**

Run: `./node_modules/.bin/wrangler deploy`
Expected: `Deployed valuation-pendulum`,记下 Version ID。

- [ ] **Step 3: 生产冒烟**

```bash
curl -s "https://valuation-pendulum.jonyf176.workers.dev/shared/valuation/derivations.js" | grep -c "MULTIPLE_ANCHOR"
```
Expected: ≥1。

---

## 自查覆盖

- spec ①折现率(CAPM,含债务/纯股权)→ Task 1(compute)+ Task 3(面板);②营收增速 → Task 1 + Task 3;③目标倍数(锚点)→ Task 1(描述符)+ Task 4(面板)。
- 每分量分保守|乐观、写回双值 → Task 3 `buildSumPanel.apply`。
- 持久化 + 还原 → Task 2(服务端)+ Task 3(还原)+ Task 5(接线/端到端)。
- 手动改解除 → Task 3 Step 5。
- 字段挂载映射(wacc/costOfEquity/revGrowth/target*)→ `appliesToMeta` + `derivationForMeta`(Task 1 测试覆盖)。
- 双语 → 描述符 label/hint(zh/en)+ 面板文案 lang 分支。
