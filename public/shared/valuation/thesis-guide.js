import { cleanThesis, THESIS_IMPACTS, IMPACT_DIRECTIONS } from "./thesis.js";

export const GUIDE_STEPS = [
  { key: "story", zh: "形成故事", en: "Build the story" },
  { key: "evidence", zh: "检查依据", en: "Check the evidence" },
  { key: "impacts", zh: "连接数字", en: "Connect to numbers" },
];
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

// Model output describes known components only; never HTML, JS or arbitrary actions.
export function guideQuestion(raw) {
  if (!object(raw) || raw.type !== "question" || !text(raw.question, 600) || !text(raw.context, 800)
    || !["single", "multiple"].includes(raw.selection) || !Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) return null;
  const ids = new Set();
  for (const option of raw.options) {
    if (!object(option) || typeof option.id !== "string" || !/^[a-z0-9_-]{1,20}$/.test(option.id) || option.id === "unknown" || ids.has(option.id)
      || !text(option.label, 160) || (option.detail !== undefined && (typeof option.detail !== "string" || option.detail.length > 240))) return null;
    ids.add(option.id);
  }
  return { type: "question", context: raw.context.trim(), question: raw.question.trim(), selection: raw.selection,
    options: raw.options.map((option) => ({ id: option.id, label: option.label.trim(), detail: (option.detail || "").trim() })) };
}

export function guideDraft(raw) {
  if (!object(raw) || !["story", "evidence", "uncertainties", "signals"].every((key) => text(raw[key], 800))
    || !Array.isArray(raw.impacts) || raw.impacts.length > THESIS_IMPACTS.length) return null;
  const seen = new Set();
  for (const impact of raw.impacts) {
    if (!object(impact) || !THESIS_IMPACTS.some(({ key }) => impact.key === key) || seen.has(impact.key)
      || !IMPACT_DIRECTIONS.includes(impact.direction) || !text(impact.reason, 800)) return null;
    seen.add(impact.key);
  }
  // Only research is allowed back into the form, never model inputs or values.
  const clean = cleanThesis({ c: { story: raw.story, evidence: raw.evidence, uncertainties: raw.uncertainties,
    signals: raw.signals, impacts: raw.impacts } }).c;
  return { ...clean, impacts: clean.impacts || [] };
}

export function validGuideTurns(turns) {
  return Array.isArray(turns) && turns.length <= GUIDE_STEPS.length && turns.every((turn) => object(turn) && text(turn.question, 600) && text(turn.answer, 800));
}

export function guideAnswer(question, selected, freeText, lang = "zh") {
  const values = selected.includes("unknown") ? [lang === "en" ? "I am not sure yet; keep this unverified." : "还不确定，先留待验证。"]
    : question.options.filter((option) => selected.includes(option.id)).map((option) => option.label);
  if (freeText.trim()) values.push(freeText.trim());
  return values.join("\n");
}

// Restored browser state is untrusted too. Invalid or oversized data is ignored.
export function cleanGuideState(raw) {
  if (!object(raw) || !validGuideTurns(raw.turns)) return null;
  const question = raw.question ? guideQuestion(raw.question) : null;
  const draft = raw.draft ? guideDraft(raw.draft) : null;
  if ((raw.question && !question) || (raw.draft && !draft)) return null;
  const selected = Array.isArray(raw.selected) && question ? [...new Set(raw.selected.filter((id) => id === "unknown" || question.options.some((option) => option.id === id)))] : [];
  const history = Array.isArray(raw.history) ? raw.history.slice(0, 3).map((page) => cleanGuideState({ ...page, turns: [], history: [] })) : [];
  if (history.some((page) => !page?.question)) return null;
  return { turns: raw.turns.map(({ question, answer }) => ({ question, answer })), question, draft, history,
    selected: selected.includes("unknown") ? ["unknown"] : question?.selection === "single" ? selected.slice(0, 1) : selected,
    freeText: typeof raw.freeText === "string" ? raw.freeText.slice(0, 800) : "",
    references: Array.isArray(raw.references) ? raw.references.filter((line) => typeof line === "string").slice(0, 24).map((line) => line.slice(0, 1600)) : [],
    base: typeof raw.base === "string" && raw.base.length < 16000 ? raw.base : "", applied: raw.applied === true };
}
