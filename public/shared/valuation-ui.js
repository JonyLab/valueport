/**
 * valuation-ui.js — 估值编辑器（Figma「Add Valuation」结构）。
 * 左栏：估值方法下拉 + Inputs(前提) 卡 + Assumptions(情景假设) 卡 + 备注。
 * 右栏：结果卡（低~高 + 判定 + 预测明细 breakdown）+ Submit。
 * 依赖：MODELS/runModel（valuation/index.js）、FIELD_META/fieldReference（field-meta.js）。
 * 导出：mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, refData, verdict, onDone, onCancel })
 *   onDone({ method, inputs, low, high, note })  —— 点 Submit、且低~高有效时触发
 *   verdict(low, high) → { text, cls } | null     —— 由宿主提供（结果卡判定行）
 *   stock: { name, code, mountLogo(el), rows: [[标签, 值], …] } —— 右栏标的资料（可选）
 */
import { METHOD_MENU_GROUPS, MODELS, methodMenuMeta, runModel, modeFields } from "/shared/valuation/index.js";
import { midpointForm, scheduleSeries, sensitivityMatrix } from "/shared/valuation/workbench.js";
import { FIELD_META, fieldReference, moneyAnnualRef, moneyQuarterRef } from "/shared/field-meta.js";
import { derivationForMeta } from "/shared/valuation/derivations.js";
import { aggregateSegments } from "/shared/valuation/segments.js";
import { assetResetValue, COMMODITIES } from "/shared/valuation/resource.js";

const TX = {
  zh: { method: "估值方法", facts: "前提", assume: "情景假设", conservative: "保守", optimistic: "乐观",
        submit: "保存估值", dash: "—", note: "备注", notePh: "为什么给出这个估值？关键逻辑、假设依据、风险…", useRange: "套用区间" },
  en: { method: "Method", facts: "Inputs", assume: "Assumptions", conservative: "Conservative", optimistic: "Optimistic",
        submit: "Save valuation", dash: "—", note: "Note", notePh: "Why this valuation? Key logic, assumptions, risks…", useRange: "Use range" },
};

// Remix Icon 图标（装饰性，读屏跳过）：ri("close-line") → <i class="ri-close-line">
function ri(name) { const i = document.createElement("i"); i.className = "ri-" + name; i.setAttribute("aria-hidden", "true"); return i; }
function el(tag, cls, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) Object.assign(node, attrs);
  return node;
}
function fmt(v, dash) { return (v !== null && isFinite(v)) ? Number(v).toFixed(2) : dash; }
// 大号数字：小数点及之后缩小显示（同 index.html 的 setNum）
function setNum(node, text) {
  const s = String(text ?? ""), i = s.search(/\.\d/);
  node.textContent = i < 0 ? s : s.slice(0, i);
  if (i >= 0) node.appendChild(el("span", "num-dec", { textContent: s.slice(i) }));
}
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
function textFor(obj, lang, fallback = "") {
  return (obj && (obj[lang] || obj.zh || obj.en)) || fallback;
}
function modelTitle(model, lang) {
  const meta = methodMenuMeta(model);
  return textFor(meta && meta.title, lang, (model && model.label && model.label[lang]) || (model && model.key) || "");
}

