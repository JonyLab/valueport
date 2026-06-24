/**
 * valuation-ui.js — 估值编辑器（Figma「Add Valuation」结构）。
 * 左栏：估值方法下拉 + Inputs(前提) 卡 + Assumptions(情景假设) 卡 + 备注。
 * 右栏：结果卡（低~高 + 判定 + 预测明细 breakdown）+ Submit。
 * 依赖：MODELS/runModel（valuation/index.js）、FIELD_META/fieldReference（field-meta.js）。
 * 导出：mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, refData, verdict, onDone, onCancel })
 *   onDone({ method, inputs, low, high, note })  —— 点 Submit、且低~高有效时触发
 *   verdict(low, high) → { text, cls } | null     —— 由宿主提供（结果卡判定行）
 */
import { MODELS, runModel, modeFields } from "/shared/valuation/index.js";
import { FIELD_META, fieldReference, moneyAnnualRef, moneyQuarterRef } from "/shared/field-meta.js";
import { derivationForMeta } from "/shared/valuation/derivations.js";
import { aggregateSegments } from "/shared/valuation/segments.js";
import { assetPV } from "/shared/valuation/resource.js";

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
const MONEY_METAS = new Set(["revenue", "netIncome", "netDebt", "ebitda", "fcf"]);
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

export function mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, initialDerivations, initialSegments, refData, verdict, onDone, onCancel }) {
  const L = TX[lang] || TX.zh;
  const tx = (k) => L[k];
  // 新增时不替用户预选方法（activeIdx = -1，显示占位）；编辑时沿用原方法
  let activeIdx = MODELS.findIndex((m) => m.key === initialMethod);
  let lastLow = null, lastHigh = null, lastForm = {};
  let currentMode = null;
  const derivations = (initialDerivations && typeof initialDerivations === "object") ? JSON.parse(JSON.stringify(initialDerivations)) : {};
  const segments = (initialSegments && typeof initialSegments === "object" && Array.isArray(initialSegments.rows))
    ? JSON.parse(JSON.stringify(initialSegments)) : { enabled: false, rows: [] };
  // 资源股 NAV/SOTP 的资产明细（随 inputs.assets 持久化，不另设字段）
  let assetState = { rows: (initialInputs && Array.isArray(initialInputs.assets)) ? JSON.parse(JSON.stringify(initialInputs.assets)) : null };
  const round2 = (n) => Math.round(n * 100) / 100;
  // 仅保留当前模型字段的推导,存档时用
  function currentDerivations() {
    const model = MODELS[activeIdx]; if (!model) return {};
    const keys = new Set(modeFields(model, currentMode).map((f) => f.k));
    const out = {}; for (const k in derivations) if (keys.has(k)) out[k] = derivations[k];
    return out;
  }

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
  // 占位项：未选方法时显示，不出现在展开列表里（hidden+disabled）
  const ph = document.createElement("option");
  ph.value = "-1"; ph.disabled = true; ph.hidden = true;
  ph.textContent = lang === "zh" ? "请选择估值方法…" : "Choose a method…";
  select.appendChild(ph);
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
  select.value = activeIdx >= 0 ? String(activeIdx) : "-1";
  select.addEventListener("change", () => { activeIdx = Number(select.value); currentMode = null; renderForm(); });
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
    const segOut = currentMode === "segment" ? { enabled: true, rows: segments.rows } : { enabled: false, rows: segments.rows || [] };
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, derivations: currentDerivations(), segments: segOut, low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh), note: noteInput.value.trim() });
  });
  side.appendChild(submitBtn);

  // ── 计算 + 渲染结果 ──
  function consOpt(model, form) {
    const cons = {}, opt = {};
    for (const f of modeFields(model, currentMode)) {
      const v = form[f.k];
      if (f.col === "dual") { cons[f.k] = v && typeof v === "object" ? v.c : NaN; opt[f.k] = v && typeof v === "object" ? v.o : NaN; }
      else { cons[f.k] = v; opt[f.k] = v; }
    }
    if (model.modes) { cons._mode = opt._mode = currentMode; }
    if (form.assets) { cons.assets = opt.assets = form.assets; } // 资产型模型：明细/摘要需要资产数组
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
    for (const f of modeFields(model, currentMode)) {
      const x = form[f.k];
      if (f.col === "dual") {
        const c = x && typeof x === "object" ? x.c : NaN, o = x && typeof x === "object" ? x.o : NaN;
        v[f.k] = (Number.isFinite(c) && Number.isFinite(o)) ? (c + o) / 2 : (Number.isFinite(c) ? c : o);
      } else v[f.k] = x;
    }
    if (model.modes) v._mode = currentMode;
    if (form.assets) v.assets = form.assets;
    return v;
  }
  // 逐年现金流明细（仅 DCF 模型；可展开；情景取中）
  function renderSchedule(model, form, valid) {
    schedMount.innerHTML = "";
    if (!valid || typeof model.schedule !== "function") return;
    let s; try { s = model.schedule(midVals(model, form), ctx); } catch { return; }
    if (!s || !Array.isArray(s.rows) || !s.rows.length) return;
    const fmtCf = (n) => s.kind === "money" ? (Number.isFinite(n) ? fmtMoney(n) : "—") : (Number.isFinite(n) ? n.toFixed(2) : "—");
    // DDM 折现的是股息,不是现金流
    const isDiv = model.key === "ddm";
    const flowZh = isDiv ? "股息" : "现金流", flowEn = isDiv ? "Dividend" : "Cash flow";
    const title = lang === "zh" ? `逐年${flowZh}（情景取中）` : `Year-by-year ${flowEn.toLowerCase()} (mid)`;
    const toggle = el("button", "vc-sched-toggle"); toggle.type = "button"; toggle.textContent = title + " ▾";
    const body = el("div", "vc-sched-body"); body.style.display = "none";
    const tbl = el("table", "vc-sched-table");
    const head = el("tr");
    (lang === "zh" ? ["年", flowZh, "现值"] : ["Yr", flowEn, "PV"]).forEach((h) => { const th = el("th"); th.textContent = h; head.appendChild(th); });
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
  function buildAnchorPanel(field, inC, inO, recompute, bodyBox) {
    const tip = el("div", "vc-deriv-tip");
    tip.textContent = lang === "zh" ? "锚定当前 / 自身历史 / 行业中位,定保守与乐观目标。" : "Anchor to current / own history / industry median; set conservative & optimistic targets.";
    bodyBox.appendChild(tip);
    const refRow = buildRefRow(field,
      (v) => { inC.value = String(v); inO.value = String(v); recompute(); },
      (lo, hi) => { inC.value = String(lo); inO.value = String(hi); recompute(); });
    if (refRow) bodyBox.appendChild(refRow);
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
    const hero = el("div", "vc-seg-hero");
    const table = el("div", "vc-segcards");
    const addBtn = el("button", "vc-seg-add", { type: "button" }); addBtn.textContent = lang === "zh" ? "＋ 添加分部" : "＋ Add segment";
    const summary = el("div", "vc-seg-sum");
    body.append(hero, table, addBtn, summary);
    wrap.append(head, body);

    let rowEls = [];
    const collect = () => rowEls.map((r) => ({ name: r.name.value, revenue: moneyVal(r.rev), growth: { c: segNum(r.gc), o: segNum(r.go) }, netMargin: { c: segNum(r.mc), o: segNum(r.mo) } }));

    function setDriven(on) {
      // 分部开启时,三字段由分部表算出,作为输入多余 → 整行隐藏(数值仍写入、照常喂 runModel)
      [fieldEls.revenue, fieldEls.growth, fieldEls.netMargin].forEach((fe) => {
        if (!fe) return;
        const row = fe.fld || fe.arow;
        if (row) row.style.display = on ? "none" : "";
      });
    }

    // 每张卡显示占比 + 该业务未来净利 E(保守~乐观)
    function refreshCards(rows) {
      const n = fieldEls.n ? segNum(fieldEls.n.input) : NaN;
      const total = rows.reduce((s, x) => s + (x.revenue > 0 ? x.revenue : 0), 0);
      rowEls.forEach((rec, i) => {
        const x = rows[i]; if (!x) return;
        const share = (total > 0 && x.revenue > 0) ? Math.round(x.revenue / total * 100) : null;
        rec.share.textContent = share === null ? "" : (lang === "zh" ? `占比 ${share}%` : `${share}%`);
        const fut = (k) => (x.revenue > 0 && n > 0 && Number.isFinite(x.growth[k])) ? x.revenue * Math.pow(1 + x.growth[k] / 100, n) * (Number.isFinite(x.netMargin[k]) ? x.netMargin[k] : 0) / 100 : null;
        const ec = fut("c"), eo = fut("o");
        rec.foot.textContent = (ec === null && eo === null) ? "" : `E ${fmtMoney(ec || 0)}~${fmtMoney(eo || 0)}`;
      });
    }

    function recomputeSeg() {
      const rows = collect();
      segments.rows = rows;
      const n = fieldEls.n ? segNum(fieldEls.n.input) : NaN;
      const agg = aggregateSegments(rows, n);
      if (agg) {
        if (fieldEls.revenue) { fieldEls.revenue.input.value = fmtMoney(agg.revenue); fieldEls.revenue.input.dataset.raw = String(agg.revenue); }
        if (fieldEls.growth) { fieldEls.growth.c.value = String(round2(agg.growth.c)); fieldEls.growth.o.value = String(round2(agg.growth.o)); }
        if (fieldEls.netMargin) { fieldEls.netMargin.c.value = String(round2(agg.netMargin.c)); fieldEls.netMargin.o.value = String(round2(agg.netMargin.o)); }
        if (derivations.growth) delete derivations.growth;
        hero.textContent = lang === "zh"
          ? `合计未来净利 E  ${fmtMoney(agg.futNi.c)} ~ ${fmtMoney(agg.futNi.o)}`
          : `Total future NI  ${fmtMoney(agg.futNi.c)} ~ ${fmtMoney(agg.futNi.o)}`;
        summary.textContent = lang === "zh"
          ? `合计营收 ${fmtMoney(agg.revenue)} · 隐含增速 ${round2(agg.growth.c)}–${round2(agg.growth.o)}%`
          : `Total rev ${fmtMoney(agg.revenue)} · implied g ${round2(agg.growth.c)}–${round2(agg.growth.o)}%`;
      } else {
        hero.textContent = "";
        summary.textContent = lang === "zh" ? "填写分部:当前营收 + 增速 + 净利率(并先填预测年数)" : "Add segments: revenue + growth + margin (set forecast years first)";
      }
      refreshCards(rows);
      recompute();
    }

    function makeRow(seed) {
      const card = el("div", "vc-segcard");
      const name = el("input", "vc-input vc-seg-name", { type: "text" }); name.placeholder = lang === "zh" ? "业务名" : "Segment"; if (seed && seed.name) name.value = seed.name;
      const rev = makeMoneyInput(seed && Number.isFinite(Number(seed.revenue)) ? Number(seed.revenue) : ""); rev.placeholder = lang === "zh" ? "营收" : "Rev";
      const del = el("button", "vc-segc-del", { type: "button" }); del.textContent = "✕";
      const top = el("div", "vc-segc-top"); top.append(name, rev, del);
      const gc = makeInput(seed && seed.growth ? seed.growth.c : ""), go = makeInput(seed && seed.growth ? seed.growth.o : "");
      const mc = makeInput(seed && seed.netMargin ? seed.netMargin.c : ""), mo = makeInput(seed && seed.netMargin ? seed.netMargin.o : "");
      gc.placeholder = lang === "zh" ? "保守" : "cons"; go.placeholder = lang === "zh" ? "乐观" : "opt";
      mc.placeholder = lang === "zh" ? "保守" : "cons"; mo.placeholder = lang === "zh" ? "乐观" : "opt";
      // 小网格:保守|乐观 共用列头,增速/净利率 两行共用;占比 + E 放网格右侧
      const scen = el("div", "vc-segscen");
      const hc = el("div", "vc-segscen-h"); hc.textContent = lang === "zh" ? "保守" : "Cons";
      const ho = el("div", "vc-segscen-h"); ho.textContent = lang === "zh" ? "乐观" : "Opt";
      const gLab = el("div", "vc-segscen-lab"); gLab.textContent = lang === "zh" ? "增速 %" : "Growth %";
      const mLab = el("div", "vc-segscen-lab"); mLab.textContent = lang === "zh" ? "净利率 %" : "Margin %";
      scen.append(el("div"), hc, ho, gLab, gc, go, mLab, mc, mo);
      const share = el("span", "vc-segc-share");
      const foot = el("span", "vc-segc-e");
      const meta = el("div", "vc-segc-meta"); meta.append(share, foot);
      const mid = el("div", "vc-segc-mid"); mid.append(scen, meta);
      [name, rev, gc, go, mc, mo].forEach((inp) => inp.addEventListener("input", recomputeSeg));
      card.append(top, mid);
      const rec = { name, rev, gc, go, mc, mo, share, foot, el: card };
      del.addEventListener("click", () => { rowEls = rowEls.filter((x) => x !== rec); card.remove(); recomputeSeg(); });
      table.appendChild(card); rowEls.push(rec); return rec;
    }

    addBtn.addEventListener("click", () => { makeRow(); recomputeSeg(); });
    if (fieldEls.n) fieldEls.n.input.addEventListener("input", () => { if (segments.enabled) recomputeSeg(); });

    function setEnabled(on) { segments.enabled = on; body.style.display = on ? "" : "none"; setDriven(on); if (on) recomputeSeg(); else recompute(); }

    if (segments.rows && segments.rows.length) segments.rows.forEach((row) => makeRow(row)); else makeRow();
    if (togLab && togLab.parentNode) togLab.parentNode.removeChild(togLab); // 口径即开关,去掉行内开关
    setEnabled(true);
    return wrap;
  }

  // 资源股 NAV/SOTP 资产表：每资产一行(年现金流 + 可采年限 + 增速保守/乐观)→ 有限寿命 DCF 求和
  function buildAssetSection(getDiscountMid, recompute) {
    const wrap = el("div", "vc-seg");
    const head = el("div", "vc-seg-head");
    const title = el("span", "vc-seg-title"); title.textContent = lang === "zh" ? "资产 / 分部（SOTP）" : "Assets / segments (SOTP)";
    head.appendChild(title);
    const hint = el("div", "vc-asset-hint");
    hint.textContent = lang === "zh"
      ? "每个矿/资产一行：填穿越周期的正常化年现金流、可采年限（替代永续）、增速或衰减。各资产现值加总 − 净负债 = 股权 NAV。"
      : "One row per mine/asset: normalized mid-cycle annual cash flow, reserve life (replaces perpetuity), growth/decline. Σ asset PV − net debt = equity NAV.";
    const table = el("div", "vc-segcards");
    const addBtn = el("button", "vc-seg-add", { type: "button" }); addBtn.textContent = lang === "zh" ? "＋ 添加资产" : "＋ Add asset";
    const summary = el("div", "vc-seg-sum");
    wrap.append(head, hint, table, addBtn, summary);

    let rowEls = [];
    const collect = () => rowEls.map((r) => ({ name: r.name.value, cf: moneyVal(r.cf), L: segNum(r.L), growth: { c: segNum(r.gc), o: segNum(r.go) } }));

    function refresh() {
      const rows = collect();
      assetState.rows = rows;
      const r = getDiscountMid();
      let sumPV = 0, n = 0;
      rowEls.forEach((rec, i) => {
        const x = rows[i];
        const gm = (Number.isFinite(x.growth.c) && Number.isFinite(x.growth.o)) ? (x.growth.c + x.growth.o) / 2 : (Number.isFinite(x.growth.c) ? x.growth.c : x.growth.o);
        const pv = (Number.isFinite(x.cf) && x.L > 0 && Number.isFinite(gm) && Number.isFinite(r)) ? assetPV(x.cf, x.L, gm / 100, r / 100) : NaN;
        rec.pv.textContent = Number.isFinite(pv) ? (lang === "zh" ? `现值≈${fmtMoney(pv)}` : `PV≈${fmtMoney(pv)}`) : "";
        if (Number.isFinite(pv)) { sumPV += pv; n++; }
      });
      summary.textContent = n
        ? (lang === "zh" ? `${n} 项资产 · 现值合计≈${fmtMoney(sumPV)}（折现率取中 ${Number.isFinite(r) ? r.toFixed(1) : "—"}%）` : `${n} assets · ΣPV≈${fmtMoney(sumPV)} (mid rate ${Number.isFinite(r) ? r.toFixed(1) : "—"}%)`)
        : (lang === "zh" ? "添加资产：年现金流 + 可采年限 + 增速" : "Add assets: cash flow + reserve life + growth");
      recompute();
    }

    function makeRow(seed) {
      const card = el("div", "vc-segcard");
      const name = el("input", "vc-input vc-seg-name", { type: "text" }); name.placeholder = lang === "zh" ? "资产名" : "Asset"; if (seed && seed.name) name.value = seed.name;
      const cf = makeMoneyInput(seed && Number.isFinite(Number(seed.cf)) ? Number(seed.cf) : ""); cf.placeholder = lang === "zh" ? "年现金流" : "Annual CF";
      const del = el("button", "vc-segc-del", { type: "button" }); del.textContent = "✕";
      const top = el("div", "vc-segc-top"); top.append(name, cf, del);
      // 可采年限 + 该资产现值
      const metaRow = el("div", "vc-asset-row");
      const lLab = el("span"); lLab.textContent = lang === "zh" ? "可采年限" : "Reserve life";
      const L = makeInput(seed && Number.isFinite(Number(seed.L)) ? Number(seed.L) : 15);
      const yr = el("span"); yr.textContent = lang === "zh" ? "年" : "yr";
      const pv = el("span", "vc-asset-pv");
      metaRow.append(lLab, L, yr, pv);
      // 增速 保守|乐观
      const gc = makeInput(seed && seed.growth ? seed.growth.c : 0), go = makeInput(seed && seed.growth ? seed.growth.o : 3);
      gc.placeholder = lang === "zh" ? "保守" : "cons"; go.placeholder = lang === "zh" ? "乐观" : "opt";
      const scen = el("div", "vc-segscen");
      const hc = el("div", "vc-segscen-h"); hc.textContent = lang === "zh" ? "保守" : "Cons";
      const ho = el("div", "vc-segscen-h"); ho.textContent = lang === "zh" ? "乐观" : "Opt";
      const gLab = el("div", "vc-segscen-lab"); gLab.textContent = lang === "zh" ? "增速/衰减 %" : "Growth %";
      scen.append(el("div"), hc, ho, gLab, gc, go);
      [name, cf, L, gc, go].forEach((inp) => inp.addEventListener("input", refresh));
      card.append(top, metaRow, scen);
      const rec = { name, cf, L, gc, go, pv, el: card };
      del.addEventListener("click", () => { rowEls = rowEls.filter((x) => x !== rec); card.remove(); refresh(); });
      table.appendChild(card); rowEls.push(rec); return rec;
    }

    addBtn.addEventListener("click", () => { makeRow(); refresh(); });
    const seedRows = (assetState.rows && assetState.rows.length) ? assetState.rows
      : [{ name: lang === "zh" ? "主资产" : "Main asset", cf: Number.isFinite(ctx.fcf) ? ctx.fcf : "", L: 15, growth: { c: 0, o: 3 } }];
    seedRows.forEach((row) => makeRow(row));
    refresh();
    wrap._refresh = refresh;
    return wrap;
  }

  function renderForm() {
    formWrap.innerHTML = "";
    // 未选方法：显示提示、清空结果，不预填任何模型
    if (activeIdx < 0) {
      const hint = el("div", "vc-empty-method");
      hint.textContent = lang === "zh" ? "请先选择一个估值方法" : "Pick a valuation method to begin";
      formWrap.appendChild(hint);
      lastForm = {}; lastLow = null; lastHigh = null;
      const dash = tx("dash");
      outLow.textContent = dash; outHigh.textContent = dash; outDash.style.opacity = ".35";
      verdictEl.textContent = ""; verdictEl.style.display = "none";
      bdMount.innerHTML = ""; schedMount.innerHTML = "";
      submitBtn.disabled = true;
      return;
    }
    const model = MODELS[activeIdx];
    if (model.modes) {
      if (!currentMode || !model.modes.some((m) => m.key === currentMode)) {
        currentMode = (initialInputs && initialInputs._mode)
          || (initialInputs && segments && segments.enabled ? "segment" : (initialInputs ? "revenue" : (model.defaultMode || model.modes[0].key)));
        if (!model.modes.some((m) => m.key === currentMode)) currentMode = model.modes[0].key;
      }
    } else { currentMode = null; }
    const fields = modeFields(model, currentMode);
    const readers = [];
    const singles = fields.filter((f) => f.col !== "dual");
    const duals = fields.filter((f) => f.col === "dual");
    const recompute = () => compute(buildForm(readers));
    const fieldEls = {};
    let singlesCard = null, dualsCard = null;
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

    // Inputs（前提）卡：堆叠 标签 + 输入
    if (singles.length) {
      const card = el("div", "vc-card"); singlesCard = card;
      const h = el("div", "vc-card-head"); h.textContent = tx("facts"); card.appendChild(h);
      singles.forEach((field) => {
        const fld = el("div", "vc-fld");
        const { lab, guideRow } = buildLabel(field, "vc-flabel");
        // 起点盈利口径标签:净利润/营收=最新年报(带财年), EPS=TTM —— 切模式时基数会换,显式标出避免误判
        const PERIOD_META = { netIncome: "annual", revenue: "annual", eps: "ttm" };
        const per = PERIOD_META[field.meta];
        if (per) {
          const tag = el("span", "vc-period");
          tag.textContent = per === "ttm" ? "TTM"
            : (Number.isFinite(ctx.annualYear) ? `${lang === "zh" ? "年报 FY" : "FY"}${ctx.annualYear}` : (lang === "zh" ? "年报" : "Annual"));
          tag.title = per === "ttm"
            ? (lang === "zh" ? "默认取滚动 12 个月(TTM)" : "Defaults to trailing twelve months")
            : (lang === "zh" ? "默认取最新年报口径" : "Defaults to latest annual report");
          lab.insertBefore(tag, lab.firstChild ? lab.firstChild.nextSibling : null);
        }
        const money = MONEY_METAS.has(field.meta);
        const input = money ? makeMoneyInput(singleInit(field)) : makeInput(singleInit(field));
        if (!money && field.hint && field.hint[lang]) input.placeholder = field.hint[lang];
        readers.push({ field, getVal: money ? () => moneyVal(input) : () => input.value !== "" ? Number(input.value) : NaN });
        input.addEventListener("input", recompute);
        fld.append(lab, input);
        fieldEls[field.k] = { input, fld };
        const refRow = buildRefRow(field, (v) => { if (money) { input.value = fmtMoney(v); input.dataset.raw = String(v); } else input.value = String(v); recompute(); });
        if (refRow) fld.appendChild(refRow);
        // money 字段：最新财年（实线）+ 近4季 TTM/最新季报（虚线），点击回填，明确标注
        if (money && refData) {
          const an = moneyAnnualRef(field.meta, refData, lang);
          const mq = moneyQuarterRef(field.meta, refData, lang);
          // 扣非净利润(东财,仅 A 股):作为净利润字段的额外可选筹码,不替换普通净利润
          const deducted = field.meta === "netIncome" && Number.isFinite(ctx.deductedNetIncome) ? ctx.deductedNetIncome : null;
          if (an || mq || deducted !== null) {
            const mrow = el("div", "vc-ref");
            const fill = (val) => { input.value = fmtMoney(val); input.dataset.raw = String(val); recompute(); };
            const addChip = (ref, q) => {
              if (!ref) return;
              const b = el("button", "vc-refchip" + (q ? " vc-refq" : "")); b.type = "button";
              b.textContent = `${ref.label} ≈ ${fmtMoney(ref.value)}`;
              b.addEventListener("click", () => fill(ref.value));
              mrow.appendChild(b);
            };
            addChip(an, false);
            addChip(mq, true);
            if (deducted !== null) {
              const b = el("button", "vc-refchip"); b.type = "button";
              b.textContent = `${lang === "zh" ? "扣非" : "Recurring"} ≈ ${fmtMoney(deducted)}`;
              b.addEventListener("click", () => fill(deducted));
              mrow.appendChild(b);
            }
            fld.appendChild(mrow);
          }
        }
        // 美股 EPS:报告口径(调整前,长桥)与调整后(Finnhub 标准化,剔非经常项)并排,均可点回填,默认仍取报告口径
        if (!money && field.meta === "eps" && Number.isFinite(ctx.adjustedEps)) {
          const mrow = el("div", "vc-ref");
          const addEpsChip = (label, val, title) => {
            const b = el("button", "vc-refchip"); b.type = "button";
            b.textContent = `${label} ≈ ${val.toFixed(2)}`;
            if (title) b.title = title;
            b.addEventListener("click", () => { input.value = String(val); recompute(); });
            mrow.appendChild(b);
          };
          if (Number.isFinite(ctx.epsTtm)) addEpsChip(
            lang === "zh" ? "报告·TTM" : "Reported·TTM", ctx.epsTtm,
            lang === "zh" ? "长桥报告口径 EPS(TTM,调整前)" : "Reported EPS (TTM), as filed");
          addEpsChip(
            lang === "zh" ? "调整后·TTM" : "Adj·TTM", ctx.adjustedEps,
            lang === "zh" ? "Finnhub 标准化 EPS(剔非经常项),非公司官方 Non-GAAP,仅参考" : "Finnhub normalized EPS (excl. extraordinary items); not company Non-GAAP — reference only");
          fld.appendChild(mrow);
        }
        if (guideRow) fld.appendChild(guideRow);
        card.appendChild(fld);
      });
      formWrap.appendChild(card);
    }

    // Assumptions（情景假设）卡：每个假设各自成行（字段内输入↔参考紧、字段间留白），列对齐
    if (duals.length) {
      const card = el("div", "vc-card"); dualsCard = card;
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
        fieldEls[field.k] = { c: inC, o: inO, arow };
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
      formWrap.appendChild(card);
    }
    if (currentMode === "segment") {
      // 重排:整体参数(预测年数 + 目标PE)单独成卡置顶;营收/增速/净利率由分部表驱动 → 原前提/情景假设卡隐藏(仍持有隐藏输入喂模型)
      const gcard = el("div", "vc-card");
      const gh = el("div", "vc-card-head"); gh.textContent = lang === "zh" ? "整体参数" : "Overall"; gcard.appendChild(gh);
      if (fieldEls.n && fieldEls.n.fld) gcard.appendChild(fieldEls.n.fld);
      if (fieldEls.targetPE && fieldEls.targetPE.arow) {
        const hr = el("div", "vc-arow vc-arow-head");
        const cc = el("div", "vc-chead"); cc.textContent = tx("conservative");
        const co = el("div", "vc-chead"); co.textContent = tx("optimistic");
        hr.append(el("div"), cc, co);
        gcard.append(hr, fieldEls.targetPE.arow);
      }
      if (singlesCard) singlesCard.style.display = "none";
      if (dualsCard) dualsCard.style.display = "none";
      const segSection = buildSegmentSection(fieldEls, recompute);
      formWrap.insertBefore(gcard, formWrap.children[1] || null); // tabs 之后
      formWrap.insertBefore(segSection, gcard.nextSibling);       // 整体参数之后
    }
    if (model.assetModel) {
      const getDiscountMid = () => {
        const d = fieldEls.discount; if (!d) return NaN;
        const c = d.c.value !== "" ? Number(d.c.value) : NaN, o = d.o.value !== "" ? Number(d.o.value) : NaN;
        return (Number.isFinite(c) && Number.isFinite(o)) ? (c + o) / 2 : (Number.isFinite(c) ? c : o);
      };
      const assetSection = buildAssetSection(getDiscountMid, recompute);
      formWrap.appendChild(assetSection);
      // 折现率改动 → 同步刷新各资产现值显示
      if (fieldEls.discount && assetSection._refresh) [fieldEls.discount.c, fieldEls.discount.o].forEach((i) => i.addEventListener("input", assetSection._refresh));
    }
    recompute();
  }

  function buildForm(readers) { const form = {}; readers.forEach(({ field, getVal }) => { form[field.k] = getVal(); }); if (MODELS[activeIdx] && MODELS[activeIdx].modes) form._mode = currentMode; if (MODELS[activeIdx] && MODELS[activeIdx].assetModel && assetState.rows) form.assets = assetState.rows; return form; }

  renderForm();
}
