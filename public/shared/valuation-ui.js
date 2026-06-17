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
import { FIELD_META, fieldReference } from "/shared/field-meta.js";

const TX = {
  zh: { intrinsic: "内在价值", relative: "相对估值", facts: "前提", assume: "情景假设",
        conservative: "保守", optimistic: "乐观", fair: "合理价值", done: "完成", cancel: "取消", dash: "—",
        note: "备注", notePh: "为什么给出这个估值？关键逻辑、假设依据、风险…" },
  en: { intrinsic: "Intrinsic", relative: "Relative", facts: "Inputs", assume: "Assumptions",
        conservative: "Conservative", optimistic: "Optimistic", fair: "Fair value", done: "Done", cancel: "Cancel", dash: "—",
        note: "Note", notePh: "Why this valuation? Key logic, assumptions, risks…" },
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

export function mountValuationCalc(mount, ctx, { lang, initialMethod, initialInputs, initialNote, refData, onDone, onCancel }) {
  const L = TX[lang] || TX.zh;
  const tx = (k) => L[k];

  let activeIdx = Math.max(0, MODELS.findIndex((m) => m.key === initialMethod));
  let lastLow = null, lastHigh = null;

  mount.innerHTML = "";
  const root = el("div", "vc");
  mount.appendChild(root);

  // 方法选择：分组下拉（内在价值 / 相对估值 两个 optgroup）
  const methodsBar = el("div", "vc-methods");
  const select = el("select", "vc-select");
  [["intrinsic", MODELS.filter((m) => m.group === "intrinsic")],
   ["relative", MODELS.filter((m) => m.group === "relative")]].forEach(([gk, models]) => {
    if (!models.length) return;
    const og = document.createElement("optgroup"); og.label = tx(gk);
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
  methodsBar.appendChild(select);
  root.appendChild(methodsBar);

  const formWrap = el("div", "vc-form");
  root.appendChild(formWrap);

  // 备注（长文本，跨方法切换保留）
  const noteWrap = el("div", "vc-note");
  const noteLabel = el("div", "vc-note-label"); noteLabel.textContent = tx("note");
  const noteInput = el("textarea", "vc-note-input"); noteInput.placeholder = tx("notePh");
  if (initialNote) noteInput.value = initialNote;
  noteWrap.append(noteLabel, noteInput);
  root.appendChild(noteWrap);

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
    onDone({ method: MODELS[activeIdx].key, inputs: lastForm, low: Math.min(lastLow, lastHigh), high: Math.max(lastLow, lastHigh), note: noteInput.value.trim() });
  });
  const cancelBtn = el("button", "vc-cancel"); cancelBtn.type = "button"; cancelBtn.textContent = tx("cancel");
  cancelBtn.addEventListener("click", () => onCancel && onCancel());
  actions.append(doneBtn, cancelBtn);
  result.appendChild(actions);

  let lastForm = {};

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

  // 标签 + 可选 ⓘ 提示（提示框作为整行 grid 子元素返回，供后续插入）
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

  // 参考筹码行（grid-column:2/-1）；点击回填 fillFn(value)；行末 ↗ 溯源
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
    const isMultiple = meta.ref === "pe" || meta.ref === "pb" || meta.ref === "ps";
    const src = refData.sources && (isMultiple ? refData.sources.valuation : refData.sources.financial);
    if (src) {
      const a = el("a", "vc-srclink"); a.href = src; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "↗"; a.title = lang === "zh" ? "查看出处" : "View source";
      row.appendChild(a);
    }
    return row;
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
        if (refRow) sheet.append(el("div"), refRow);
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
        if (refRow) sheet.append(el("div"), refRow);
        if (guideRow) sheet.appendChild(guideRow);
      });
    }
    formWrap.appendChild(sheet);
    recompute();
  }

  function buildForm(readers) { const form = {}; readers.forEach(({ field, getVal }) => { form[field.k] = getVal(); }); return form; }
  function makeInput(initVal) {
    const inp = el("input", "vc-input", { type: "number", inputMode: "decimal", step: "any" });
    if (initVal !== "" && initVal !== undefined && initVal !== null) inp.value = String(initVal);
    return inp;
  }

  renderForm();
}
