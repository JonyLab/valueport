# Valuation Param Guidance + References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every valuation input two layers of help — clickable reference-data chips (from financial series + industry valuation distribution) and an ⓘ "how to estimate" guidance popover.

**Architecture:** All guidance content + reference-computation logic live in one new pure module `public/shared/field-meta.js` (`FIELD_META` keyed by a `meta` tag + `fieldReference()`); model fields just carry `meta:"<tag>"`. The server adds industry valuation refs to the existing `/api/financials` annual response; the editor renders ⓘ + chips from `FIELD_META`.

**Tech Stack:** Cloudflare Workers + WebCrypto + fetch; vanilla ESM frontend; vitest (`core` + `worker`).

Spec: `docs/superpowers/specs/2026-06-17-valuation-param-guidance-design.md`. Endpoints/shapes confirmed live.

---

### Task 1: Industry valuation refs in `src/longbridge.js` (TDD on the pure combiner)

**Files:**
- Modify: `src/longbridge.js` (add parsers + `buildValuationRefs` exported pure + two signed fetchers; place after `fetchLongbridgeFinancials`)
- Test: `test-core/valuation-refs.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test-core/valuation-refs.test.js`:

```js
import { describe, it, expect } from "vitest";
import { buildValuationRefs } from "../src/longbridge.js";

describe("buildValuationRefs", () => {
  const dist = { pe: { value: 35.86, median: 26.37 }, pb: { value: 41.27, median: 2.18 }, ps: { value: 9.74, median: 0.85 } };
  const comp = { pe: [30, 32, 34, 40, 28, 31], pb: [38, 39, 40, 41], ps: [6, 7, 7.5, 9] };
  it("combines current/own5y(median)/industryMedian per multiple", () => {
    const r = buildValuationRefs(dist, comp);
    expect(r.pe.current).toBeCloseTo(35.86, 2);
    expect(r.pe.industryMedian).toBeCloseTo(26.37, 2);
    expect(r.pe.own5y).toBeCloseTo(31.5, 1); // median of [28,30,31,32,34,40] = (31+32)/2
  });
  it("returns null when nothing usable", () => {
    expect(buildValuationRefs(null, null)).toBe(null);
  });
  it("tolerates missing own history (own5y null)", () => {
    const r = buildValuationRefs(dist, null);
    expect(r.pe.own5y).toBe(null);
    expect(r.pe.current).toBeCloseTo(35.86, 2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project core test-core/valuation-refs.test.js`
Expected: FAIL — `buildValuationRefs is not a function`.

- [ ] **Step 3: Implement in `src/longbridge.js`**

Add, immediately after the `fetchLongbridgeFinancials` function:

