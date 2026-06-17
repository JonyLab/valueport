/**
 * valuation-ui.js — 估值编辑器（Figma「Add Valuation」结构）。
 * 左栏：估值方法下拉 + Inputs(前提) 卡 + Assumptions(情景假设) 卡 + 备注。
 * 右栏：结果卡（低~高 + 判定 + 预测明细 breakdown）+ Submit。
 * 依赖：MODELS/runModel（valuation/index.js）、FIELD_META/fieldReference（field-meta.js）。
 * 导出：mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, refData, verdict, onDone, onCancel })
 *   onDone({ method, inputs, low, high, note })  —— 点 Submit、且低~高有效时触发
 *   verdict(low, high) → { text, cls } | null     —— 由宿主提供（结果卡判定行）
 */
import { MODELS, runModel } from "/shared/valuation/index.js";
import { FIELD_META, fieldReference, moneyAnnualRef, moneyQuarterRef } from "/shared/field-meta.js";

const TX = {
  zh: { method: "估值方法", facts: "前提", assume: "情景假设", conservative: "保守", optimistic: "乐观",
        submit: "保存", dash: "—", note: "备注", notePh: "为什么给出这个估值？关键逻辑、假设依据、风险…", useRange: "套用区间" },
  en: { method: "Method", facts: "Inputs", assume: "Assumptions", conservative: "Conservative", optimistic: "Optimistic",
        submit: "Submit", dash: "—", note: "Note", notePh: "Why this valuation? Key logic, assumptions, risks…", useRange: "Use range" },
};

function el(tag, cls, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) Object.assign(node, attrs);
  return node;
}
function fmt(v, dash) { return (v !== null && isFinite(v)) ? Number(v).toFixed(2) : dash; }
function fmtMoney(n) {
  const s = n < 0 ? "-" : "", a = Math.abs(n);
  if (a >= 1e12) return s + (a / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(2) + "K";
  return s + a.toFixed(2);
}
// 大额「金额类」字段（按 meta 标签）——用单位化输入
const MONEY_METAS = new Set(["revenue", "netIncome", "netDebt", "ebitda"]);
// 解析带单位的金额：支持 K/M/B/T、万/亿/万亿/兆、千分位、负号
function parseMoney(s) {
  if (typeof s !== "string") return NaN;
  s = s.trim().replace(/[,，\s]/g, "");
  if (!s) return NaN;
  const m = /^(-?\d*\.?\d+)(万亿|亿|万|兆|[kmbtKMBT])?$/.exec(s);
  if (!m) return NaN;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, "万": 1e4, "亿": 1e8, "万亿": 1e12, "兆": 1e12 };
  const u = (m[2] || "").toLowerCase();
  return parseFloat(m[1]) * (mult[u] ?? 1);
}
function fmtKind(n, kind) {
  if (!Number.isFinite(n)) return null;
  if (kind === "mult") return n.toFixed(1) + "x";
  if (kind === "pct") return n.toFixed(1) + "%";
  if (kind === "money") return fmtMoney(n);
  return n.toFixed(2);
}
function fmtRange(a, b, kind) {
  const A = fmtKind(a, kind), B = fmtKind(b, kind);
  if (A === null && B === null) return "—";
  if (A === null) return B; if (B === null) return A;
  return A === B ? A : `${A}–${B}`;
}
function initialFor(field, ctx) {
  let v = "";
  if (typeof field.prefill === "function") { try { v = field.prefill(ctx); } catch { v = ""; } }
  const blank = v === "" || v === undefined || v === null || (typeof v === "number" && !isFinite(v));
  if (blank && field.default !== undefined) v = field.default;
  return v;
}

