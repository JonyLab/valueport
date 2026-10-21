import { citedGuideReferences } from "./thesis-guide.js";
import { cleanGuideRouting } from "./guide-routing.js";

export const CLAIM_KINDS = ["fact", "assumption", "mixed", "other"];
export const CITATION_SUPPORT = ["supported", "partial", "unsupported", "contradicted", "uncertain"];
const SUPPORT = [...CITATION_SUPPORT, "missing_source", "uncited", "not_applicable", "unchecked"];

// Paths and text are owned by the parsed guide, never by the decision model.
export function guideClaims(guide) {
  const items = [];
  const add = (path, text) => { if (typeof text === "string" && text.trim()) items.push({ path, text: text.trim() }); };
  if (guide?.type === "question") {
    add("context", guide.context); add("question", guide.question);
    guide.options?.forEach((option, i) => { add(`options.${i}.label`, option.label); add(`options.${i}.detail`, option.detail); });
  } else {
    const draft = (path, value) => {
      if (!value) return;
      for (const key of ["story", "evidence", "uncertainties", "signals", "conflict"]) add(`${path}.${key}`, value[key]);
      value.impacts?.forEach((impact, i) => add(`${path}.impacts.${i}.reason`, impact.reason));
    };
    draft("draft", guide?.draft);
    draft("drafts.c", guide?.drafts?.c); draft("drafts.o", guide?.drafts?.o);
    add("drafts.conflict", guide?.drafts?.conflict);
  }
  return items.slice(0, 32);
}

// A check is valid only for the exact text AND the exact numbered source snapshot.
export function cleanGuideAudit(raw, guide, references, turns = [], scenario = "both") {
  if (!raw || !["used", "unavailable", "not_configured"].includes(raw.status) || !Array.isArray(raw.references)
    || JSON.stringify(raw.references) !== JSON.stringify(references) || !Array.isArray(raw.items)) return null;
  const claims = new Map(guideClaims(guide).map((item) => [item.path, item.text]));
  const seen = new Set();
  const items = raw.items.slice(0, 32).filter((item) => {
    if (!item || seen.has(item.path) || claims.get(item.path) !== item.text || ![...CLAIM_KINDS, "uncertain"].includes(item.kind) || !SUPPORT.includes(item.support)) return false;
    seen.add(item.path); return true;
  }).map(({ path, text, kind, support }) => {
    const citations = citedGuideReferences(text, references);
    // Missing references always take precedence over semantic model judgments.
    return { path, text, kind, support: citations.some((source) => !source.text) ? "missing_source" : support };
  });
  const routing = cleanGuideRouting(raw.routing, guide, turns, scenario);
  return { status: raw.status, references: [...references], items, ...(routing ? { routing } : {}) };
}

export function guideAuditLabels(item, lang = "zh") {
  const zh = lang !== "en";
  const kinds = { fact: ["资料陈述", "Factual claim"], assumption: ["叙事假设", "Story assumption"], mixed: ["事实与假设混合", "Facts and assumptions"], other: ["提问／待验证", "Question / to verify"], uncertain: ["类型待确认", "Type uncertain"] };
  const support = {
    supported: ["所引资料支持本段陈述", "Cited material supports this passage"],
    partial: ["所引资料仅部分支持，仍需核实", "Cited material only partly supports this passage"],
    unsupported: ["所引资料未能支持本段陈述", "Cited material does not support this passage"],
    contradicted: ["本段陈述与所引资料存在冲突", "This passage conflicts with cited material"],
    uncertain: ["引用支持程度待确认", "Citation support uncertain"],
    missing_source: ["引用编号缺少对应资料", "A cited source is missing"],
    uncited: ["本段没有引用，尚未核验依据", "No citation; evidence has not been checked"],
    not_applicable: ["这是假设或待验证内容，不代表已发生", "An assumption or open question, not an established fact"],
    unchecked: ["尚未完成语义核验", "Semantic check unavailable"],
  };
  return { kind: kinds[item.kind]?.[zh ? 0 : 1] || "", support: support[item.support]?.[zh ? 0 : 1] || "",
    warning: ["partial", "unsupported", "contradicted", "missing_source", "uncertain", "uncited"].includes(item.support) };
}
