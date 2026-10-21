import { cleanThesis, THESIS_IMPACTS, IMPACT_DIRECTIONS } from "./thesis.js";

export const GUIDE_STEPS = [
  { key: "story", zh: "形成叙事", en: "Build the story" },
  { key: "evidence", zh: "检查依据", en: "Check the evidence" },
  { key: "impacts", zh: "连接数字", en: "Connect to numbers" },
];
// 整条 AI 流程：先问两个场景共用的叙事，再分开问保守 / 乐观，最后一起检查依据与影响
export const FLOW_STEPS = [
  { key: "core", zh: "核心叙事", en: "Core story" },
  { key: "downside", zh: "保守情况", en: "Downside" },
  { key: "upside", zh: "乐观情况", en: "Upside" },
  { key: "evidence", zh: "检查依据", en: "Evidence" },
  { key: "impacts", zh: "影响哪些数字", en: "Financial effects" },
];
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

// Model output describes known components only; never HTML, JS or arbitrary actions.
export function guideQuestion(raw) {
  if (!object(raw) || raw.type !== "question" || !text(raw.question, 600) || !text(raw.context, 800)
    || !["single", "multiple"].includes(raw.selection) || !Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) return null;
  const ids = new Set();
  for (const option of raw.options) {
    if (!object(option) || typeof option.id !== "string" || !/^[a-z0-9_-]{1,20}$/.test(option.id) || ["unknown", "other"].includes(option.id) || ids.has(option.id)
      || !text(option.label, 160) || (option.detail !== undefined && (typeof option.detail !== "string" || option.detail.length > 240))) return null;
    ids.add(option.id);
  }
  return { type: "question", context: raw.context.trim(), question: raw.question.trim(), selection: raw.selection,
    options: raw.options.map((option) => ({ id: option.id, label: option.label.trim(), detail: (option.detail || "").trim() })) };
}

export function guideDraft(raw) {
  // Models sometimes emit watch items as a list. Accept only bounded plain text.
  if (object(raw) && Array.isArray(raw.signals) && raw.signals.length > 0 && raw.signals.length <= 6 && raw.signals.every((line) => text(line, 800))) raw = { ...raw, signals: raw.signals.join("\n") };
  if (!object(raw) || !["story", "evidence", "uncertainties", "signals"].every((key) => text(raw[key], 800))
    || !Array.isArray(raw.impacts) || raw.impacts.length > THESIS_IMPACTS.length
    || (raw.conflict !== undefined && raw.conflict !== null && (typeof raw.conflict !== "string" || raw.conflict.length > 400))) return null;
  const seen = new Set();
  for (const impact of raw.impacts) {
    if (!object(impact) || !THESIS_IMPACTS.some(({ key }) => impact.key === key) || seen.has(impact.key)
      || !IMPACT_DIRECTIONS.includes(impact.direction) || !text(impact.reason, 800)) return null;
    seen.add(impact.key);
  }
  // Only research is allowed back into the form, never model inputs or values.
  const clean = cleanThesis({ c: { story: raw.story, evidence: raw.evidence, uncertainties: raw.uncertainties,
    signals: raw.signals, impacts: raw.impacts } }).c;
  // conflict is a warning shown before applying; it never goes into the form.
  const conflict = typeof raw.conflict === "string" && raw.conflict.trim() ? raw.conflict.trim() : "";
  return { ...clean, impacts: clean.impacts || [], ...(conflict ? { conflict } : {}) };
}

export function validGuideTurns(turns, max = GUIDE_STEPS.length) {
  return Array.isArray(turns) && turns.length <= max && turns.every((turn) => object(turn) && text(turn.question, 600) && text(turn.answer, 800));
}

// "other" counts only once the user has typed their own option.
// 两个场景一起整理出的草稿：两份都要合法；conflict 只是确认前的提醒，不写进表单
export function guideDrafts(raw) {
  if (!object(raw) || (raw.conflict !== undefined && raw.conflict !== null && (typeof raw.conflict !== "string" || raw.conflict.length > 400))) return null;
  const c = guideDraft(raw.c), o = guideDraft(raw.o);
  if (!c || !o) return null;
  const strip = ({ conflict, ...rest }) => rest;
  const conflict = typeof raw.conflict === "string" && raw.conflict.trim() ? raw.conflict.trim() : "";
  return { c: strip(c), o: strip(o), ...(conflict ? { conflict } : {}) };
}