export function mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, initialDerivations, initialSegments, refData, verdict, onDone, onCancel, stock }) {
  const L = TX[lang] || TX.zh;
  const tx = (k) => L[k];
  // 新增：先进入「选择估值方法」页（activeIdx = -1）；编辑：直接沿用原方法进入工作台。
  let activeIdx = initialMethod ? MODELS.findIndex((m) => m.key === initialMethod) : -1;
  // 预填用的已存假设：只对原方法有效；换了方法就从头开始（同名字段在不同方法里含义不同，不能带过去）
  let seedInputs = initialInputs || null;
  let lastLow = null, lastHigh = null, lastForm = {};
  let currentMode = null;
  const derivations = (initialDerivations && typeof initialDerivations === "object") ? JSON.parse(JSON.stringify(initialDerivations)) : {};
  const segments = (initialSegments && typeof initialSegments === "object" && Array.isArray(initialSegments.rows))
    ? JSON.parse(JSON.stringify(initialSegments)) : { enabled: false, rows: [] };
  // 资源股 NAV/SOTP 的资产明细 + 宏观商品价（随 inputs.assets / inputs.prices 持久化）
  let assetState = { rows: (initialInputs && Array.isArray(initialInputs.assets)) ? JSON.parse(JSON.stringify(initialInputs.assets)) : null };
  let priceState = (initialInputs && initialInputs.prices && typeof initialInputs.prices === "object") ? JSON.parse(JSON.stringify(initialInputs.prices)) : {};
  const round2 = (n) => Math.round(n * 100) / 100;
  // 仅保留当前模型字段的推导,存档时用
  function currentDerivations() {
    const model = MODELS[activeIdx]; if (!model) return {};
    const keys = new Set(modeFields(model, currentMode).map((f) => f.k));
    const out = {}; for (const k in derivations) if (keys.has(k)) out[k] = derivations[k];
    return out;
  }

  mount.innerHTML = "";
  mount.classList.add("vc-mount");
  // 工作台两栏，各自滚动，输入与结论分开：
  //   左「关键假设」= 方法 + 估值用到的数据 + 口径 + 各组假设（填的东西）
  //   右「估值结论」= 标的与现价 + 大号结果 + 区间条 + 估值明细 + 逐年现金流与敏感性 + 备注与保存（算出来的东西）
  // 选择估值方法用弹窗：新增时进来就弹出；编辑时点「更换方法」弹出
  const pickerView = el("div", "vc-picker");
  pickerView.setAttribute("role", "dialog"); pickerView.setAttribute("aria-modal", "true");
  const pickerModal = el("div", "vc-picker-modal");
  pickerView.appendChild(pickerModal);
  const root = el("div", "vc vc-workbench");
  const center = el("section", "vc-col vc-inputs");
  const sideR = el("section", "vc-col vc-results");
  const colHead = (zh, en, subZh, subEn) => {
    const h = el("div", "vc-colhead");
    const t = el("div", "vc-colhead-title"); t.textContent = lang === "zh" ? zh : en;
    const st = el("div", "vc-colhead-sub"); st.textContent = lang === "zh" ? subZh : subEn;
    h.append(t, st); return h;
  };
  const summaryCard = el("div", "vc-hero");
  const vizGrid = el("div", "vc-viz-grid");
  const chartCard = el("section", "vc-result-card vc-chart-card");
  const sensitivityCard = el("section", "vc-result-card vc-sens-card");
  vizGrid.append(chartCard, sensitivityCard);
  root.append(center, sideR);
  mount.append(pickerView, root);

  // ── 选择估值方法弹窗（按口径分组的卡片，每张写清适用于什么样的公司）──
  const methodBar = el("div", "vc-pgroups");
  methodBar.setAttribute("role", "radiogroup");
  methodBar.setAttribute("aria-label", lang === "zh" ? "估值方法" : "Valuation method");
  const pickHead = el("div", "vc-picker-head");
  const pickTitle = el("div", "vc-picker-title");
  const pickSub = el("div", "vc-picker-sub");
  const pickWarn = el("div", "vc-picker-warn");
  const pickClose = el("button", "btn icon sm vc-picker-close", { type: "button" });
  pickClose.setAttribute("aria-label", lang === "zh" ? "关闭" : "Close");
  pickClose.appendChild(ri("close-line"));
  pickClose.addEventListener("click", () => closePicker());
  const pickTop = el("div", "vc-picker-top"); pickTop.append(pickTitle, pickClose);
  pickHead.append(pickTop, pickSub, pickWarn);
  pickerModal.append(pickHead, methodBar);
  // 关闭：还没选过方法（新增）→ 退出工作台回详情；已有方法（更换）→ 保持原方法
  function closePicker() { if (activeIdx < 0) { if (typeof onCancel === "function") onCancel(); } else showPicker(false); }
  pickerView.addEventListener("click", (e) => { if (e.target === pickerView) closePicker(); });
  // Esc 只关弹窗：捕获阶段先接住，避免宿主页的全局 Esc 顺带退出整个编辑器
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || pickerView.hidden || !pickerView.isConnected) return;
    e.stopImmediatePropagation(); e.preventDefault(); closePicker();
  }, true);
  function buildMethodMenu() {
    methodBar.innerHTML = "";
    const byKey = new Map(MODELS.map((model, idx) => [model.key, { model, idx }]));
    METHOD_MENU_GROUPS.forEach((group) => {
      const available = group.methods.map((method) => ({ method, entry: byKey.get(method.key) })).filter((x) => x.entry);
      if (!available.length) return;
      const g = el("section", "vc-pgroup");
      const lab = el("div", "vc-pgroup-lab"); lab.textContent = textFor(group.title, lang, group.key);
      const items = el("div", "vc-pcards");
      available.forEach(({ method, entry }) => {
        const b = el("button", "vc-pcard", { type: "button" });
        b.setAttribute("role", "radio");
        b.dataset.idx = String(entry.idx);
        const tt = el("span", "vc-pcard-title"); tt.textContent = textFor(method.title, lang, modelTitle(entry.model, lang));
        const st = el("span", "vc-pcard-sub"); st.textContent = textFor(method.subtitle, lang, "");
        const cur = el("span", "vc-pcard-cur"); cur.textContent = lang === "zh" ? "当前方法" : "Current";
        b.append(tt, st, cur);
        b.addEventListener("click", () => {
          if (entry.idx === activeIdx) { showPicker(false); return; }
          // 编辑已存估值时换方法：已填假设不保留
          if (initialMethod && MODELS[entry.idx].key !== initialMethod) seedInputs = null;
          if (initialMethod && MODELS[entry.idx].key === initialMethod) seedInputs = initialInputs || null;
          selectMethod(entry.idx);
          showPicker(false);
        });
        items.appendChild(b);
      });
      g.append(lab, items);
      methodBar.appendChild(g);
    });
  }
  function updatePickerLabel() {
    methodBar.querySelectorAll(".vc-pcard").forEach((b) => {
      const on = Number(b.dataset.idx) === activeIdx;
      b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  function selectMethod(idx) {
    activeIdx = idx;
    currentMode = null;
    updatePickerLabel();
    updateMethodDesc();
    renderForm();
  }
  // 打开 / 关闭选方法弹窗；已有方法时（更换）显示「不保留已填假设」提醒
  function showPicker(open) {
    const changing = activeIdx >= 0;
    pickTitle.textContent = changing ? (lang === "zh" ? "更换估值方法" : "Change method") : (lang === "zh" ? "选择估值方法" : "Choose a valuation method");
    pickSub.textContent = lang === "zh"
      ? "按公司类型选：银行保险看 P/B，稳定分红用 DDM，现金流可预测用 DCF，尚未盈利的成长股用 P/S，资源股用 NAV。想交叉验证，就再添加一张用别的方法的估值卡。"
      : "Pick by business type: P/B for banks and insurers, DDM for steady dividend payers, DCF when cash flows are predictable, P/S for growth names not yet profitable, NAV for resource stocks. To cross-check, add another card with a different method.";
    pickWarn.textContent = changing ? (lang === "zh" ? "切换后，已填的假设不会保留。" : "Switching clears the assumptions you have entered.") : "";
    pickWarn.style.display = changing ? "" : "none";
    pickerView.hidden = !open;
    if (open) { const cur = methodBar.querySelector(".vc-pcard.on") || methodBar.querySelector(".vc-pcard"); if (cur) requestAnimationFrame(() => cur.focus()); }
  }
  // 当前方法的标题 + 适用说明 + 「更换方法」（中栏顶部）
  const methodHead = el("div", "vc-method-head");
  const methodRow = el("div", "vc-method-row");
  const methodName = el("div", "vc-method-name");
  const changeBtn = el("button", "vc-method-change", { type: "button" });
  changeBtn.replaceChildren(ri("arrow-left-right-line"), document.createTextNode(lang === "zh" ? "更换方法" : "Change method"));
  changeBtn.addEventListener("click", () => showPicker(true));
  methodRow.append(methodName, changeBtn);
  const methodDesc = el("div", "vc-method-desc");
  methodHead.append(methodRow, methodDesc);
  function updateMethodDesc() {
    const model = activeIdx >= 0 ? MODELS[activeIdx] : null;
    const meta = model ? methodMenuMeta(model) : null;
    methodName.textContent = model ? textFor(meta && meta.title, lang, modelTitle(model, lang)) : (lang === "zh" ? "选择估值方法" : "Choose a method");
    methodDesc.textContent = meta ? textFor(meta.subtitle, lang, "") : (lang === "zh" ? "从左侧选一种估值方法开始。" : "Pick a method on the left to begin.");
  }
  buildMethodMenu();
  updatePickerLabel();
  updateMethodDesc();
  showPicker(activeIdx < 0); // 新增：先选方法

  const formWrap = el("div", "vc-form");

  // ── 备注（右栏底部，和保存按钮一起）──
  const noteWrap = el("div", "vc-note");
  const noteLabel = el("div", "vc-note-label"); noteLabel.textContent = tx("note");
  const noteInput = el("textarea", "vc-note-input"); noteInput.placeholder = tx("notePh");
  if (initialNote) noteInput.value = initialNote;
  noteWrap.append(noteLabel, noteInput);

  // ── 中栏顶部：大号估值结果（区间 / 现价）+ 判定 + 区间 vs 现价条 ──
  const summaryLabel = el("div", "vc-summary-label");
  summaryLabel.textContent = lang === "zh" ? "合理价值区间" : "Fair value range";
  const nums = el("div", "vc-rnums");
  const outLow = el("span", "vc-rlow"), outDash = el("span", "vc-rdash"), outHigh = el("span", "vc-rhigh");
  outDash.textContent = "–";
  nums.append(outLow, outDash, outHigh);
  const verdictEl = el("div", "vc-rverdict");
  const bdMount = el("div", "vc-summary-metrics");
  const schedMount = el("div", "vc-sched");
  const emptyHint = el("div", "vc-summary-empty");
  emptyHint.textContent = lang === "zh" ? "填写左侧的关键假设，这里会实时算出合理价值区间，并和现价对照。" : "Fill in the assumptions on the left — the fair-value range is computed here live and compared with the price.";
  const rangeViz = el("div", "vc-rangeviz");
  const nowPx = el("span", "vc-rnow");
  if (ctx && ctx.price > 0) nowPx.textContent = (lang === "zh" ? " / 现价 " : " / Price ") + fmt(ctx.price, "—");
  const heroTop = el("div", "vc-hero-top");
  const heroNums = el("div", "vc-hero-nums"); heroNums.append(nums, nowPx);
  heroTop.append(heroNums, verdictEl);
  // 保守 = 乐观时结果只是一个值：只显示一个数，并提示拉开两档
  const pointHint = el("div", "vc-point-hint");
  pointHint.textContent = lang === "zh" ? "保守与乐观假设相同，结果是单一估值；拉开两档就能得到区间。" : "Conservative and optimistic are identical, so this is a single value — spread them to get a range.";
  pointHint.style.display = "none";
  summaryCard.append(summaryLabel, heroTop, pointHint, emptyHint, rangeViz);
  // 区间 vs 现价：一条轴上画出低~高区间和现价位置
  function renderRangeViz(lo, hi, valid) {
    rangeViz.innerHTML = "";
    const p = ctx && ctx.price;
    if (!valid || !(p > 0)) { rangeViz.style.display = "none"; return; }
    rangeViz.style.display = "";
    const a = Math.min(lo, hi), b = Math.max(lo, hi);
    let min = Math.min(a, p), max = Math.max(b, p);
    const pad = (max - min) * 0.15 || max * 0.1; min = Math.max(0, min - pad); max += pad;
    const X = (v) => ((v - min) / (max - min) * 100).toFixed(2) + "%";
    const track = el("div", "vc-rv-track");
    const band = el("div", "vc-rv-band"); band.style.left = X(a); band.style.width = `calc(${X(b)} - ${X(a)})`;
    const now = el("div", "vc-rv-now"); now.style.left = X(p);
    const tag = el("span", "vc-rv-tag"); tag.textContent = (lang === "zh" ? "现价 " : "Price ") + fmt(p, "—"); now.appendChild(tag);
    const l0 = el("span", "vc-rv-end"); l0.style.left = X(a); l0.textContent = fmt(a, "—");
    const l1 = el("span", "vc-rv-end"); l1.style.left = X(b); l1.textContent = fmt(b, "—");
    track.append(band, now, l0, l1);
    rangeViz.appendChild(track);
  }

  const submitBtn = el("button", "vc-submit"); submitBtn.type = "button"; submitBtn.textContent = tx("submit"); submitBtn.disabled = true;
  submitBtn.addEventListener("click", () => {
    if (lastLow === null || lastHigh === null || !isFinite(lastLow) || !isFinite(lastHigh)) return;
    const segOut = currentMode === "segment" ? { enabled: true, rows: segments.rows } : { enabled: false, rows: segments.rows || [] };
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, derivations: currentDerivations(), segments: segOut, low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh), note: noteInput.value.trim() });
  });
  // ── 标的（logo · 名称 · 代码 · 现价，放结论栏顶）· 估值用到的数据（放输入栏）· 估值明细 · 备注与保存 ──
  const prof = el("div", "vc-prof");
  const avatar = el("div", "vc-prof-av");
  if (stock && typeof stock.mountLogo === "function") stock.mountLogo(avatar);
  const pid = el("div", "vc-prof-id");
  const pname = el("div", "vc-prof-name"); pname.textContent = (stock && stock.name) || "";
  const pcode = el("div", "vc-prof-code"); pcode.textContent = (stock && stock.code) || "";
  pid.append(pname, pcode);
  const ppx = el("div", "vc-prof-px");
  if (ctx && ctx.price > 0) setNum(ppx, fmt(ctx.price, "—"));
  prof.append(avatar, pid, ppx);
  const infoSec = el("div", "vc-prof-sec");
  const infoTitle = el("div", "vc-prof-title"); infoTitle.textContent = lang === "zh" ? "估值用到的数据" : "Inputs from data";
  infoSec.appendChild(infoTitle);
  ((stock && stock.rows) || []).forEach(([k, v]) => {
    const r = el("div", "vc-kv"); const kk = el("span", "vc-kv-k"); kk.textContent = k; const vv = el("span", "vc-kv-v"); vv.textContent = v;
    r.append(kk, el("span", "vc-kv-dots"), vv); infoSec.appendChild(r);
  });
  const bdSec = el("div", "vc-prof-sec");
  const bdTitle = el("div", "vc-prof-title"); bdTitle.textContent = lang === "zh" ? "估值明细" : "Breakdown";
  bdSec.append(bdTitle, bdMount);
  const saveBar = el("div", "vc-savebar");
  saveBar.append(noteWrap, submitBtn);
  center.append(colHead("关键假设", "Assumptions", "选方法、核对数据、填写保守与乐观两档假设", "Pick a method, check the data, fill in conservative and optimistic cases"),
    methodHead, infoSec, formWrap);
  sideR.append(colHead("估值结论", "Result", "根据左侧假设实时计算", "Computed live from the assumptions"),
    prof, summaryCard, bdSec, schedMount, vizGrid, saveBar);

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
    if (form.prices) { cons.prices = opt.prices = form.prices; }
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
    if (form.prices) v.prices = form.prices;
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
    const toggle = el("button", "vc-sched-toggle"); toggle.type = "button";
    const setToggle = (open) => toggle.replaceChildren(document.createTextNode(title), ri(open ? "arrow-up-s-line" : "arrow-down-s-line"));
    setToggle(false);
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
    toggle.addEventListener("click", () => { const open = body.style.display === "none"; body.style.display = open ? "" : "none"; setToggle(open); });
    schedMount.append(toggle, body);
  }
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
  function renderSensitivity(model, form, valid) {
    sensitivityCard.innerHTML = "";
    sensitivityCard.style.display = "none";
    if (!valid) return;
    const matrix = sensitivityMatrix({ model, mode: currentMode, form, ctx, run: runModel, lang });
    if (!matrix) return;

    sensitivityCard.style.display = "";
    const title = el("div", "vc-card-title");
    title.textContent = lang === "zh" ? "敏感性分析" : "Sensitivity analysis";
    const table = el("div", "vc-sens-table");
    const head = el("div", "vc-sens-row vc-sens-head");
    // 角格标注「行」变量（↓），表上方小标题标注「列」变量（→），避免两者读反
    const corner = el("div", "vc-sens-axis");
    corner.replaceChildren(document.createTextNode(matrix.y.label), ri("arrow-down-line"));
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
    yTitle.replaceChildren(document.createTextNode(matrix.x.label), ri("arrow-right-line"));
    sensitivityCard.append(title, yTitle, table);
  }
  function compute(formData) {
    lastForm = formData;
    const model = MODELS[activeIdx];
    let r = { low: null, high: null };
    try { r = runModel(model, formData, ctx); } catch { /* 输入不完整 */ }
    lastLow = r.low; lastHigh = r.high;
    const dash = tx("dash");
    const valid = lastLow !== null && lastHigh !== null && isFinite(lastLow) && isFinite(lastHigh);
    setNum(outLow, fmt(lastLow, dash)); setNum(outHigh, fmt(lastHigh, dash));
    outDash.style.opacity = valid ? "1" : ".35";
    let v = null;
    if (valid && typeof verdict === "function") { try { v = verdict(Math.min(lastLow, lastHigh), Math.max(lastLow, lastHigh)); } catch { v = null; } }
    if (v && (!v.text || v.text === "—")) v = null; // 低=高（保守与乐观相同）时宿主给不出判定，不显示空徽章
    verdictEl.textContent = v ? v.text : "";
    verdictEl.className = "vc-rverdict " + (v && v.cls ? v.cls : "");
    verdictEl.style.display = v ? "" : "none";
    heroTop.style.display = valid ? "" : "none";
    const point = valid && Math.abs(lastHigh - lastLow) < 1e-9;
    outDash.style.display = outHigh.style.display = point ? "none" : "";
    pointHint.style.display = point ? "" : "none";
    emptyHint.style.display = valid ? "none" : "";
    renderRangeViz(lastLow, lastHigh, valid);
    renderBreakdown(model, formData, valid);
    renderSchedule(model, formData, valid);
    renderChart(model, formData, valid);
    renderSensitivity(model, formData, valid);
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
      const info = el("button", "vc-info"); info.type = "button"; info.appendChild(ri("information-line")); info.setAttribute("aria-label", lang === "zh" ? "估值提示" : "Valuation tip");
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
      a.appendChild(ri("external-link-line")); a.title = lang === "zh" ? "查看年报出处" : "View annual report";
      row.appendChild(a);
    }
    return row;
  }
  // 「▾ 推导」折叠 + 子面板;写回 inC/inO 并维护 derivations[field.k]
  function derivToggleContent(open) { return [ri(open ? "arrow-up-s-line" : "arrow-down-s-line"), document.createTextNode(lang === "zh" ? "推导" : "Derive")]; }
  function buildDerivation(field, deriv, inC, inO, recompute) {
    const wrap = el("div", "vc-deriv"); wrap.style.gridColumn = "1 / -1";
    const toggle = el("button", "vc-deriv-toggle", { type: "button" });
    const bodyBox = el("div", "vc-deriv-body");
    let open = false;
    const sync = () => { toggle.replaceChildren(...derivToggleContent(open)); bodyBox.style.display = open ? "" : "none"; };
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
    if (seedInputs && Object.prototype.hasOwnProperty.call(seedInputs, field.k)) {
      const v = seedInputs[field.k];
      if (typeof v === "number") return v;
    }
    return initialFor(field, ctx);
  }
  function dualInit(field) {
    if (seedInputs && seedInputs[field.k] && typeof seedInputs[field.k] === "object") {
      return { c: seedInputs[field.k].c, o: seedInputs[field.k].o };
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
    const addBtn = el("button", "vc-seg-add", { type: "button" }); addBtn.replaceChildren(ri("add-line"), document.createTextNode(lang === "zh" ? "添加分部" : "Add segment"));
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
      const del = el("button", "vc-segc-del", { type: "button" }); del.appendChild(ri("close-line")); del.setAttribute("aria-label", lang === "zh" ? "删除" : "Remove");
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

  // 资源股 NAV/SOTP：宏观商品价（保守/乐观，自动跟随在产矿出现）+ 资产表（在产矿 / 固定值包）
  function buildResourceSection(getMacro, recompute) {
    const wrap = el("div");
    // ── 宏观商品价 ──
    const priceBox = el("div", "vc-seg");
    const ph = el("div", "vc-seg-head"); const pt = el("span", "vc-seg-title"); pt.textContent = lang === "zh" ? "宏观商品价（保守 / 乐观）" : "Commodity prices (cons / opt)"; ph.appendChild(pt);
    const priceRows = el("div", "vc-pricerows");
    priceBox.append(ph, priceRows);
    // ── 资产表 ──
    const assetBox = el("div", "vc-seg");
    const ah = el("div", "vc-seg-head"); const at = el("span", "vc-seg-title"); at.textContent = lang === "zh" ? "资产 / 分部（SOTP）" : "Assets / segments (SOTP)"; ah.appendChild(at);
    const hint = el("div", "vc-asset-hint");
    hint.textContent = lang === "zh"
      ? "在产矿：年产量×(商品价−完全成本)×(1−税率)×年金系数(寿命,WACC)，无永续。固定值包：锂等业务直接填现值。期权：未开发储量用 Black-Scholes 实时估值(随商品价变动)。"
      : "Mine: output×(price−cost)×(1−tax)×annuity(life,WACC), no perpetuity. Fixed pack: direct PV (e.g. lithium). Option: undeveloped reserves via Black-Scholes.";
    const table = el("div", "vc-segcards");
    const btns = el("div", "vc-asset-btns");
    const addMine = el("button", "vc-seg-add", { type: "button" }); addMine.replaceChildren(ri("add-line"), document.createTextNode(lang === "zh" ? "在产矿" : "Mine"));
    const addFixed = el("button", "vc-seg-add", { type: "button" }); addFixed.replaceChildren(ri("add-line"), document.createTextNode(lang === "zh" ? "固定值包" : "Fixed pack"));
    const addOption = el("button", "vc-seg-add", { type: "button" }); addOption.replaceChildren(ri("add-line"), document.createTextNode(lang === "zh" ? "期权(未开发)" : "Option"));
    btns.append(addMine, addFixed, addOption);
    const summary = el("div", "vc-seg-sum");
    assetBox.append(ah, hint, table, btns, summary);
    wrap.append(priceBox, assetBox);

    let rowEls = [];
    const priceInputs = {}; // commodity -> {c, o}
    let lastUsedKey = null;  // 商品集合指纹，未变则不重建价格输入（保住焦点与已填值）
    const collect = () => rowEls.map((r) => r.collect());

    function usedCommodities() {
      const set = new Set();
      collect().forEach((a) => { if ((a.type === "mine" || a.type === "option") && a.commodity) set.add(a.commodity); });
      return [...set];
    }
    function readPrices() {
      const out = {};
      Object.keys(priceInputs).forEach((com) => { const p = priceInputs[com]; out[com] = { c: p.c.value !== "" ? Number(p.c.value) : NaN, o: p.o.value !== "" ? Number(p.o.value) : NaN }; });
      priceState = out;
    }
    function syncPrices() {
      const used = usedCommodities();
      const key = used.slice().sort().join(",");
      if (key === lastUsedKey) return; // 商品集合未变 → 不重建 DOM（避免输入时丢焦点/丢值）
      if (Object.keys(priceInputs).length) readPrices(); // 重建前先把现有输入存进 priceState
      lastUsedKey = key;
      Object.keys(priceInputs).forEach((k) => delete priceInputs[k]);
      priceRows.innerHTML = "";
      if (!used.length) { const e = el("div", "vc-asset-hint"); e.textContent = lang === "zh" ? "下方添加在产矿后，这里出现对应商品的长期基准价。" : "Add a mine below; its commodity price appears here."; priceRows.appendChild(e); return; }
      const hdr = el("div", "vc-price-row vc-price-hdr"); hdr.append(el("span"), (() => { const s = el("span"); s.textContent = lang === "zh" ? "保守" : "Cons"; return s; })(), (() => { const s = el("span"); s.textContent = lang === "zh" ? "乐观" : "Opt"; return s; })()); priceRows.appendChild(hdr);
      used.forEach((com) => {
        const def = COMMODITIES[com]; const cur = (priceState && priceState[com]) || def.price;
        const row = el("div", "vc-price-row");
        const lab = el("span", "vc-price-lab"); lab.textContent = `${def.label[lang]} ${def.priceUnit[lang]}`;
        const ic = makeInput(Number.isFinite(Number(cur.c)) ? cur.c : def.price.c), io = makeInput(Number.isFinite(Number(cur.o)) ? cur.o : def.price.o);
        ic.addEventListener("input", () => { readPrices(); refresh(); }); io.addEventListener("input", () => { readPrices(); refresh(); });
        priceInputs[com] = { c: ic, o: io };
        row.append(lab, ic, io); priceRows.appendChild(row);
      });
      readPrices();
    }

    function refresh() {
      assetState.rows = collect();
      syncPrices();
      const { wMid, tax } = getMacro();
      const priceOf = (com) => { const p = priceState[com]; if (p && Number.isFinite(p.c) && Number.isFinite(p.o)) return (p.c + p.o) / 2; const d = COMMODITIES[com] && COMMODITIES[com].price; return d ? (d.c + d.o) / 2 : NaN; };
      let sum = 0, n = 0;
      rowEls.forEach((r) => {
        const a = r.collect();
        const v = assetResetValue(a, priceOf, wMid, tax);
        r.setReset(Number.isFinite(v) ? (lang === "zh" ? `重置值≈${fmtMoney(v)}` : `≈${fmtMoney(v)}`) : "");
        if (Number.isFinite(v)) { sum += v; n++; }
      });
      summary.textContent = n
        ? (lang === "zh" ? `${n} 项资产 · 重置现值合计≈${fmtMoney(sum)}（价取中 · WACC ${Number.isFinite(wMid) ? wMid.toFixed(1) : "—"}%）` : `${n} assets · Σ≈${fmtMoney(sum)} (mid price · WACC ${Number.isFinite(wMid) ? wMid.toFixed(1) : "—"}%)`)
        : (lang === "zh" ? "添加资产：在产矿（产量/成本/寿命）或固定值包" : "Add a mine (output/cost/life) or a fixed pack");
      recompute();
    }

    function delRow(rec) { rowEls = rowEls.filter((x) => x !== rec); rec.el.remove(); refresh(); }

    function makeMineRow(seed) {
      const card = el("div", "vc-segcard");
      const name = el("input", "vc-input vc-seg-name", { type: "text" }); name.placeholder = lang === "zh" ? "矿名" : "Mine"; if (seed && seed.name) name.value = seed.name;
      const sel = el("select", "vc-input vc-asset-com");
      Object.keys(COMMODITIES).forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = COMMODITIES[k].label[lang]; sel.appendChild(o); });
      sel.value = (seed && seed.commodity) || "copper";
      const del = el("button", "vc-segc-del", { type: "button" }); del.appendChild(ri("close-line")); del.setAttribute("aria-label", lang === "zh" ? "删除" : "Remove");
      const top = el("div", "vc-segc-top"); top.append(name, sel, del);
      const comDef = () => COMMODITIES[sel.value];
      // 产量 + 完全成本
      const row1 = el("div", "vc-asset-row");
      const out = makeInput(seed && Number.isFinite(Number(seed.output)) ? seed.output : ""); out.placeholder = lang === "zh" ? "权益年产量" : "Output";
      const outU = el("span", "vc-asset-u"); const cost = makeInput(seed && Number.isFinite(Number(seed.unitCost)) ? seed.unitCost : ""); cost.placeholder = lang === "zh" ? "完全成本" : "Unit cost";
      const costU = el("span", "vc-asset-u");
      row1.append(out, outU, cost, costU);
      // 寿命 + 重置值
      const row2 = el("div", "vc-asset-row");
      const life = makeInput(seed && Number.isFinite(Number(seed.life)) ? seed.life : 20); life.placeholder = lang === "zh" ? "寿命" : "Life";
      const lifeU = el("span"); lifeU.textContent = lang === "zh" ? "年寿命" : "yr life";
      const reset = el("span", "vc-asset-pv");
      row2.append(life, lifeU, reset);
      const syncU = () => { const d = comDef(); outU.textContent = d.outUnit[lang]; costU.textContent = d.priceUnit[lang]; };
      syncU();
      [name, out, cost, life].forEach((inp) => inp.addEventListener("input", refresh));
      sel.addEventListener("change", () => { syncU(); refresh(); });
      card.append(top, row1, row2);
      const rec = { el: card, setReset: (t) => { reset.textContent = t; }, collect: () => ({ type: "mine", name: name.value, commodity: sel.value, output: segNum(out), unitCost: segNum(cost), life: segNum(life) }) };
      del.addEventListener("click", () => delRow(rec));
      table.appendChild(card); rowEls.push(rec); return rec;
    }

    function makeFixedRow(seed) {
      const card = el("div", "vc-segcard");
      const name = el("input", "vc-input vc-seg-name", { type: "text" }); name.placeholder = lang === "zh" ? "资产包名（如 锂板块 / 未开发期权）" : "Fixed pack"; if (seed && seed.name) name.value = seed.name;
      const tag = el("span", "vc-asset-tag"); tag.textContent = lang === "zh" ? "固定值" : "Fixed";
      const del = el("button", "vc-segc-del", { type: "button" }); del.appendChild(ri("close-line")); del.setAttribute("aria-label", lang === "zh" ? "删除" : "Remove");
      const top = el("div", "vc-segc-top"); top.append(name, tag, del);
      const row = el("div", "vc-asset-row");
      const val = makeMoneyInput(seed && Number.isFinite(Number(seed.value)) ? Number(seed.value) : ""); val.placeholder = lang === "zh" ? "现值" : "Value";
      const reset = el("span", "vc-asset-pv");
      row.append(val, reset);
      [name, val].forEach((inp) => inp.addEventListener("input", refresh));
      card.append(top, row);
      const rec = { el: card, setReset: (t) => { reset.textContent = t; }, collect: () => ({ type: "fixed", name: name.value, value: moneyVal(val) }) };
      del.addEventListener("click", () => delRow(rec));
      table.appendChild(card); rowEls.push(rec); return rec;
    }

    // 未开发储量实物期权（Black–Scholes 自动重塑）
    function makeOptionRow(seed) {
      const card = el("div", "vc-segcard");
      const name = el("input", "vc-input vc-seg-name", { type: "text" }); name.placeholder = lang === "zh" ? "未开发储量期权" : "Undeveloped option"; if (seed && seed.name) name.value = seed.name;
      const sel = el("select", "vc-input vc-asset-com");
      Object.keys(COMMODITIES).forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = COMMODITIES[k].label[lang]; sel.appendChild(o); });
      sel.value = (seed && seed.commodity) || "copper";
      const tag = el("span", "vc-asset-tag"); tag.textContent = "B-S";
      const del = el("button", "vc-segc-del", { type: "button" }); del.appendChild(ri("close-line")); del.setAttribute("aria-label", lang === "zh" ? "删除" : "Remove");
      const top = el("div", "vc-segc-top"); top.append(name, sel, tag, del);
      const comDef = () => COMMODITIES[sel.value];
      // 行1：储量 + 单位边际成本
      const r1 = el("div", "vc-asset-row");
      const reserves = makeInput(seed && Number.isFinite(Number(seed.reserves)) ? seed.reserves : ""); reserves.placeholder = lang === "zh" ? "储量" : "Reserves";
      const rU = el("span", "vc-asset-u");
      const mc = makeInput(seed && Number.isFinite(Number(seed.marginalCost)) ? seed.marginalCost : ""); mc.placeholder = lang === "zh" ? "单位边际成本" : "Unit cost";
      const mcU = el("span", "vc-asset-u");
      r1.append(reserves, rU, mc, mcU);
      // 行2：开发成本现值 + 波动率
      const r2 = el("div", "vc-asset-row");
      const dev = makeMoneyInput(seed && Number.isFinite(Number(seed.devCost)) ? Number(seed.devCost) : ""); dev.placeholder = lang === "zh" ? "开发成本现值" : "Dev cost PV";
      const sig = makeInput(seed && Number.isFinite(Number(seed.sigma)) ? seed.sigma : 30); sig.placeholder = "σ"; const sigU = el("span", "vc-asset-u"); sigU.textContent = lang === "zh" ? "% 波动率" : "% vol";
      r2.append(dev, sig, sigU);
      // 行3：放弃年限 + 无风险利率 + 重置值
      const r3 = el("div", "vc-asset-row");
      const yrs = makeInput(seed && Number.isFinite(Number(seed.years)) ? seed.years : 10); yrs.placeholder = "T"; const yU = el("span", "vc-asset-u"); yU.textContent = lang === "zh" ? "年" : "yr";
      const rf = makeInput(seed && Number.isFinite(Number(seed.rf)) ? seed.rf : 3); rf.placeholder = "rf"; const rfU = el("span", "vc-asset-u"); rfU.textContent = lang === "zh" ? "% 无风险" : "% rf";
      const reset = el("span", "vc-asset-pv");
      r3.append(yrs, yU, rf, rfU, reset);
      const syncU = () => { const d = comDef(); rU.textContent = d.outUnit[lang]; mcU.textContent = d.priceUnit[lang]; };
      syncU();
      [name, reserves, mc, dev, sig, yrs, rf].forEach((inp) => inp.addEventListener("input", refresh));
      sel.addEventListener("change", () => { syncU(); refresh(); });
      card.append(top, r1, r2, r3);
      const rec = { el: card, setReset: (t) => { reset.textContent = t; }, collect: () => ({ type: "option", name: name.value, commodity: sel.value, reserves: segNum(reserves), marginalCost: segNum(mc), devCost: moneyVal(dev), sigma: segNum(sig), years: segNum(yrs), rf: segNum(rf), annualCf: NaN }) };
      del.addEventListener("click", () => delRow(rec));
      table.appendChild(card); rowEls.push(rec); return rec;
    }

    function makeRow(seed) { return (seed && seed.type === "fixed") ? makeFixedRow(seed) : (seed && seed.type === "option") ? makeOptionRow(seed) : makeMineRow(seed); }

    addMine.addEventListener("click", () => { makeMineRow(); refresh(); });
    addFixed.addEventListener("click", () => { makeFixedRow(); refresh(); });
    addOption.addEventListener("click", () => { makeOptionRow(); refresh(); });
    const seedRows = (assetState.rows && assetState.rows.length) ? assetState.rows
      : [{ type: "mine", name: lang === "zh" ? "主力矿" : "Main mine", commodity: "copper", output: "", unitCost: "", life: 20 }];
    seedRows.forEach((row) => makeRow(row));
    refresh();
    wrap._refresh = refresh;
    return wrap;
  }

  function renderForm() {
    formWrap.innerHTML = "";
    // 未选方法：显示提示、清空结果，不预填任何模型
    if (activeIdx < 0) {
      updatePickerLabel();
      updateMethodDesc();
      const hint = el("div", "vc-empty-method");
      hint.textContent = lang === "zh" ? "请先选择一个估值方法" : "Pick a valuation method to begin";
      formWrap.appendChild(hint);
      lastForm = {}; lastLow = null; lastHigh = null;
      const dash = tx("dash");
      outLow.textContent = dash; outHigh.textContent = dash; outDash.style.opacity = ".35";
      verdictEl.textContent = ""; verdictEl.style.display = "none";
      heroTop.style.display = "none"; pointHint.style.display = "none"; emptyHint.style.display = ""; renderRangeViz(null, null, false);
      bdMount.innerHTML = ""; schedMount.innerHTML = "";
      chartCard.style.display = "none";
      sensitivityCard.style.display = "none";
      submitBtn.disabled = true;
      return;
    }
    const model = MODELS[activeIdx];
    updatePickerLabel();
    updateMethodDesc();
    if (model.modes) {
      if (!currentMode || !model.modes.some((m) => m.key === currentMode)) {
        currentMode = (seedInputs && seedInputs._mode)
          || (seedInputs && segments && segments.enabled ? "segment" : (seedInputs ? "revenue" : (model.defaultMode || model.modes[0].key)));
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
      const card = el("div", "vc-card" + (singles.length > 1 ? " vc-singles-grid" : "")); singlesCard = card;
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
      const getMacro = () => {
        const d = fieldEls.wacc, t = fieldEls.taxRate;
        const wc = d && d.c.value !== "" ? Number(d.c.value) : NaN, wo = d && d.o.value !== "" ? Number(d.o.value) : NaN;
        const wMid = (Number.isFinite(wc) && Number.isFinite(wo)) ? (wc + wo) / 2 : (Number.isFinite(wc) ? wc : wo);
        const tax = t && t.input.value !== "" ? Number(t.input.value) : NaN;
        return { wMid, tax };
      };
      const section = buildResourceSection(getMacro, recompute);
      formWrap.appendChild(section);
      // WACC / 税率改动 → 同步刷新各资产重置值显示
      const macroInputs = [];
      if (fieldEls.wacc) macroInputs.push(fieldEls.wacc.c, fieldEls.wacc.o);
      if (fieldEls.taxRate) macroInputs.push(fieldEls.taxRate.input);
      if (section._refresh) macroInputs.forEach((i) => i.addEventListener("input", section._refresh));
    }

    recompute();
  }

  function buildForm(readers) { const form = {}; readers.forEach(({ field, getVal }) => { form[field.k] = getVal(); }); if (MODELS[activeIdx] && MODELS[activeIdx].modes) form._mode = currentMode; if (MODELS[activeIdx] && MODELS[activeIdx].assetModel) { if (assetState.rows) form.assets = assetState.rows; form.prices = priceState; } return form; }

  renderForm();
}