export function mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, refData, verdict, onDone, onCancel }) {
  const L = TX[lang] || TX.zh;
  const tx = (k) => L[k];
  let activeIdx = Math.max(0, MODELS.findIndex((m) => m.key === initialMethod));
  let lastLow = null, lastHigh = null, lastForm = {};

  mount.innerHTML = "";
  const root = el("div", "vc");
  const main = el("div", "vc-main");
  const side = el("div", "vc-side");
  root.append(main, side);
  mount.appendChild(root);

  // ── 估值方法（卡片外，独立标签 + 下拉）──
  const mblock = el("div", "vc-mblock");
  const mlabel = el("div", "vc-mlabel"); mlabel.textContent = tx("method");
  const select = el("select", "vc-select");
  [["intrinsic", MODELS.filter((m) => m.group === "intrinsic")],
   ["relative", MODELS.filter((m) => m.group === "relative")]].forEach(([gk, models]) => {
    if (!models.length) return;
    const og = document.createElement("optgroup"); og.label = gk === "intrinsic" ? (lang === "zh" ? "内在价值" : "Intrinsic") : (lang === "zh" ? "相对估值" : "Relative");
    models.forEach((model) => {
      const o = document.createElement("option");
      o.value = String(MODELS.indexOf(model));
      o.textContent = (model.label && model.label[lang]) || model.key;
      og.appendChild(o);
    });
    select.appendChild(og);
  });
  select.value = String(activeIdx);
  select.addEventListener("change", () => { activeIdx = Number(select.value); renderForm(); });
  mblock.append(mlabel, select);
  main.appendChild(mblock);

  const formWrap = el("div", "vc-form");
  main.appendChild(formWrap);

  // ── 备注 ──
  const noteWrap = el("div", "vc-note");
  const noteLabel = el("div", "vc-note-label"); noteLabel.textContent = tx("note");
  const noteInput = el("textarea", "vc-note-input"); noteInput.placeholder = tx("notePh");
  if (initialNote) noteInput.value = initialNote;
  noteWrap.append(noteLabel, noteInput);
  main.appendChild(noteWrap);

  // ── 右栏：结果卡 + Submit ──
  const rcard = el("div", "vc-rcard");
  const rtop = el("div", "vc-rcard-top");
  const nums = el("div", "vc-rnums");
  const outLow = el("span", "vc-rlow"), outDash = el("span", "vc-rdash"), outHigh = el("span", "vc-rhigh");
  outDash.textContent = "–";
  nums.append(outLow, outDash, outHigh);
  const verdictEl = el("div", "vc-rverdict");
  rtop.append(nums, verdictEl);
  const bdMount = el("div", "vc-rcard-rows");
  const schedMount = el("div", "vc-sched");
  rcard.append(rtop, bdMount, schedMount);
  side.appendChild(rcard);

  const submitBtn = el("button", "vc-submit"); submitBtn.type = "button"; submitBtn.textContent = tx("submit"); submitBtn.disabled = true;
  submitBtn.addEventListener("click", () => {
    if (lastLow === null || lastHigh === null || !isFinite(lastLow) || !isFinite(lastHigh)) return;
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh), note: noteInput.value.trim() });
  });
  side.appendChild(submitBtn);

  // ── 计算 + 渲染结果 ──
  function consOpt(model, form) {
    const cons = {}, opt = {};
    for (const f of model.fields) {
      const v = form[f.k];
      if (f.col === "dual") { cons[f.k] = v && typeof v === "object" ? v.c : NaN; opt[f.k] = v && typeof v === "object" ? v.o : NaN; }
      else { cons[f.k] = v; opt[f.k] = v; }
    }
    return { cons, opt };
  }
  function renderBreakdown(model, form, valid) {
    bdMount.innerHTML = "";
    if (!valid || typeof model.breakdown !== "function") return;
    const { cons, opt } = consOpt(model, form);
    let bc, bo;
    try { bc = model.breakdown(cons, ctx); bo = model.breakdown(opt, ctx); } catch { return; }
    if (!Array.isArray(bc)) return;
    bc.forEach((row, i) => {
      const o = (bo && bo[i]) || {};
      const r = el("div", "vc-rrow");
      const k = el("span", "vc-rk"); k.textContent = (row.label && row.label[lang]) || row.key;
      const val = el("span", "vc-rv"); val.textContent = fmtRange(row.value, o.value, row.kind);
      r.append(k, val); bdMount.appendChild(r);
    });
  }
  // 情景取中（保守/乐观取均）用于逐年现金流展示
  function midVals(model, form) {
    const v = {};
    for (const f of model.fields) {
      const x = form[f.k];
      if (f.col === "dual") {
        const c = x && typeof x === "object" ? x.c : NaN, o = x && typeof x === "object" ? x.o : NaN;
        v[f.k] = (Number.isFinite(c) && Number.isFinite(o)) ? (c + o) / 2 : (Number.isFinite(c) ? c : o);
      } else v[f.k] = x;
    }
    return v;
  }
  // 逐年现金流明细（仅 DCF 模型；可展开；情景取中）
  function renderSchedule(model, form, valid) {
    schedMount.innerHTML = "";
    if (!valid || typeof model.schedule !== "function") return;
    let s; try { s = model.schedule(midVals(model, form), ctx); } catch { return; }
    if (!s || !Array.isArray(s.rows) || !s.rows.length) return;
    const fmtCf = (n) => s.kind === "money" ? (Number.isFinite(n) ? fmtMoney(n) : "—") : (Number.isFinite(n) ? n.toFixed(2) : "—");
    const title = lang === "zh" ? "逐年现金流（情景取中）" : "Year-by-year cash flow (mid)";
    const toggle = el("button", "vc-sched-toggle"); toggle.type = "button"; toggle.textContent = title + " ▾";
    const body = el("div", "vc-sched-body"); body.style.display = "none";
    const tbl = el("table", "vc-sched-table");
    const head = el("tr");
    (lang === "zh" ? ["年", "现金流", "现值"] : ["Yr", "Cash flow", "PV"]).forEach((h) => { const th = el("th"); th.textContent = h; head.appendChild(th); });
    tbl.appendChild(head);
    let sumPv = 0;
    const addRow = (cls, c0, c1, c2) => { const tr = el("tr", cls); [c0, c1, c2].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); }); tbl.appendChild(tr); };
    s.rows.forEach((r) => { addRow("", String(r.year), fmtCf(r.cf), fmtCf(r.pv)); if (Number.isFinite(r.pv)) sumPv += r.pv; });
    addRow("vc-sched-term", lang === "zh" ? "终值" : "Term.", "—", fmtCf(s.terminalPv));
    if (Number.isFinite(s.terminalPv)) sumPv += s.terminalPv;
    addRow("vc-sched-sum", lang === "zh" ? "现值合计" : "Total PV", "", fmtCf(sumPv));
    body.appendChild(tbl);
    toggle.addEventListener("click", () => { const open = body.style.display === "none"; body.style.display = open ? "" : "none"; toggle.textContent = title + (open ? " ▴" : " ▾"); });
    schedMount.append(toggle, body);
  }
  function compute(formData) {
    lastForm = formData;
    const model = MODELS[activeIdx];
    let r = { low: null, high: null };
    try { r = runModel(model, formData, ctx); } catch { /* 输入不完整 */ }
    lastLow = r.low; lastHigh = r.high;
    const dash = tx("dash");
    const valid = lastLow !== null && lastHigh !== null && isFinite(lastLow) && isFinite(lastHigh);
    outLow.textContent = fmt(lastLow, dash); outHigh.textContent = fmt(lastHigh, dash);
    outDash.style.opacity = valid ? "1" : ".35";
    let v = null;
    if (valid && typeof verdict === "function") { try { v = verdict(Math.min(lastLow, lastHigh), Math.max(lastLow, lastHigh)); } catch { v = null; } }
    verdictEl.textContent = v ? v.text : "";
    verdictEl.className = "vc-rverdict " + (v && v.cls ? v.cls : "");
    verdictEl.style.display = v ? "" : "none";
    renderBreakdown(model, formData, valid);
    renderSchedule(model, formData, valid);
    submitBtn.disabled = !valid;
  }

  // ── 字段构件（标签 + ⓘ、参考筹码 + ↗）──
  function buildLabel(field, cls) {
    const lab = el("div", cls || "vc-label");
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
  function buildRefRow(field, fillFn, fillRange) {
    const meta = field.meta && FIELD_META[field.meta];
    if (!meta || !meta.ref || !refData) return null;
    const r = fieldReference(meta.ref, refData, ctx, lang);
    if (!r) return null;
    const row = el("div", "vc-ref");
    const unitFmt = (n) => r.unit === "%" ? n.toFixed(1) + "%" : n.toFixed(1) + "x";
    // 一键套用区间：用「年报口径」筹码的最小/最大配成 保守–乐观（忽略季报口径，仅 dual 字段）
    if (fillRange && r.chips.filter((c) => !c.q).length >= 2) {
      const vals = r.chips.filter((c) => !c.q).map((c) => c.value).filter(Number.isFinite);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      if (hi > lo) {
        const rb = el("button", "vc-refchip vc-refrange"); rb.type = "button";
        rb.textContent = `${tx("useRange")} ${unitFmt(lo)}–${unitFmt(hi)}`;
        rb.addEventListener("click", () => fillRange(Math.round(lo * 100) / 100, Math.round(hi * 100) / 100));
        row.appendChild(rb);
      }
    }
    r.chips.forEach((chip) => {
      const b = el("button", "vc-refchip" + (chip.q ? " vc-refq" : "")); b.type = "button";
      const shown = r.unit === "%" ? chip.value.toFixed(1) + "%" : chip.value.toFixed(1) + "x";
      b.textContent = `${chip.label} ${shown}`;
      b.addEventListener("click", () => fillFn(Math.round(chip.value * 100) / 100));
      row.appendChild(b);
    });
    // 仅财报派生参考给溯源（链向年报：美股 10-K / 非美长桥财报页）；倍数类是当前市场/行业口径，不给申报源
    const isMultiple = meta.ref === "pe" || meta.ref === "pb" || meta.ref === "ps";
    const src = (!isMultiple && refData.sources) ? refData.sources.financial : null;
    if (src) {
      const a = el("a", "vc-srclink"); a.href = src; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "↗"; a.title = lang === "zh" ? "查看年报出处" : "View annual report";
      row.appendChild(a);
    }
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
  function makeInput(initVal) {
    const inp = el("input", "vc-input", { type: "number", inputMode: "decimal", step: "any" });
    if (initVal !== "" && initVal !== undefined && initVal !== null) inp.value = String(initVal);
    return inp;
  }
  // 单位化金额输入：静止显示 416.16B、聚焦显示原值便于编辑、失焦重格式化
  function makeMoneyInput(initVal) {
    const inp = el("input", "vc-input vc-money", { type: "text", inputMode: "decimal" });
    inp.placeholder = lang === "zh" ? "如 416B 或 4161亿" : "e.g. 416B";
    if (Number.isFinite(initVal)) { inp.dataset.raw = String(initVal); inp.value = fmtMoney(initVal); }
    inp.addEventListener("focus", () => { if (inp.dataset.raw) inp.value = inp.dataset.raw; inp.select(); });
    inp.addEventListener("blur", () => { const n = parseMoney(inp.value); if (Number.isFinite(n)) { inp.dataset.raw = String(n); inp.value = fmtMoney(n); } else { delete inp.dataset.raw; } });
    return inp;
  }
  function moneyVal(inp) {
    if (document.activeElement !== inp && inp.dataset.raw && inp.value === fmtMoney(Number(inp.dataset.raw))) return Number(inp.dataset.raw);
    const n = parseMoney(inp.value); return Number.isFinite(n) ? n : NaN;
  }

  function renderForm() {
    formWrap.innerHTML = "";
    const model = MODELS[activeIdx];
    const fields = model.fields || [];
    const readers = [];
    const singles = fields.filter((f) => f.col !== "dual");
    const duals = fields.filter((f) => f.col === "dual");
    const recompute = () => compute(buildForm(readers));

    // Inputs（前提）卡：堆叠 标签 + 输入
    if (singles.length) {
      const card = el("div", "vc-card");
      const h = el("div", "vc-card-head"); h.textContent = tx("facts"); card.appendChild(h);
      singles.forEach((field) => {
        const fld = el("div", "vc-fld");
        const { lab, guideRow } = buildLabel(field, "vc-flabel");
        const money = MONEY_METAS.has(field.meta);
        const input = money ? makeMoneyInput(singleInit(field)) : makeInput(singleInit(field));
        if (!money && field.hint && field.hint[lang]) input.placeholder = field.hint[lang];
        readers.push({ field, getVal: money ? () => moneyVal(input) : () => input.value !== "" ? Number(input.value) : NaN });
        input.addEventListener("input", recompute);
        fld.append(lab, input);
        const refRow = buildRefRow(field, (v) => { if (money) { input.value = fmtMoney(v); input.dataset.raw = String(v); } else input.value = String(v); recompute(); });
        if (refRow) fld.appendChild(refRow);
        // money 字段：最新财年（实线）+ 近4季 TTM/最新季报（虚线），点击回填，明确标注
        if (money && refData) {
          const an = moneyAnnualRef(field.meta, refData, lang);
          const mq = moneyQuarterRef(field.meta, refData, lang);
          if (an || mq) {
            const mrow = el("div", "vc-ref");
            const addChip = (ref, q) => {
              if (!ref) return;
              const b = el("button", "vc-refchip" + (q ? " vc-refq" : "")); b.type = "button";
              b.textContent = `${ref.label} ≈ ${fmtMoney(ref.value)}`;
              b.addEventListener("click", () => { input.value = fmtMoney(ref.value); input.dataset.raw = String(ref.value); recompute(); });
              mrow.appendChild(b);
            };
            addChip(an, false);
            addChip(mq, true);
            fld.appendChild(mrow);
          }
        }
        if (guideRow) fld.appendChild(guideRow);
        card.appendChild(fld);
      });
      formWrap.appendChild(card);
    }

    // Assumptions（情景假设）卡：每个假设各自成行（字段内输入↔参考紧、字段间留白），列对齐
    if (duals.length) {
      const card = el("div", "vc-card");
      const h = el("div", "vc-card-head"); h.textContent = tx("assume"); card.appendChild(h);
      const hr = el("div", "vc-arow vc-arow-head");
      const cc = el("div", "vc-chead"); cc.textContent = tx("conservative");
      const co = el("div", "vc-chead"); co.textContent = tx("optimistic");
      hr.append(el("div"), cc, co); card.appendChild(hr);
      duals.forEach((field) => {
        const arow = el("div", "vc-arow");
        const { lab, guideRow } = buildLabel(field);
        const init = dualInit(field);
        const inC = makeInput(init.c), inO = makeInput(init.o);
        readers.push({ field, getVal: () => ({ c: inC.value !== "" ? Number(inC.value) : NaN, o: inO.value !== "" ? Number(inO.value) : NaN }) });
        inC.addEventListener("input", recompute); inO.addEventListener("input", recompute);
        arow.append(lab, inC, inO);
        const refRow = buildRefRow(field, (v) => { inC.value = String(v); inO.value = String(v); recompute(); }, (lo, hi) => { inC.value = String(lo); inO.value = String(hi); recompute(); });
        if (refRow) { refRow.style.gridColumn = "2 / -1"; arow.appendChild(refRow); }
        if (guideRow) { guideRow.style.gridColumn = "1 / -1"; arow.appendChild(guideRow); }
        card.appendChild(arow);
      });
      formWrap.appendChild(card);
    }
    recompute();
  }

  function buildForm(readers) { const form = {}; readers.forEach(({ field, getVal }) => { form[field.k] = getVal(); }); return form; }

  renderForm();
}