```js
/* ---------- 行业估值参考（PE/PB/PS：当前 / 自身5年均 / 行业中位） ---------- */
function _median(arr) {
  const a = (arr || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// industry-valuation-distribution → { pe:{value,median}, pb:{...}, ps:{...} } | null
export function parseValuationDist(json) {
  if (!json || json.code !== 0 || !json.data) return null;
  const out = {};
  for (const m of ["pe", "pb", "ps"]) {
    const d = json.data[m];
    if (!d) continue;
    out[m] = { value: parseFloat(d.value), median: parseFloat(d.median) };
  }
  return Object.keys(out).length ? out : null;
}

// industry-valuation-comparison → 自身（首条）history → { pe:[...], pb:[...], ps:[...] } | null
export function parseIndustryComp(json) {
  if (!json || json.code !== 0 || !json.data || !Array.isArray(json.data.list) || !json.data.list.length) return null;
  const self = json.data.list[0];
  const hist = Array.isArray(self.history) ? self.history : [];
  if (!hist.length) return null;
  return {
    pe: hist.map((h) => parseFloat(h.pe)),
    pb: hist.map((h) => parseFloat(h.pb)),
    ps: hist.map((h) => parseFloat(h.ps)),
  };
}

// 合成参考：current=dist.value，industryMedian=dist.median，own5y=最近~20季 history 的中位
export function buildValuationRefs(dist, comp) {
  const out = {}; let any = false;
  for (const m of ["pe", "pb", "ps"]) {
    const current = dist && dist[m] && Number.isFinite(dist[m].value) ? dist[m].value : null;
    const industryMedian = dist && dist[m] && Number.isFinite(dist[m].median) ? dist[m].median : null;
    const own5y = comp && comp[m] ? _median(comp[m].slice(-20)) : null;
    if (current != null || industryMedian != null || own5y != null) { out[m] = { current, own5y, industryMedian }; any = true; }
  }
  return any ? out : null;
}

export async function fetchValuationRefs(env, tencentSymbol) {
  const lp = tencentToLongport(tencentSymbol);
  if (!lp) return null;
  const q = `counter_id=${symbolToCounterId(lp)}`;
  try {
    const [distJson, compJson] = await Promise.all([
      signedGet(env, "/v1/quote/industry-valuation-distribution", q),
      signedGet(env, "/v1/quote/industry-valuation-comparison", q),
    ]);
    return buildValuationRefs(parseValuationDist(distJson), parseIndustryComp(compJson));
  } catch { return null; }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project core test-core/valuation-refs.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/longbridge.js test-core/valuation-refs.test.js
git commit -m "feat(longbridge): industry valuation refs (current/own5y/industry-median)"
```

---

### Task 2: Add `valuationRefs` to the `/api/financials` annual response

**Files:**
- Modify: `src/index.js` (import `fetchValuationRefs`; extend the `/api/financials` handler)

- [ ] **Step 1: Add the import**

In `src/index.js`, add `fetchValuationRefs` to the existing `./longbridge.js` import (the line that already imports `fetchLongbridgeFinancials, pickLatestAnnual`).

- [ ] **Step 2: Extend the route**

Replace the body of the `app.get("/api/financials", ...)` handler with:

```js
app.get("/api/financials", async (c) => {
  const symbol = (c.req.query("symbol") || "").trim();
  const isAnnual = c.req.query("period") !== "quarter";
  const report = isAnnual ? "af" : "qf";
  const haveCreds = c.env.LONGBRIDGE_APP_KEY && c.env.LONGBRIDGE_APP_SECRET && c.env.LONGBRIDGE_ACCESS_TOKEN;
  let financials = null, valuationRefs = null;
  if (symbol && haveCreds) {
    try {
      if (isAnnual) {
        const [f, vr] = await Promise.all([fetchLongbridgeFinancials(c.env, symbol, report), fetchValuationRefs(c.env, symbol)]);
        financials = f; valuationRefs = vr;
      } else {
        financials = await fetchLongbridgeFinancials(c.env, symbol, report);
      }
    } catch (e) { console.error("financials failed:", e && e.message); financials = null; }
  }
  c.header("Cache-Control", "public, max-age=86400");
  return c.json({ financials, latest: pickLatestAnnual(financials), valuationRefs });
});
```

- [ ] **Step 3: Verify worker tests still pass**

Run: `npx vitest run --project worker test/routes.test.js`
Expected: PASS (existing financials route cases unaffected; `valuationRefs` is an added key).

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "feat(api): include industry valuationRefs in /api/financials annual"
```

---

### Task 3: `public/shared/field-meta.js` — guidance content + reference resolver (TDD)

**Files:**
- Create: `public/shared/field-meta.js`
- Test: `test-core/field-meta.test.js`

- [ ] **Step 1: Write the failing test**

Create `test-core/field-meta.test.js`:

```js
import { describe, it, expect } from "vitest";
import { FIELD_META, fieldReference } from "../public/shared/field-meta.js";

