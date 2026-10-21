import { FLOW_STEPS, GUIDE_STEPS, guideQuestion, validGuideTurns } from "./thesis-guide.js";

export const FOLLOWUP_CHOICES = ["needs_data", "needs_judgment", "accepted_risk", "none", "uncertain"];
const COVERAGE = ["covered", "partial", "unanswered", "uncertain"];
const bareUnknown = (answer) => /^(还不确定，先留待验证。|I am not sure yet; keep this unverified\.)$/.test(answer.trim());

export function routingStages(turns, scenario) {
  const steps = scenario === "both" ? FLOW_STEPS : GUIDE_STEPS;
  return { current: steps[turns.length]?.key || "summary", previous: turns.map((turn, i) => ({ ...turn, stage: steps[i]?.key || "unknown" })) };
}

export function coverageChoices(turns, scenario) {
  const stages = routingStages(turns, scenario);
  return ["unanswered", "partial", "uncertain", ...turns.flatMap((turn, i) => {
    // Never reuse an opposite-case answer or a bare “not sure” as complete coverage.
    const opposite = stages.current === "upside" && stages.previous[i].stage === "downside";
    return !opposite && !bareUnknown(turn.answer) ? [`covered_turn_${i}`] : [];
  })];
}

export function routingSnapshot(question, turns, scenario) {
  const target = guideQuestion(question);
  return target && ["both", "c", "o"].includes(scenario) && validGuideTurns(turns, scenario === "both" ? FLOW_STEPS.length - 1 : GUIDE_STEPS.length - 1)
    ? { target, turns: turns.map(({ question, answer }) => ({ question, answer })), scenario } : null;
}

// A routing decision must match the current question/options and the full prior answers.
export function cleanGuideRouting(raw, question, turns, scenario = "both") {
  const snapshot = routingSnapshot(question, turns, scenario);
  if (!snapshot || !turns.length || !raw || !["used", "unavailable", "not_configured"].includes(raw.status)
    || JSON.stringify(raw.snapshot) !== JSON.stringify(snapshot)) return null;
  if (raw.status !== "used") return { snapshot, status: raw.status, coverage: "uncertain", matchedTurn: null, followup: "uncertain" };
  if (!COVERAGE.includes(raw.coverage) || !FOLLOWUP_CHOICES.includes(raw.followup)) return null;
  const matchedTurn = raw.coverage === "covered" && Number.isInteger(raw.matchedTurn) && coverageChoices(turns, scenario).includes(`covered_turn_${raw.matchedTurn}`) ? raw.matchedTurn : null;
  if (raw.coverage === "covered" && matchedTurn === null) return null;
  return { snapshot, status: "used", coverage: raw.coverage, matchedTurn, followup: raw.followup };
}

export function guideRoutingNote(routing, lang = "zh") {
  if (!routing || routing.status !== "used") return "";
  const en = lang === "en";
  const notes = [];
  if (routing.coverage === "covered") notes.push(en ? "Your earlier answer appears to cover this question. Reuse it or give a different answer." : "你前面的回答已覆盖这道题。可以沿用原话，也可以重新回答。");
  else if (routing.coverage === "partial") notes.push(en ? "Your earlier answers partly cover this. Add only what is still unclear." : "你前面的回答已涉及这件事，只需补充还没说清楚的部分。");
  if (routing.followup === "needs_data") notes.push(en ? "The gap is evidence. Add a source in the note, or leave it unverified." : "这里缺的是资料依据，可以补充来源，或先留待验证。");
  else if (routing.followup === "accepted_risk") notes.push(en ? "You have explicitly accepted the relevant risk. Keep that choice while tracking the risk." : "你已明确愿意承担相关风险，这个判断会保留，风险仍需跟踪。");
  return notes.join(" ");
}