export function guideAnswer(question, selected, freeText, lang = "zh", otherText = "") {
  const values = selected.includes("unknown") ? [lang === "en" ? "I am not sure yet; keep this unverified." : "还不确定，先留待验证。"]
    : question.options.filter((option) => selected.includes(option.id)).map((option) => option.label);
  if (!selected.includes("unknown") && selected.includes("other") && otherText.trim()) values.push(otherText.trim());
  if (freeText.trim()) values.push(freeText.trim());
  return values.join("\n");
}

// Restored browser state is untrusted too. Invalid or oversized data is ignored.
export function cleanGuideState(raw) {
  if (!object(raw) || !validGuideTurns(raw.turns)) return null;
  const question = raw.question ? guideQuestion(raw.question) : null;
  const draft = raw.draft ? guideDraft(raw.draft) : null;
  if ((raw.question && !question) || (raw.draft && !draft) || (draft && raw.turns.length !== 3) || (question && raw.turns.length === 3) || (draft && question)) return null;
  const selected = Array.isArray(raw.selected) && question ? [...new Set(raw.selected.filter((id) => id === "unknown" || id === "other" || question.options.some((option) => option.id === id)))] : [];
  const history = Array.isArray(raw.history) ? raw.history.slice(0, 3).map((page) => cleanGuideState({ ...page, turns: [], history: [] })) : [];
  if (history.length !== raw.turns.length || history.some((page) => !page?.question)) return null;
  return { turns: raw.turns.map(({ question, answer }) => ({ question, answer })), question, draft, history,
    selected: selected.includes("unknown") ? ["unknown"] : question?.selection === "single" ? selected.slice(0, 1) : selected,
    freeText: typeof raw.freeText === "string" ? raw.freeText.slice(0, 800) : "",
    otherText: typeof raw.otherText === "string" ? raw.otherText.slice(0, 400) : "",
    references: Array.isArray(raw.references) ? raw.references.filter((line) => typeof line === "string").slice(0, 24).map((line) => line.slice(0, 1600)) : [],
    base: typeof raw.base === "string" && raw.base.length < 16000 ? raw.base : "", applied: raw.applied === true };
}

// Keep the source numbers assigned in the server prompt; never renumber a subset.
export function citedGuideReferences(text, references) {
  const numbers = [...new Set([...text.matchAll(/[\[［](\d{1,3})[\]］]/g)].map((match) => Number(match[1])))].filter((n) => n > 0);
  return numbers.sort((a, b) => a - b).map((number) => ({ number, text: references[number - 1] || null }));
}

// Single-case interviews must not expose the other case's assumptions or target value.
export function scenarioContext(context, scenario) {
  if (!["c", "o"].includes(scenario)) return context;
  const { currentConclusion, resourceValuation, ...facts } = context.facts || {};
  return { ...context, scenario, facts, thesis: { [scenario]: cleanThesis(context.thesis)[scenario] },
    fields: (context.fields || []).map((f) => ({ ...f,
      ...(scenario === "o" && f.col === "single" ? { readOnly: true } : {}),
      ...(f.col === "dual" ? { value: { [scenario]: f.value?.[scenario] ?? null } } : {}) })) };
}

// Apply only explicitly confirmed values for this case, preserving its counterpart.
export function mergeScenarioParams(params, fields, scenario) {
  const result = {};
  for (const field of fields) {
    const value = params[field.k];
    if (field.col === "dual") {
      if (typeof value?.[scenario] === "number" && Number.isFinite(value[scenario])) result[field.k] = { ...field.value, [scenario]: value[scenario] };
    } else if (scenario === "c" && typeof value === "number" && Number.isFinite(value)) result[field.k] = value;
  }
  return result;
}