const data = {
  financials: {
    IS: [
      { field: "OperatingRevenue", values: [{ value: 416 }, { value: 391 }, { value: 383 }, { value: 394 }, { value: 366 }, { value: 275 }] },
      { field: "NetProfit", values: [{ value: 112 }, { value: 94 }, { value: 97 }, { value: 100 }, { value: 95 }] },
      { field: "OperatingIncome", values: [{ value: 133 }, { value: 123 }] },
      { field: "NetProfitMargin", values: [{ value: 26.9 }, { value: 24 }, { value: 25.3 }, { value: 25.3 }, { value: 25.9 }] },
    ],
    CF: [{ field: "NetFreeCashFlow", values: [{ value: 90 }, { value: 80 }] }],
  },
  valuationRefs: { pe: { current: 35.9, own5y: 31.2, industryMedian: 26.4 }, pb: {}, ps: {} },
};

describe("FIELD_META", () => {
  it("has bilingual guides for key tags", () => {
    for (const tag of ["revGrowth", "opMargin", "wacc", "termGrowth", "targetPE", "reinvest"]) {
      expect(FIELD_META[tag]).toBeTruthy();
      expect(FIELD_META[tag].guide.zh.length).toBeGreaterThan(4);
      expect(FIELD_META[tag].guide.en.length).toBeGreaterThan(4);
    }
  });
});

describe("fieldReference", () => {
  it("revGrowth → latest YoY + 5y avg", () => {
    const r = fieldReference("revGrowth", data, {}, "zh");
    expect(r.unit).toBe("%");
    expect(r.chips[0].value).toBeCloseTo((416 - 391) / 391 * 100, 1);
    expect(r.chips.length).toBe(2);
  });
  it("netMargin → latest + 5y avg", () => {
    const r = fieldReference("netMargin", data, {}, "zh");
    expect(r.chips[0].value).toBeCloseTo(26.9, 1);
  });
  it("opMargin → OI/OR aligned", () => {
    const r = fieldReference("opMargin", data, {}, "zh");
    expect(r.chips[0].value).toBeCloseTo(133 / 416 * 100, 1);
  });
  it("pe → current/own5y/industryMedian chips", () => {
    const r = fieldReference("pe", data, {}, "zh");
    expect(r.unit).toBe("x");
    expect(r.chips.map((c) => c.value)).toEqual([35.9, 31.2, 26.4]);
  });
  it("returns null when data missing", () => {
    expect(fieldReference("revGrowth", { financials: null }, {}, "zh")).toBe(null);
    expect(fieldReference("pb", data, {}, "zh")).toBe(null); // pb has no usable values
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project core test-core/field-meta.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `public/shared/field-meta.js`**

```js
/**
 * field-meta.js — 估值参数的「估值提示(guide)」内容 + 「参考数据(fieldReference)」计算。
 * 纯模块，无 DOM。模型字段通过 meta:"<tag>" 关联到这里。
 */

// 各字段的提示文案与参考标签（ref 为空=仅提示无数据参考）
export const FIELD_META = {
  revenue: { guide: { zh: "公司总营收（非每股）。已用最近年报预填，可改成你的预期口径。", en: "Total company revenue (not per share). Prefilled from the latest annual report; adjust to your estimate." } },
  netIncome: { guide: { zh: "公司净利润总额（非每股）。已用最近年报预填。", en: "Total net income (not per share). Prefilled from the latest annual report." } },
  netDebt: { guide: { zh: "有息负债−现金。已用最近年报预填；负值=净现金。", en: "Interest-bearing debt minus cash. Prefilled; negative means net cash." } },
  dps: { guide: { zh: "每股股利。已按现价×股息率预填，可改成你预期的每股分红。", en: "Dividend per share. Prefilled from price×yield; adjust to your expected payout." } },
  eps: { guide: { zh: "每股收益，已用 TTM 预填。", en: "Earnings per share, prefilled with TTM." } },
  bps: { guide: { zh: "每股净资产，已用最近年报预填。", en: "Book value per share, prefilled from the latest annual report." } },
  ebitda: { guide: { zh: "息税折旧摊销前利润。接口无此项，请手填（≈营业利润+折旧摊销）。", en: "EBITDA. Not provided by the API — enter manually (≈ operating income + D&A)." } },
  growthYears: { guide: { zh: "护城河能维持超额增长的年数，通常 5–10 年；优势越强可越长。", en: "Years the moat sustains excess growth — usually 5–10; longer for stronger advantages." } },
  forecastYears: { guide: { zh: "预测到第几年的盈利来套目标倍数，常 3–5 年。", en: "How many years out you project earnings before applying the target multiple — usually 3–5." } },
  revGrowth: { ref: "revGrowth", guide: { zh: "自上而下：市场空间(TAM)×渗透率提升×份额变化；高增速随规模向行业/GDP 收敛，勿长期外推峰值。", en: "Top-down: TAM × penetration × share. High growth fades toward industry/GDP as scale grows — don't extrapolate peaks." } },
  niGrowth: { ref: "niGrowth", guide: { zh: "由营收增速 + 利润率变化（经营杠杆）共同驱动；成熟后向营收增速靠拢。", en: "Driven by revenue growth plus margin change (operating leverage); converges to revenue growth at maturity." } },
  epsGrowth: { ref: "epsGrowth", guide: { zh: "用未来 3–5 年 EPS 复合增速；留意回购会抬高每股增速。", en: "Use forward 3–5y EPS CAGR; buybacks inflate per-share growth." } },
  divGrowth: { guide: { zh: "由盈利增速与分红率共同决定；成熟分红股通常低个位数。", en: "Set by earnings growth and payout ratio; mature payers are usually low single digits." } },
  ebitdaGrowth: { guide: { zh: "通常略低于营收增速，受利润率变化影响。", en: "Usually a bit below revenue growth, shaped by margin change." } },
  opMargin: { ref: "opMargin", guide: { zh: "成熟期可持续的经营利润率；看毛利率−费用率趋势与规模效应，别取单年峰值。", en: "Sustainable mature operating margin; read gross-minus-opex trend and scale effects, not a peak year." } },
  netMargin: { ref: "netMargin", guide: { zh: "长期可持续净利率中枢，剔除一次性项目与税率扰动，别用单年高点。", en: "Long-run sustainable net margin; strip one-offs and tax noise, avoid peak years." } },
  reinvest: { ref: "reinvest", guide: { zh: "支撑增长所需留存 ≈ 增速÷ROE（可持续增长）；参考 1−自由现金流/净利。", en: "Retention needed to fund growth ≈ growth ÷ ROE; reference is 1 − FCF/net income." } },
  taxRate: { guide: { zh: "永续期用法定/边际税率（美≈21%、中≈25%）；或参考近年有效税率。", en: "Use statutory/marginal rate for the terminal phase (US≈21%, CN≈25%), or recent effective rate." } },
  salesToCap: { guide: { zh: "每 1 元新增投资带来的营收 = 营收/投入资本；轻资产高、重资产低，参考历史与同业。", en: "Revenue per unit of new investment = revenue/invested capital; higher for asset-light, lower for asset-heavy." } },
  wacc: { guide: { zh: "加权资本成本 = 股权成本×权重 + 税后债务成本×权重；股权成本=无风险利率+β×股权风险溢价（美股约 8–10%）。", en: "WACC = cost of equity×weight + after-tax cost of debt×weight; cost of equity = risk-free + β×ERP (~8–10% for US equities)." } },
  costOfEquity: { guide: { zh: "无风险利率(10Y 国债)+ β×股权风险溢价(~4.5–5.5%)；稳定大盘股约 8–9%。", en: "Risk-free (10Y) + β×equity risk premium (~4.5–5.5%); ~8–9% for stable large caps." } },
  termGrowth: { guide: { zh: "≤ 长期名义 GDP/无风险利率(通常 2–3%)，且必须 < 折现率；代表进入永续稳定期。", en: "≤ long-run nominal GDP/risk-free (~2–3%) and must be < discount rate; the perpetual steady state." } },
  targetPE: { ref: "pe", guide: { zh: "反映增长与确定性；锚定自身历史中枢、行业中位、与增速匹配(PEG≈1 ⇒ PE≈增速)。", en: "Reflects growth and certainty; anchor to own history, industry median, and growth (PEG≈1 ⇒ PE≈growth)." } },
  targetPB: { ref: "pb", guide: { zh: "与 ROE 强相关（高 ROE 配高 PB）；周期股参考历史 PB 区间。", en: "Tightly linked to ROE (higher ROE warrants higher PB); use the historical PB band for cyclicals." } },
  targetPS: { ref: "ps", guide: { zh: "适合未盈利/低利润期；最终应能回推到合理净利率下的 PE，别脱离盈利能力。", en: "For pre-profit/low-margin firms; must still map back to a sane PE at a normal net margin." } },
  peg: { guide: { zh: "经验上 PEG≈1 视为合理，<1 偏低估；对超高/超低增长会失真，谨慎。", en: "PEG≈1 is the rule-of-thumb fair level, <1 cheap; breaks down at very high/low growth." } },
  targetMultiple: { guide: { zh: "参考同业与历史；资本密集/高增长行业差异大。", en: "Reference peers and history; varies widely by capital intensity and growth." } },
};

const TX = {
  zh: { latest: "最新", avg5: "5年均", now: "当前", own5y: "自身5年均", indMed: "行业中位" },
  en: { latest: "Latest", avg5: "5y avg", now: "Now", own5y: "5y avg", indMed: "Industry median" },
};

function ser(data, kind, field) {
  const acc = data && data.financials && data.financials[kind] && data.financials[kind].find((a) => a.field === field);
  return acc ? acc.values.map((v) => v.value) : [];
}
function yoyLatest(s) {
  return (s.length >= 2 && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] !== 0) ? (s[0] - s[1]) / Math.abs(s[1]) * 100 : null;
}
function yoyAvg(s) {
  const ys = [];
  for (let i = 0; i < Math.min(5, s.length - 1); i++) {
    if (Number.isFinite(s[i]) && Number.isFinite(s[i + 1]) && s[i + 1] !== 0) ys.push((s[i] - s[i + 1]) / Math.abs(s[i + 1]) * 100);
  }
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
}
function avgN(s, n) {
  const a = s.slice(0, n).filter(Number.isFinite);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}
function pair(latest, avg, unit, t) {
  const chips = [];
  if (Number.isFinite(latest)) chips.push({ label: t.latest, value: latest });
  if (Number.isFinite(avg)) chips.push({ label: t.avg5, value: avg });
  return chips.length ? { unit, chips } : null;
}

// fieldReference(refTag, data, ctx, lang) → { unit:"%"|"x", chips:[{label,value}] } | null
export function fieldReference(refTag, data, ctx, lang) {
  const t = TX[lang] || TX.zh;
  switch (refTag) {
    case "revGrowth": { const s = ser(data, "IS", "OperatingRevenue"); return pair(yoyLatest(s), yoyAvg(s), "%", t); }
    case "niGrowth": { const s = ser(data, "IS", "NetProfit"); return pair(yoyLatest(s), yoyAvg(s), "%", t); }
    case "epsGrowth": { const s = ser(data, "IS", "EPS"); return pair(yoyLatest(s), yoyAvg(s), "%", t); }
    case "netMargin": { const s = ser(data, "IS", "NetProfitMargin"); return pair(s[0], avgN(s, 5), "%", t); }
    case "opMargin": {
      const oi = ser(data, "IS", "OperatingIncome"), or = ser(data, "IS", "OperatingRevenue");
      const m = oi.map((v, i) => (Number.isFinite(v) && or[i]) ? v / or[i] * 100 : NaN);
      return pair(m[0], avgN(m, 5), "%", t);
    }
    case "reinvest": {
      const fcf = ser(data, "CF", "NetFreeCashFlow"), ni = ser(data, "IS", "NetProfit");
      const r = ni.map((v, i) => (Number.isFinite(fcf[i]) && v > 0) ? (1 - fcf[i] / v) * 100 : NaN);
      return pair(Number.isFinite(r[0]) ? r[0] : NaN, avgN(r, 5), "%", t);
    }
    case "pe": case "pb": case "ps": {
      const vr = data && data.valuationRefs && data.valuationRefs[refTag];
      if (!vr) return null;
      const chips = [];
      if (Number.isFinite(vr.current)) chips.push({ label: t.now, value: vr.current });
      if (Number.isFinite(vr.own5y)) chips.push({ label: t.own5y, value: vr.own5y });
      if (Number.isFinite(vr.industryMedian)) chips.push({ label: t.indMed, value: vr.industryMedian });
      return chips.length ? { unit: "x", chips } : null;
    }
    default: return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project core test-core/field-meta.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/shared/field-meta.js test-core/field-meta.test.js
git commit -m "feat: field-meta — param guidance content + reference resolver"
```

---

### Task 4: Tag model fields with `meta`

**Files:**
- Modify: `public/shared/valuation/intrinsic.js`
- Modify: `public/shared/valuation/relative.js`

Add a `meta:"<tag>"` property to each field object (alongside its existing `k`/`label`/`col`). Do not change anything else on the fields.

- [ ] **Step 1: intrinsic.js tags**

Set these `meta` values by field key, per model:
- FCFF: `revenue`→`meta:"revenue"`, `n`→`meta:"growthYears"`, `growth`→`meta:"revGrowth"`, `opMargin`→`meta:"opMargin"`, `taxRate`→`meta:"taxRate"`, `salesToCap`→`meta:"salesToCap"`, `wacc`→`meta:"wacc"`, `termGrowth`→`meta:"termGrowth"`, `netDebt`→`meta:"netDebt"`.
- FCFE: `netIncome`→`meta:"netIncome"`, `growth`→`meta:"niGrowth"`, `reinvestRate`→`meta:"reinvest"`, `costOfEquity`→`meta:"costOfEquity"`, `n`→`meta:"growthYears"`, `termGrowth`→`meta:"termGrowth"`.
- DDM: `dps`→`meta:"dps"`, `growth`→`meta:"divGrowth"`, `n`→`meta:"growthYears"`, `costOfEquity`→`meta:"costOfEquity"`, `termGrowth`→`meta:"termGrowth"`.

Example (FCFF growth field becomes):
```js
    { k: "growth", label: { zh: "营收增速", en: "Revenue growth" }, col: "dual", unit: "%", default: 10, meta: "revGrowth" },
```

- [ ] **Step 2: relative.js tags**

- PE: `revenue`→`meta:"revenue"`, `n`→`meta:"forecastYears"`, `growth`→`meta:"revGrowth"`, `netMargin`→`meta:"netMargin"`, `targetPE`→`meta:"targetPE"`.
- PEG: `eps`→`meta:"eps"`, `growth`→`meta:"epsGrowth"`, `peg`→`meta:"peg"`.
- PB: `bps`→`meta:"bps"`, `targetPB`→`meta:"targetPB"`.
- PS: `revenue`→`meta:"revenue"`, `n`→`meta:"forecastYears"`, `growth`→`meta:"revGrowth"`, `targetPS`→`meta:"targetPS"`.
- EV/EBITDA: `ebitda`→`meta:"ebitda"`, `n`→`meta:"forecastYears"`, `growth`→`meta:"ebitdaGrowth"`, `targetMultiple`→`meta:"targetMultiple"`, `netDebt`→`meta:"netDebt"`.

- [ ] **Step 3: Verify model tests still pass**

Run: `npx vitest run --project core test-core/valuation-intrinsic.test.js test-core/valuation-relative.test.js`
Expected: PASS (adding a property doesn't affect `compute`).

- [ ] **Step 4: Commit**

```bash
git add public/shared/valuation/intrinsic.js public/shared/valuation/relative.js
git commit -m "feat(valuation): tag model fields with meta for guidance/refs"
```

---

### Task 5: Editor renders ⓘ guidance + clickable reference chips

**Files:**
- Modify: `public/shared/valuation-ui.js` (import FIELD_META/fieldReference; accept `refData`; rewrite `renderForm` field rendering)
- Modify: `public/index.html` (pass `refData` in `showEditor`; add `.vc-info`/`.vc-guide`/`.vc-ref`/`.vc-refchip` CSS)

- [ ] **Step 1: Import meta + accept refData**

In `public/shared/valuation-ui.js`, add to the imports at top:
```js
import { FIELD_META, fieldReference } from "/shared/field-meta.js";
```
Change the signature to accept `refData`:
```js
export function mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, refData, onDone, onCancel }) {
```

- [ ] **Step 2: Rewrite the field rendering in `renderForm`**

Replace the entire `renderForm` function (and the `fieldLabel` helper above it) with:

```js
  // 标签 + 可选 ⓘ 提示；guideHost 会拿到提示框元素以便后续插入网格
  function buildLabel(field) {
    const lab = el("div", "vc-label");
    const span = el("span"); span.textContent = (field.label && field.label[lang]) || field.k; lab.appendChild(span);
    if (field.unit === "%") { const u = el("span", "vc-unit"); u.textContent = "%"; lab.appendChild(u); }
    const meta = field.meta && FIELD_META[field.meta];
    let guideRow = null;
    if (meta && meta.guide) {
      const info = el("button", "vc-info"); info.type = "button"; info.textContent = "ⓘ"; info.setAttribute("aria-label", lang === "zh" ? "估值提示" : "Valuation tip");
      guideRow = el("div", "vc-guide"); guideRow.textContent = meta.guide[lang] || meta.guide.zh; guideRow.style.display = "none";
      info.addEventListener("click", () => { guideRow.style.display = guideRow.style.display === "none" ? "block" : "none"; });
      lab.appendChild(info);
    }
    return { lab, guideRow };
  }

  // 参考筹码行（grid-column:2/-1）；点击回填 fillFn(value)
  function buildRefRow(field, fillFn) {
    const meta = field.meta && FIELD_META[field.meta];
    if (!meta || !meta.ref || !refData) return null;
    const r = fieldReference(meta.ref, refData, ctx, lang);
    if (!r) return null;
    const row = el("div", "vc-ref"); row.style.gridColumn = "2 / -1";
    r.chips.forEach((chip) => {
      const b = el("button", "vc-refchip"); b.type = "button";
      const shown = r.unit === "%" ? chip.value.toFixed(1) + "%" : chip.value.toFixed(1) + "x";
      b.textContent = `${chip.label} ${shown}`;
      b.addEventListener("click", () => fillFn(Math.round(chip.value * 100) / 100));
      row.appendChild(b);
    });
    return row;
  }

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

    const recompute = () => compute(buildForm(readers));

    if (singles.length) {
      const h = el("div", "vc-shead"); h.textContent = tx("facts"); sheet.appendChild(h);
      singles.forEach((field) => {
        const { lab, guideRow } = buildLabel(field);
        const input = makeInput(singleInit(field));
        if (field.hint && field.hint[lang]) input.placeholder = field.hint[lang];
        readers.push({ field, getVal: () => input.value !== "" ? Number(input.value) : NaN });
        input.addEventListener("input", recompute);
        sheet.append(lab, input, el("div"));
        const refRow = buildRefRow(field, (v) => { input.value = String(v); recompute(); });
        if (refRow) { sheet.append(el("div"), refRow); }
        if (guideRow) sheet.appendChild(guideRow);
      });
    }
    if (duals.length) {
      const h = el("div", "vc-shead"); h.textContent = tx("assume"); sheet.appendChild(h);
      sheet.appendChild(el("div"));
      const hc = el("div", "vc-chead"); hc.textContent = tx("conservative"); sheet.appendChild(hc);
      const ho = el("div", "vc-chead"); ho.textContent = tx("optimistic"); sheet.appendChild(ho);
      duals.forEach((field) => {
        const { lab, guideRow } = buildLabel(field);
        const init = dualInit(field);
        const inC = makeInput(init.c), inO = makeInput(init.o);
        readers.push({ field, getVal: () => ({ c: inC.value !== "" ? Number(inC.value) : NaN, o: inO.value !== "" ? Number(inO.value) : NaN }) });
        inC.addEventListener("input", recompute);
        inO.addEventListener("input", recompute);
        sheet.append(lab, inC, inO);
        const refRow = buildRefRow(field, (v) => { inC.value = String(v); inO.value = String(v); recompute(); });
        if (refRow) { sheet.append(el("div"), refRow); }
        if (guideRow) sheet.appendChild(guideRow);
      });
    }
    formWrap.appendChild(sheet);
    recompute();
  }
```

Note: `.vc-guide` rows are appended with default `grid-column` (col1) but styled in CSS to span all columns; ref rows explicitly set `grid-column:2/-1`.

- [ ] **Step 3: Pass `refData` from `index.html`**

In `public/index.html`, in `showEditor`, add `refData` to the `mountValuationCalc(...)` options object:
```js
      refData: (item._financials && item._financials.annual)
        ? { financials: item._financials.annual.financials || null, valuationRefs: item._financials.annual.valuationRefs || null }
        : null,
```

- [ ] **Step 4: Add CSS**

In `public/index.html`, immediately after the `.vc-cancel:hover{...}` rule, add:

```css
  /* 估值提示 ⓘ + 参考筹码 */
  .vc-info{margin-left:6px;border:0;background:none;color:var(--ink-mute);font-size:12px;cursor:pointer;padding:0;line-height:1;vertical-align:baseline}
  .vc-info:hover{color:var(--ink)}
  .vc-guide{grid-column:1 / -1;margin:-2px 0 2px;padding:9px 11px;background:var(--accent);border-radius:8px;font-size:12px;line-height:1.6;color:var(--ink-soft)}
  .vc-ref{display:flex;flex-wrap:wrap;gap:6px;margin-top:-2px}
  .vc-refchip{border:1px solid var(--border);background:var(--card);border-radius:6px;padding:2px 8px;font-family:var(--font);font-size:11px;color:var(--ink-soft);cursor:pointer;transition:color .12s,border-color .12s}
  .vc-refchip:hover{color:var(--ink);border-color:var(--node)}
```

- [ ] **Step 5: Verify in the browser**

Run `npm run dev`. As demo owner on `/b/demo/AAPL` → 估值研究 → 添加估值:
1. FCFF: 营收增速 shows ⓘ; under its inputs two chips「最新 X%」「5年均 Y%」; clicking a chip fills both 保守/乐观 and the result recomputes.
2. Click ⓘ next to WACC → a guidance callout appears under the row; click again hides it.
3. Switch to PE: 目标 PE shows chips「当前 35.9x · 自身5年均 …x · 行业中位 26.4x」.
4. With a symbol lacking financials, fields render with no chips and no errors.

- [ ] **Step 6: Commit**

```bash
git add public/shared/valuation-ui.js public/index.html
git commit -m "feat(ui): ⓘ estimation guidance + clickable reference chips per param"
```

---

### Task 6: Full verification

**Files:** none

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — previous 104 + new (`valuation-refs` 3, `field-meta` ~7). `numFailedTests: 0`.

- [ ] **Step 2: Manual matrix (browser, demo owner)**

Per-model spot check: every dual assumption with a ref shows chips; chips fill both columns; ⓘ toggles guidance for fields with guides (incl. no-data ones: WACC/税率/永续/年数); English toggle localizes guides + chip labels; graceful empty state when financials absent; restore any demo mutations.

- [ ] **Step 3: Final commit (if tidy-ups)**

```bash
git add -A && git commit -m "chore: param guidance verification tidy-ups" || echo "nothing to commit"
```

> **Deploy note:** no schema change; uses existing `LONGBRIDGE_*` secrets; `/api/financials` cache `max-age=86400` (industry refs included on annual).
