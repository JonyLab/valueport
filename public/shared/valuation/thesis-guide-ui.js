import { FLOW_STEPS, guideQuestion, guideDraft, guideDrafts, guideAnswer, validGuideTurns, citedGuideReferences } from "./thesis-guide.js";
import { impactDirection, THESIS_IMPACTS, fieldStoryHint } from "./thesis.js";
import { cleanReadiness, readinessText, cleanMethodDecision, methodDecisionText } from "./method-readiness.js";
import { aiErrorText } from "../ai-panel.js";
import { cleanGuideAudit, guideAuditLabels } from "./guide-audit.js";
import { cleanDriverPlan, GUIDE_DRIVERS } from "./guide-drivers.js";
import { guideRoutingNote } from "./guide-routing.js";
import { cleanManagementResearch } from "./management-research.js";
import { managementResearchElement } from "./management-research-ui.js";
import { recoverManagementResearch } from "./management-research-loader.js";
import { cleanBusinessReports } from "./business-report.js";
import { businessReportElement } from "./business-report-ui.js";

const node = (tag, cls, text) => {
  const element = document.createElement(tag); if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text; return element;
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const cleanReferences = (raw) => Array.isArray(raw) ? raw.filter((line) => typeof line === "string").slice(0, 24).map((line) => line.slice(0, 1600)) : [];

// 整条「从叙事到数字」的 AI 流程：经营变量问答 → 两个场景的草稿 → 选方法 → 逐项确认参数 → 看结果。
// 每一步只显示当前这一屏；完成后交给编辑器的可修改面板。模型输出都按受约束的数据处理，数字只在用户确认后写入。
export const FLOW_STAGES = [
  { key: "story", zh: "构建叙事", en: "Story" },
  { key: "method", zh: "选方法", en: "Method" },
  { key: "params", zh: "填参数", en: "Inputs" },
  { key: "result", zh: "看估值", en: "Value" },
];
const STAGE_KEYS = ["story", "review", "method", "params", "result"];

// 浏览器里恢复的状态同样不可信：不合法就丢弃，从头开始
function cleanCaseFlowState(raw) {
  if (!object(raw) || !STAGE_KEYS.includes(raw.stage) || !validGuideTurns(raw.turns, FLOW_STEPS.length)) return null;
  const driverMode = raw.guideMode === "drivers";
  if (raw.guideMode !== undefined && !driverMode) return null;
  const driverPlan = driverMode ? cleanDriverPlan(raw.driverPlan) : null;
  if (driverMode && ((raw.driverPlan != null && !driverPlan) || ((raw.turns.length || raw.question || raw.drafts) && !driverPlan)
    || (driverPlan && raw.turns.length > driverPlan.keys.length))) return null;
  const question = raw.question ? guideQuestion(raw.question) : null;
  const caseKey = ["c", "o"].includes(raw.caseKey) ? raw.caseKey : null;
  if (raw.caseKey !== undefined && !caseKey) return null;
  if (raw.singleCase !== undefined && (raw.singleCase !== true || caseKey !== "c")) return null;
  const drafts = raw.drafts ? (caseKey ? (guideDraft(raw.drafts[caseKey]) ? { [caseKey]: guideDraft(raw.drafts[caseKey]) } : null) : guideDrafts(raw.drafts)) : null;
  if ((raw.question && !question) || (raw.drafts && !drafts)) return null;
  if (caseKey && ((raw.question && raw.drafts) || (raw.stage !== "story" && (!drafts || !driverPlan || raw.turns.length !== driverPlan.keys.length)))) return null;
  const history = Array.isArray(raw.history) ? raw.history.slice(0, FLOW_STEPS.length).map((page, i) => {
    const q = object(page) && guideQuestion(page.question);
    const references = cleanReferences(page?.references);
    return q ? { question: q, selected: Array.isArray(page.selected) ? page.selected.filter((id) => typeof id === "string").slice(0, 8) : [],
      references, audit: cleanGuideAudit(page.audit, q, references, raw.turns.slice(0, i)),
      freeText: typeof page.freeText === "string" ? page.freeText.slice(0, 800) : "", otherText: typeof page.otherText === "string" ? page.otherText.slice(0, 400) : "" } : null;
  }) : [];
  if (history.some((page) => !page)) return null;
  const turns = raw.turns.slice(0, history.length); // 每一轮都要能「上一步」回到原问题；对不上的部分丢弃
  const selected = Array.isArray(raw.selected) && question ? [...new Set(raw.selected.filter((id) => id === "unknown" || id === "other" || question.options.some((option) => option.id === id)))] : [];
  const picks = object(raw.picks) && Array.isArray(raw.picks.picks) ? { summary: typeof raw.picks.summary === "string" ? raw.picks.summary.slice(0, 600) : "",
    picks: raw.picks.picks.filter((p) => object(p) && typeof p.key === "string").slice(0, 3).map((p) => ({ key: p.key.slice(0, 40), reason: typeof p.reason === "string" ? p.reason.slice(0, 300) : "", ...(cleanReadiness(p.readiness) ? { readiness: cleanReadiness(p.readiness) } : {}), ...(p.suitability === "needs_review" ? { suitability: "needs_review" } : {}) })), ...(cleanMethodDecision(raw.picks.decision) ? { decision: cleanMethodDecision(raw.picks.decision) } : {}) } : null;
  let rows = null;
  if (Array.isArray(raw.rows)) {
    rows = raw.rows.filter((row) => object(row) && typeof row.k === "string").slice(0, 40).map((row) => ({ k: row.k.slice(0, 60), use: row.use !== false, single: row.single === true,
      c: finite(row.c) ? row.c : null, o: finite(row.o) ? row.o : null, v: finite(row.v) ? row.v : null, reason: typeof row.reason === "string" ? row.reason.slice(0, 300) : "", ai: row.ai === true }));
  }
  const references = cleanReferences(raw.references);
  const audit = cleanGuideAudit(raw.audit, question || { type: "summary", drafts }, references, turns);
  return { stage: turns.length === raw.turns.length ? raw.stage : "story", turns: turns.map(({ question: q, answer }) => ({ question: q, answer })), history, question: turns.length === raw.turns.length ? question : null, drafts: turns.length === raw.turns.length ? drafts : null,
    selected: selected.includes("unknown") ? ["unknown"] : question?.selection === "single" ? selected.slice(0, 1) : selected,
    freeText: typeof raw.freeText === "string" ? raw.freeText.slice(0, 800) : "", otherText: typeof raw.otherText === "string" ? raw.otherText.slice(0, 400) : "",
    references, audit, ...(cleanManagementResearch(raw.managementResearch) ? { managementResearch: cleanManagementResearch(raw.managementResearch) } : {}),
    ...(cleanBusinessReports(raw.businessReports) ? { businessReports: cleanBusinessReports(raw.businessReports) } : {}), ...(driverMode ? { guideMode: "drivers", driverPlan } : {}),
    ...(caseKey ? { caseKey } : {}), ...(raw.singleCase ? { singleCase: true } : {}), picks, method: typeof raw.method === "string" ? raw.method.slice(0, 40) : "", rows, paramsFor: typeof raw.paramsFor === "string" ? raw.paramsFor.slice(0, 40) : "" };
}

function mountCaseFlow(host, { lang, company, initial, hooks, onChange, visible = () => true, caseKey = null, driverPlan = null, singleCase = false }) {
  const zh = lang !== "en", t = (a, b) => (zh ? a : b);
  const empty = () => ({ ...(caseKey ? { caseKey } : {}), ...(singleCase ? { singleCase: true } : {}), guideMode: "drivers", driverPlan, stage: "story", turns: [], history: [], question: null, drafts: null, selected: [], freeText: "", otherText: "",
    references: [], audit: null, picks: null, method: "", rows: null, paramsFor: "" });
  let state = cleanCaseFlowState(initial) || empty(), busy = "", locked = false, error = "", stopped = false, active = null, destroyed = false;
  const caseName = () => singleCase ? t("单场景", "Single case") : caseKey === "c" ? t("保守情景", "Conservative case") : t("乐观情景", "Optimistic case");
  const replies = new Map(); // 本次打开期间：同样的已答内容 → 上次 AI 的回复（返回再前进、答案没改时不重复调用）
  host.classList.add("vc-thesis-guide", "vc-guide-card");
  // 窄屏下吸底按钮会盖住正在输入的框：聚焦时把它滚到可视区中间
  host.addEventListener("focusin", (e) => {
    if (!e.target.matches?.("input[type=text], input[type=number], textarea") || innerWidth > 760) return;
    setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "auto" }), 250);
  });
  const status = node("div", "vc-guide-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const notify = () => onChange?.();
  function button(text, action, primary = false) {
    const element = node("button", primary ? "vc-guide-primary" : "vc-guide-secondary", text); element.type = "button";
    element.addEventListener("click", () => { if (!locked) action(); }); return element;
  }

  // ── 异步任务：同一时间只有一个；可暂停；超时 / 失败保留已答内容 ──
  async function run(label, task) {
    if (busy || locked || destroyed) return;
    busy = label; error = ""; stopped = false;
    const controller = new AbortController(); active = controller;
    const timeout = setTimeout(() => controller.abort("timeout"), 60000);
    render();
    try {
      await task(controller.signal);
      if (active !== controller || destroyed) return;
      notify();
    } catch (e) {
      if (active !== controller || destroyed) return;
      stopped = controller.signal.aborted && controller.signal.reason !== "timeout";
      error = controller.signal.aborted ? (controller.signal.reason === "timeout" ? t("这次等待较久，已填的内容都保留着，可以重试。", "This took too long. Your work is kept; retry when ready.") : t("已停止，已填的内容都保留着。", "Stopped. Your work is kept."))
        : e instanceof TypeError ? t("网络连接中断了，请检查网络后重试。", "The connection dropped. Check your network and retry.") // fetch 的网络错误是英文，不直接给人看
        : String(e.message || e);
    } finally {
      clearTimeout(timeout);
      if (active === controller && !destroyed) { active = null; busy = ""; render(true); }
    }
  }
  // 结果先到、随后才点了停止：同样按中止处理，不能当成功（否则界面以为还没数据又去请求）
  const raceAbort = (promise, signal) => Promise.race([promise, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))])
    .then((value) => { if (signal.aborted) throw new Error("aborted"); return value; });

  const questionCount = () => state.guideMode === "drivers" ? (state.driverPlan?.keys.length || 4) : FLOW_STEPS.length;
  // ── 第 1 段：经营变量问答（旧草稿保留五轮流程）→ 两份草稿 ──
  function askNext() {
    return run(state.turns.length === questionCount() ? "draft" : "question", async (signal) => {
      const cacheKey = JSON.stringify(state.turns);
      let result = replies.get(cacheKey);
      if (!result) {
        const context = await raceAbort(hooks.getContext(), signal);
        state.managementResearch = recoverManagementResearch(state.managementResearch, context.managementResearch);
        if (state.managementResearch) context.managementResearch = state.managementResearch;
        const response = await fetch("/api/my/ai/thesis-guide", { method: "POST", signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ lang, ...(singleCase ? { singleCase: true } : {}), scenario: caseKey || "both", turns: state.turns, thesis: caseKey ? { [caseKey]: hooks.getThesis()[caseKey] } : hooks.getThesis(), context, ...(state.guideMode === "drivers" ? { guideMode: "drivers", driverPlan: state.driverPlan } : {}) }) });
        result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(aiErrorText(response.status, result, lang));
      }
      const plan = state.guideMode === "drivers" ? cleanDriverPlan(result.driverPlan) : null;
      if (state.guideMode === "drivers" && (!plan || (state.driverPlan && JSON.stringify(plan) !== JSON.stringify(state.driverPlan)))) throw new Error(t("选题计划不完整，请重试。", "The question plan is incomplete. Please retry."));
      const done = state.turns.length === (plan ? plan.keys.length : FLOW_STEPS.length);
      const question = done ? null : guideQuestion(result);
      const drafts = done && result.type === "summary" ? (caseKey ? (guideDraft(result.draft) ? { [caseKey]: guideDraft(result.draft) } : null) : guideDrafts(result.drafts)) : null;
      if (caseKey && result.audit && drafts) result.audit = { ...result.audit, items: result.audit.items.map((item) => ({ ...item, path: item.path.replace(/^draft\./, `drafts.${caseKey}.`) })) };
      if (!question && !drafts) throw new Error(t("AI 返回的内容不完整，请重试。", "The AI response is incomplete. Please retry."));
      replies.set(cacheKey, result);
      if (signal.aborted) throw new Error("aborted");
      if (plan) state.driverPlan = plan;
      state.references = cleanReferences(result.references);
      state.audit = cleanGuideAudit(result.audit, question || { type: "summary", drafts }, state.references, state.turns);
      if (question) { state.question = question; state.selected = []; state.freeText = ""; state.otherText = ""; }
      else { state.drafts = drafts; state.question = null; state.stage = "review"; state.picks = null; state.rows = null; state.paramsFor = ""; state.method = ""; } // 叙事变了：方法推荐和参数建议都要按新叙事重来
    });
  }
  function answerText() { return state.question ? guideAnswer(state.question, state.selected, state.freeText, lang, state.otherText) : ""; }
  function submitAnswer() {
    const value = answerText(); if (busy || locked || !value || value.length > 800) return;
    state.history.push({ question: state.question, selected: [...state.selected], freeText: state.freeText, otherText: state.otherText, references: [...state.references], audit: state.audit });
    state.turns.push({ question: state.question.question, answer: value });
    state.question = null; state.selected = []; state.freeText = ""; state.otherText = ""; notify(); askNext();
  }
  function backQuestion() {
    const last = state.turns.pop(), page = state.history.pop();
    if (!last) return;
    state.question = page?.question || null; state.selected = page?.selected || []; state.freeText = page?.freeText || (page ? "" : last.answer); state.otherText = page?.otherText || "";
    state.references = page?.references || []; state.audit = page?.audit || null;
    state.drafts = null; state.picks = null; state.rows = null; state.paramsFor = ""; state.method = ""; state.stage = "story";
  }

  // ── 第 2 段：选方法（AI 按叙事推荐，用户确认）──
  function loadPicks() {
    return run("picks", async (signal) => {
      const picks = await raceAbort(hooks.recommendMethods(caseKey), signal);
      const known = new Set(hooks.methods().map((m) => m.key));
      state.picks = { summary: String(picks?.summary || picks?.reply || "").slice(0, 600), decision: cleanMethodDecision(picks?.decision), picks: (picks?.picks || []).filter((p) => known.has(p.key)).map((p) => ({ key: p.key, reason: p.reason || "", readiness: cleanReadiness(p.readiness), suitability: p.suitability })) };
      if (!state.method) state.method = state.picks.picks[0]?.key || hooks.currentMethod() || "";
    });
  }

  // ── 第 3 段：参数（AI 给每项一对建议值，用户逐项确认 / 修改 / 跳过）──
  function loadParams() {
    return run("params", async (signal) => {
      const suggestion = await raceAbort(hooks.suggestParams(caseKey, singleCase), signal);
      const params = suggestion?.params || {}, reasons = suggestion?.reasons || {};
      const requiredData = new Set((state.picks?.picks.find((p) => p.key === state.method)?.readiness?.missingInputs || []).map((item) => item.key));
      // 两档参数逐项确认；单值参数只在缺数据或 AI 给了建议时出现（缺数据的必须补上，否则算不出结果）
      state.rows = hooks.fields().flatMap((f) => {
        const p = params[f.k];
        if (f.col === "dual") {
          const ai = object(p) && (caseKey ? finite(p[caseKey]) : finite(p.c) && finite(p.o));
          return [{ k: f.k, use: ai, c: ai ? p.c : (finite(f.value?.c) ? f.value.c : null), o: ai ? p.o : (finite(f.value?.o) ? f.value.o : null), reason: reasons[f.k] || "", ai }];
        }
        if (caseKey === "o") return []; // Shared base data was confirmed in the conservative case.
        if (requiredData.has(f.k) && (!finite(f.value) || f.isDefault)) return [{ k: f.k, single: true, use: true, v: null,
          reason: t("当前资料未提供这项数据，请核实后手动补充；示例值不能代替实际数据。", "This input is missing from the evidence. Verify and enter it; sample values are not actual data."), ai: false }];
        const ai = finite(p), missing = !finite(f.value);
        return ai || missing ? [{ k: f.k, single: true, use: true, v: ai ? p : null, reason: reasons[f.k] || "", ai }] : [];
      });
      state.paramsFor = paramsKey();
    });
  }
  // 参数建议只对当时的方法和口径有效：方法、口径（字段组成）变了就作废
  const paramsKey = () => `${state.method}|${hooks.fields().map((f) => f.k).join(",")}`;
  function freshRows() { if (state.rows && state.paramsFor !== paramsKey()) { state.rows = null; state.paramsFor = ""; } return state.rows; }
  function applyRows() {
    const params = {}, known = new Set(hooks.fields().map((f) => f.k));
    for (const row of state.rows || []) {
      if (!row.use || !known.has(row.k)) continue; // 不属于当前方法的值不写入
      if (row.single) { if (finite(row.v)) params[row.k] = row.v; }
      else if (caseKey ? finite(row[caseKey]) : finite(row.c) && finite(row.o)) params[row.k] = caseKey ? { [caseKey]: row[caseKey] } : { c: row.c, o: row.o };
    }
    if (Object.keys(params).length) hooks.applyParams(params, caseKey);
  }

  function go(stage) {
    error = ""; stopped = false;
    if (stage === "params") freshRows();
    state.stage = stage; notify(); render(true);
    if (stage === "method" && !state.picks) loadPicks();
    if (stage === "params" && !freshRows()) loadParams();
  }

  // ── 渲染 ──
  function progress() {
    const list = node("ol", "vc-guide-progress"); list.setAttribute("aria-label", t("AI 引导进度", "AI guide progress"));
    const at = ["story", "review"].includes(state.stage) ? 0 : FLOW_STAGES.findIndex((s) => s.key === state.stage);
    FLOW_STAGES.forEach((stage, i) => {
      let label = `${i < at ? "✓" : i + 1} ${zh ? stage.zh : stage.en}`; // 完成的步骤用 ✓，不只靠颜色区分
      if (i === 0 && state.stage === "story") label += zh ? ` · 第 ${Math.min(state.turns.length + 1, questionCount())}/${questionCount()} 题` : ` · ${Math.min(state.turns.length + 1, questionCount())}/${questionCount()}`;
      const item = node("li", i < at ? "done" : "", label); if (i === at) item.setAttribute("aria-current", "step");
      if (i < at) item.setAttribute("aria-label", `${zh ? stage.zh : stage.en} · ${t("已完成", "done")}`); list.append(item);
    });
    return list;
  }
  function loader(content, shape) {
    const box = node("div", "vc-guide-loader"), head = node("div", "vc-guide-loader-head"), icon = node("span", "vc-guide-spinner");
    icon.setAttribute("aria-hidden", "true");
    status.textContent = ({ question: t("正在结合公司资料准备问题…", "Preparing a question from company information…"), draft: caseKey ? t("正在根据你的回答整理估值思路…", "Organizing your answers into a valuation narrative…") : t("正在把你的回答整理成两个场景…", "Turning your answers into two cases…"),
      picks: t("正在按你的叙事挑选估值方法…", "Choosing methods that fit your story…"), params: t("正在按叙事和财报给出参数建议…", "Suggesting inputs from your story and the financials…") })[busy] || "";
    head.append(icon, status, button(t("停止", "Stop"), () => active?.abort())); box.append(head);
    const skeleton = node("div", "vc-guide-skeleton"); skeleton.setAttribute("aria-hidden", "true");
    for (const cls of shape) skeleton.append(node("span", cls));
    box.append(skeleton); content.append(box);
  }
  // AI 这一步失败时：错误说明 + 就近的重试按钮，放在这一步最上面（不要让人去长列表底部找）
  function switchModelButton() {
    if (typeof hooks.switchModel !== "function") return null;
    const change = button(t("切换模型", "Switch model"), () => hooks.switchModel(change));
    change.setAttribute("aria-haspopup", "menu"); change.setAttribute("aria-expanded", "false");
    change.title = t("切换后可重试，已填写的回答会保留。", "Switch models, then retry. Your answers are kept.");
    return change;
  }
  function retryBox(content, message, label, retry) {
    const box = node("div", "vc-flow-retry"); box.setAttribute("role", "alert");
    const words = node("div", ""); words.append(node("strong", "", message), node("p", "", error));
    const again = button(label, retry, true); box.append(words, again);
    const change = switchModelButton(); if (change) box.append(change);
    content.append(box);
  }
  function actions(...items) { const bar = node("div", "vc-guide-actions vc-guide-sticky"); bar.append(...items.filter(Boolean)); return bar; }

  function referenceText(tag, cls, text, path, warningsOnly = false) {
    const element = node(tag, cls), value = String(text || "");
    const checked = cleanGuideAudit(state.audit, state.question || { type: "summary", drafts: state.drafts }, state.references, state.turns);
    const item = checked?.items.find((entry) => entry.path === path && entry.text === value);
    const labels = item && guideAuditLabels(item, lang);
    const sources = new Map(citedGuideReferences(value, state.references).map((source) => [source.number, source.text]));
    let offset = 0;
    for (const match of value.matchAll(/[\[［](\d{1,3})[\]］]/g)) {
      const number = Number(match[1]); if (!number) continue;
      element.append(document.createTextNode(value.slice(offset, match.index)));
      const wrap = node("span", "vc-guide-cite"), trigger = node("button", "vc-guide-cite-trigger", `[${number}]`);
      trigger.type = "button";
      trigger.setAttribute("aria-label", t(`查看资料 ${number}`, `View source ${number}`));
      const popup = node("span", "vc-guide-cite-popover"); popup.setAttribute("popover", "auto"); popup.setAttribute("role", "tooltip");
      popup.id = `guide-source-${crypto.randomUUID()}`; trigger.setAttribute("aria-describedby", popup.id);
      popup.append(node("strong", "", t(`资料 [${number}]`, `Source [${number}]`)), node("span", "", sources.get(number) || t("本轮未提供这条资料，暂时无法核实这处引用。", "This source was not supplied for this question; the citation cannot be verified.")));
      popup.append(node("span", "vc-guide-audit-detail", t("本段核验：", "Passage check: ") + (labels ? labels.support : t("尚未完成语义核验", "Semantic check unavailable"))));
      let closeTimer;
      const close = () => { clearTimeout(closeTimer); if (popup.matches(":popover-open")) popup.hidePopover(); };
      const show = () => {
        clearTimeout(closeTimer); if (locked || destroyed || !trigger.isConnected) return;
        if (!popup.matches(":popover-open")) popup.showPopover();
        const rect = trigger.getBoundingClientRect(), gap = 8, edge = 12;
        const width = Math.min(360, innerWidth - edge * 2);
        popup.style.width = `${width}px`;
        popup.style.left = `${Math.max(edge, Math.min(rect.left, innerWidth - width - edge))}px`;
        const height = popup.getBoundingClientRect().height;
        popup.style.top = `${rect.bottom + gap + height <= innerHeight - edge ? rect.bottom + gap : Math.max(edge, rect.top - gap - height)}px`;
      };
      const later = () => { clearTimeout(closeTimer); closeTimer = setTimeout(close, 160); };
      trigger.addEventListener("mouseenter", show); trigger.addEventListener("mouseleave", later);
      trigger.addEventListener("focus", show); trigger.addEventListener("blur", later);
      trigger.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); show(); });
      popup.addEventListener("mouseenter", () => clearTimeout(closeTimer)); popup.addEventListener("mouseleave", later);
      popup.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); });
      wrap.append(trigger, popup); element.append(wrap); offset = match.index + match[0].length;
    }
    element.append(document.createTextNode(value.slice(offset)));
    if (labels && (checked.status === "used" || item.support === "missing_source")) {
      const caption = labels.warning ? (item.support === "uncited" ? t("未标注引用", "Citation needed") : labels.support) : !warningsOnly && ["fact", "assumption", "mixed"].includes(item.kind) ? labels.kind : "";
      if (caption) {
        const badge = node("span", "vc-guide-audit" + (labels.warning ? " warning" : ""), caption);
        badge.title = [labels.kind, labels.support].filter(Boolean).join(" · "); element.append(badge);
      }
    }
    return element;
  }

  function renderQuestion(content) {
    const q = state.question;
    const routing = cleanGuideAudit(state.audit, q, state.references, state.turns)?.routing;
    let reuseButton = null;
    const fieldset = node("fieldset", "vc-guide-options"), legend = referenceText("legend", "", q.question, "question", true);
    if (q.selection === "multiple") legend.append(node("span", "vc-guide-tag", t("可多选", "Select all that apply")));
    fieldset.append(legend, referenceText("p", "vc-guide-context", q.context, "context", true));
    const help = node("p", "vc-question-help vc-guide-answer-help", q.selection === "multiple"
      ? t("可多选。请选择你的判断或资料状态；未来预期仍需验证。", "Select all that apply. Choose your view or evidence status; forecasts remain unverified.")
      : state.turns.length === 0 && state.guideMode !== "drivers"
        ? t("选择最主要的一项，其他变化可在补充说明中填写。未来预期仍需验证。", "Choose the main change; add others in a note. Forecasts remain unverified.")
        : t("选择最符合你判断的一项，可补充说明。未来预期仍需验证。", "Choose the closest answer and add a note if needed. Forecasts remain unverified."));
    fieldset.append(help);
    if (state.references.length) {
      const sources = node("details", "vc-guide-sources");
      sources.append(node("summary", "", t(`本轮资料 · ${state.references.length} 条`, `Sources for this question · ${state.references.length}`)));
      sources.append(node("p", "vc-question-help", t("以下是本轮提供给 AI 的资料；未标注引用的陈述不代表已获这些资料支持。", "These excerpts were supplied to AI for this question. Uncited claims are not necessarily supported by them.")));
      const list = node("ol", "");
      state.references.forEach((text, i) => { const row = node("li", ""); row.append(node("strong", "", `[${i + 1}] `), document.createTextNode(text)); list.append(row); });
      sources.append(list); fieldset.append(sources);
    } else fieldset.append(node("p", "vc-question-help", t("本轮暂无公司资料，可补充来源或保留待验证。", "No company excerpts supplied; add sources or leave claims unverified.")));
    const routingNote = guideRoutingNote(routing, lang);
    if (routingNote) {
      const note = node("div", "vc-guide-coverage"); note.setAttribute("role", "note");
      note.append(node("p", "", routingNote));
      if (routing.coverage === "covered") {
        const previous = state.turns[routing.matchedTurn];
        const excerpt = node("blockquote", "", previous.answer);
        reuseButton = button(t("沿用这段回答", "Reuse this answer"), () => {
          // Only the user's exact prior words are copied. The user confirms with Next.
          if (answerText()) return;
          state.selected = []; state.otherText = ""; state.freeText = previous.answer;
          notify(); render();
        });
        reuseButton.title = t("沿用后仍可修改，点击下一题才确认。已填写本题时请直接继续。", "Edit after reusing; Next confirms your answer. If already filled in, continue with your current answer.");
        note.append(excerpt, reuseButton);
      }
      fieldset.append(note);
    } else if (routing?.status === "unavailable") fieldset.append(node("p", "vc-guide-audit-note", t("本题的回答覆盖检查暂不可用，仍可正常回答。", "Answer coverage checks are unavailable; you can answer normally.")));
    const inputs = new Map(); let otherInput = null;
    for (const option of [...q.options, { id: "other", label: t("其他，我自己写", "Something else (write your own)"), detail: "" }, { id: "unknown", label: t("还不确定，先待验证", "Not sure yet; mark as to verify"), detail: "" }]) {
      const label = node("label", "vc-guide-option"), input = node("input", "");
      input.type = q.selection === "multiple" ? "checkbox" : "radio"; input.name = "flow-guide"; input.value = option.id; input.checked = state.selected.includes(option.id);
      const path = `options.${q.options.indexOf(option)}`;
      const words = node("span", ""); words.append(referenceText("strong", "", option.label, `${path}.label`, true)); if (option.detail) words.append(referenceText("small", "", option.detail, `${path}.detail`, true));
      if (option.id === "other") {
        otherInput = node("input", "vc-guide-other"); otherInput.type = "text"; otherInput.maxLength = 400; otherInput.value = state.otherText; otherInput.hidden = !input.checked;
        otherInput.placeholder = t("写下你自己的判断", "Describe your own view"); otherInput.setAttribute("aria-label", t("其他选项内容", "Your own option"));
        otherInput.addEventListener("input", () => { state.otherText = otherInput.value; update(); notify(); });
        otherInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); if (!next.disabled) submitAnswer(); } });
        words.append(otherInput);
      }
      label.append(input, words); fieldset.append(label); inputs.set(option.id, input);
      input.addEventListener("change", () => {
        state.selected = q.selection === "single" ? [option.id] : option.id === "unknown" ? (input.checked ? ["unknown"] : []) : [...inputs].filter(([id, box]) => id !== "unknown" && box.checked).map(([id]) => id);
        for (const [id, box] of inputs) box.checked = state.selected.includes(id);
        const showOther = state.selected.includes("other"); if (showOther && otherInput.hidden) requestAnimationFrame(() => otherInput.focus()); otherInput.hidden = !showOther;
        update(); notify();
      });
    }
    content.append(fieldset);
    const noteLabel = node("label", "vc-thesis-field vc-guide-note"); noteLabel.append(node("span", "", t("补充说明（可选）", "Additional note (optional)")));
    const free = node("textarea", "vc-note-input"); free.rows = 3; free.maxLength = 800; free.value = state.freeText;
    free.placeholder = t("不必用专业术语，说说你的判断和不确定的地方。", "Use your own words, including what you are unsure about.");
    noteLabel.append(free);
    const addNote = node("button", "vc-guide-link", t("+ 补充说明", "+ Add a note")); addNote.type = "button";
    addNote.addEventListener("click", () => { addNote.hidden = true; noteLabel.hidden = false; free.focus(); });
    noteLabel.hidden = !state.freeText; addNote.hidden = !noteLabel.hidden;
    const count = node("p", "vc-question-help");
    const last = state.turns.length === questionCount() - 1;
    const next = button(last ? (caseKey ? t("下一步：确认估值思路", "Next: review valuation narrative") : t("下一步：整理成两个场景", "Next: draft both cases")) : t("下一题", "Next question"), submitAnswer, true);
    function update() { state.freeText = free.value; const n = answerText().length; count.textContent = `${n}/800` + (n > 800 ? t(" · 回答过长，请精简。", " · Please shorten your answer.") : ""); count.hidden = n < 600; next.disabled = !n || n > 800; if (reuseButton) reuseButton.disabled = n > 0; }
    free.addEventListener("input", () => { update(); notify(); });
    free.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitAnswer(); } });
    update();
    content.append(addNote, noteLabel, count, actions(next, state.turns.length ? button(t("上一步", "Back"), () => { backQuestion(); notify(); render(true); }) : null));
  }

  function renderReview(content) {
    const { c, o } = state.drafts;
    const conflict = caseKey ? state.drafts[caseKey]?.conflict : state.drafts.conflict;
    content.append(node("p", "vc-guide-lead", caseKey ? t(`这是根据你本轮回答整理的${caseName()}。核对假设、依据和待验证条件，再进入参数。`, `Review the ${caseName()} drawn from your answers, including its evidence and unverified conditions, before entering inputs.`) : state.guideMode === "drivers"
      ? t("以下是围绕你已选假设建议的保守、乐观情景。新增条件还需要你确认；请修改不符合想法的部分。", "These proposed downside and upside cases build on your selected assumptions. Review new conditions and edit anything that does not match your view.")
      : t("AI 根据你的回答写了两个场景。看看是否符合你的想法，之后随时能改。", "AI wrote both cases from your answers. Check they match your view; you can edit them anytime.")));
    if (conflict) {
      const warn = node("div", "vc-guide-conflict"); warn.setAttribute("role", "note");
      warn.append(node("strong", "", t("回答和场景方向可能不一致", "Your answers may not fit the case direction")), referenceText("p", "", conflict, "drafts.conflict"),
        node("p", "", t("可以返回修改回答，或确认后在编辑时再调整。", "Go back and adjust, or confirm and edit later.")));
      content.append(warn);
    }
    const grid = node("div", "vc-flow-cases");
    for (const [key, draft] of (caseKey ? [[caseKey, state.drafts[caseKey]]] : [["c", c], ["o", o]])) {
      const card = node("section", "vc-flow-case " + key);
      const caseName = singleCase ? t("单场景叙事", "Single-case story") : key === "c" ? t("保守场景", "Conservative case") : t("乐观场景", "Optimistic case");
      // 叙事可以直接在这里改一句，不用退回去重新回答
      const story = node("textarea", "vc-flow-story"); story.value = draft.story; story.maxLength = 800; story.rows = 3;
      story.setAttribute("aria-label", `${caseName} · ${t("叙事", "Story")}`);
      story.addEventListener("input", () => { draft.story = story.value; if (caseKey) { state.rows = null; state.paramsFor = ""; state.picks = null; } notify(); next.disabled = caseKey ? !draft.story.trim() : !c.story.trim() || !o.story.trim(); });
      card.append(node("h4", "", caseName), node("span", "vc-guide-audit", t("叙事假设 · 由你确认", "Story assumption · yours to confirm")), story);
      const dl = node("dl", "");
      const row = (label, field) => { const value = draft[field]; if (!value) return; dl.append(node("dt", "", label), referenceText("dd", "", value, `drafts.${key}.${field}`)); };
      row(t("依据", "Evidence"), "evidence"); row(t("待验证", "To verify"), "uncertainties");
      card.append(dl);
      if (draft.impacts?.length) {
        const list = node("ul", "vc-flow-impacts");
        for (const impact of draft.impacts) {
          const meta = THESIS_IMPACTS.find((item) => item.key === impact.key);
          const li = node("li", ""); li.append(node("strong", "", `${zh ? meta.zh : meta.en} ${impactDirection(impact.key, impact.direction, lang)}`));
          if (impact.reason) li.append(referenceText("span", "", impact.reason, `drafts.${key}.impacts.${draft.impacts.indexOf(impact)}.reason`)); list.append(li);
        }
        card.append(node("p", "vc-flow-impacts-label", t("会影响", "Affects")), list);
      }
      grid.append(card);
    }
    const next = button(singleCase ? t("确认叙事，选方法", "Confirm story and choose a method") : caseKey ? (caseKey === "o" ? t("确认乐观叙事，填参数", "Confirm optimistic story and enter inputs") : t("确认保守叙事，选方法", "Confirm conservative story and choose a method")) : state.guideMode === "drivers" ? t("确认两个情景，选方法", "Confirm cases and choose a method") : t("下一步：选方法", "Next: choose a method"), () => {
      hooks.applyThesis(caseKey ? { [caseKey]: state.drafts[caseKey] } : { c, o });
      if (caseKey === "o") { state.method = hooks.currentMethod(); go("params"); } else go("method");
    }, true);
    content.append(node("p", "vc-question-help", t("叙事可以直接在框里改；依据和影响进入编辑页后也都能改。", "Edit the story right here; evidence and effects stay editable in the editor.")), grid, actions(
      next,
      button(t("上一步", "Back"), () => { backQuestion(); notify(); render(true); })));
  }

  function renderMethod(content) {
    const methods = hooks.methods(), byKey = new Map(methods.map((m) => [m.key, m]));
    if (caseKey === "o") {
      state.method = hooks.currentMethod();
      content.append(node("p", "vc-guide-lead", t("沿用保守情景已确认的估值方法和基础数据，本轮单独确认乐观假设。", "Keep the confirmed method and base data; confirm optimistic assumptions separately.")), actions(button(t("下一步：填参数", "Next: enter inputs"), () => go("params"), true), button(t("上一步", "Back"), () => go("review")))); return;
    }
    if (state.method && !byKey.has(state.method)) state.method = "";
    const fieldset = node("fieldset", "vc-guide-options"), legend = node("legend", "", t("用哪种方法把叙事变成数字？", "Which method turns this story into numbers?"));
    if (error) retryBox(content, t("AI 推荐方法暂时失败。可以重试，也可以直接从下面选一个方法。", "Method recommendation failed. Retry, or pick a method below."), t("重试 AI 推荐", "Retry"), () => { state.picks = null; loadPicks(); });
    fieldset.append(legend, node("p", "vc-guide-context", state.picks?.summary || t("从下面选一个方法；不确定时可以先选 P/E 市盈率。", "Pick a method below; P/E is a reasonable default if unsure.")),
      node("p", "vc-question-help", t("先用一个方法完成估值；想对照的话，之后可以再加一张用备选方法的估值卡。", "Finish with one method first; you can add another card with an alternative method later to compare.")));
    const decision = methodDecisionText(state.picks?.decision, lang); if (decision) fieldset.append(node("p", "vc-question-help", decision));
    const choice = (method, reason, tag, pick) => {
      const label = node("label", "vc-guide-option"), input = node("input", ""); input.type = "radio"; input.name = "flow-method"; input.value = method.key; input.checked = state.method === method.key;
      const words = node("span", ""), title = node("strong", "", method.title); if (tag) title.append(node("span", "vc-guide-tag", tag));
      // 方法名对新手不直观：方法本身的一句话说明始终显示，AI 的理由另起一行
      words.append(title); if (method.subtitle) words.append(node("small", "", method.subtitle)); if (reason) words.append(node("small", "vc-flow-reason", t("为什么推荐：", "Why: ") + reason));
      const readiness = readinessText(pick?.readiness, lang); if (readiness) words.append(node("small", "vc-flow-reason", readiness));
      if (pick?.suitability === "needs_review") words.append(node("small", "vc-flow-reason", t("适配仍待确认，请核对业务资料。", "Fit needs review; check the business evidence.")));
      label.append(input, words);
      input.addEventListener("change", () => { state.method = method.key; next.disabled = false; updateNext(); notify(); });
      return label;
    };
    const picked = (state.picks?.picks || []).filter((p) => byKey.has(p.key));
    picked.forEach((p, i) => fieldset.append(choice(byKey.get(p.key), p.reason, p.suitability === "needs_review" ? t("待确认", "Needs review") : i ? t("备选", "Alternative") : t("推荐", "Recommended"), p)));
    const others = methods.filter((m) => !picked.some((p) => p.key === m.key));
    const more = node("details", "vc-flow-more"); more.append(node("summary", "", t(`其他方法（${others.length}）`, `Other methods (${others.length})`)));
    const moreList = node("div", "vc-guide-options vc-flow-more-list"); for (const m of others) moreList.append(choice(m, "", ""));
    more.append(moreList); more.open = !picked.length || others.some((m) => m.key === state.method);
    content.append(fieldset, more);
    const next = button(t("下一步：填参数", "Next: enter inputs"), () => {
      hooks.selectMethod(state.method);
      const missing = picked.find((p) => p.key === state.method)?.readiness?.missingInputs || [];
      if (missing.some((item) => item.key === "assets" || item.key === "shares")) { hooks.finish(); return; }
      go("params");
    }, true);
    function updateNext() {
      const missing = picked.find((p) => p.key === state.method)?.readiness?.missingInputs;
      next.textContent = missing?.length ? t("补充数据并使用", "Add data and use") : t("下一步：填参数", "Next: enter inputs");
    }
    updateNext(); next.disabled = !state.method;
    content.append(actions(next, button(t("上一步", "Back"), () => go("review"))));
  }

  function renderParams(content) {
    const fields = new Map(hooks.fields().map((f) => [f.k, f]));
    const thesis = caseKey ? { [caseKey]: hooks.getThesis()[caseKey] } : hooks.getThesis(), checks = caseKey ? {} : hooks.checkParams(Object.fromEntries((state.rows || []).filter((r) => !r.single && finite(r.c) && finite(r.o)).map((r) => [r.k, { c: r.c, o: r.o }])));
    const head = node("div", "vc-guide-options"); head.append(node("legend", "", caseKey ? t(`${caseName()}的参数取多少？`, `Inputs for the ${caseName()}`) : t("保守和乐观场景，各取多少？", "How much in each case?")),
      node("p", "vc-guide-context", t("AI 按你的叙事和财报给了建议值，可以直接改。不想用某一项就取消「采用」，表单里会保留现有的数（可能是示例值）。", "AI suggested values from your story and the financials; edit freely. Untick “Use” to keep the existing value instead (it may be a sample).")));
    content.append(head);
    if (caseKey === "o") {
      content.append(node("p", "vc-question-help", t("共用方法与基础数据：", "Shared method and base data: ") + (hooks.methods().find((m) => m.key === hooks.currentMethod())?.title || hooks.currentMethod()) + " · " + hooks.fields().filter((f) => f.col === "single").map((f) => `${f.label} ${f.value ?? "—"}${f.unit || ""}`).join("；")));
    }
    if (!state.rows?.some((r) => r.ai)) content.append(node("p", "vc-guide-error", t("这次 AI 没有给出可用的建议值，可以直接填，或重试。", "No usable suggestions this time. Fill them in yourself, or retry.")));
    const list = node("div", "vc-flow-params");
    for (const row of state.rows || []) {
      const field = fields.get(row.k); if (!field) continue;
      const card = node("section", "vc-flow-param" + (row.use ? " on" : ""));
      const top = node("label", "vc-flow-param-head"), use = node("input", ""); use.type = "checkbox"; use.checked = row.use;
      use.setAttribute("aria-label", t(`采用 ${field.label} 的建议值`, `Use the suggestion for ${field.label}`));
      top.append(use, node("span", "vc-flow-use", t("采用", "Use")), node("strong", "", field.label + (field.unit ? `（${field.unit}）` : "")));
      if (row.single && !finite(fields.get(row.k)?.value) && !row.ai) top.append(node("span", "vc-guide-tag need", t("缺数据，需要填写", "Required")));
      else if (!row.ai) top.append(node("span", "vc-guide-tag", t("无建议", "No suggestion")));
      if (row.single) use.disabled = !finite(fields.get(row.k)?.value); // 缺数据的必须填，不能跳过
      const values = node("div", "vc-flow-param-values" + (row.single || caseKey ? " single" : ""));
      const box = (key, caption) => {
        const wrap = node("label", ""), input = node("input", "vc-input"); input.type = "number"; input.step = "any"; input.value = finite(row[key]) ? String(row[key]) : "";
        input.setAttribute("aria-label", `${field.label} · ${caption}`);
        input.addEventListener("input", () => { const n = Number(input.value); row[key] = input.value !== "" && Number.isFinite(n) ? n : null; if (!row.use) { row.use = true; use.checked = true; card.classList.add("on"); keep.hidden = true; } notify(); update(); });
        wrap.append(node("span", "", caption), input); return wrap;
      };
      if (row.single) values.append(box("v", singleCase ? t("数值", "Value") : t("数值（两个场景共用）", "Value (both cases)")));
      else if (caseKey) values.append(box(caseKey, caseName()));
      else values.append(box("c", t("保守", "Conservative")), box("o", t("乐观", "Optimistic")));
      card.append(top, values);
      if (row.reason) card.append(node("p", "vc-flow-param-reason", row.reason));
      // 历史参考：点一下填入（和编辑页的参考一致）；区间按 保守=最低、乐观=最高
      if (field.refs?.chips?.length) {
        const fmtRef = (v) => field.refs.unit === "%" ? `${v}%` : `${v}x`;
        const refs = node("div", "vc-flow-refs"); refs.append(node("span", "", t("历史参考：", "History: ")));
        const set = (cv, ov) => { if (row.single) row.v = cv; else if (caseKey) row[caseKey] = cv; else { row.c = cv; row.o = ov; } row.use = true; notify(); render(); };
        const vals = field.refs.chips.map((c) => c.value), lo = Math.min(...vals), hi = Math.max(...vals);
        if (!row.single && !caseKey && hi > lo) { const b = node("button", "vc-refchip vc-refrange", `${t("填入区间", "Use range")} ${fmtRef(lo)}–${fmtRef(hi)}`); b.type = "button"; b.addEventListener("click", () => set(lo, hi)); refs.append(b); }
        for (const chip of field.refs.chips.slice(0, 3)) { const b = node("button", "vc-refchip", `${chip.label} ${fmtRef(chip.value)}`); b.type = "button"; b.addEventListener("click", () => set(chip.value, chip.value)); refs.append(b); }
        card.append(refs);
      }
      const keep = node("p", "vc-flow-keep"); // 不采用时说清楚会用什么数
      const current = row.single ? (finite(field.value) ? String(field.value) : "") : (caseKey ? (finite(field.value?.[caseKey]) ? String(field.value[caseKey]) : "") : (finite(field.value?.c) ? `${field.value.c} / ${field.value.o}` : ""));
      keep.textContent = current ? t(`不采用：将沿用表单里的 ${current}${field.isDefault ? "（这是方法自带的示例值，不是对这家公司的判断）" : ""}`, `Not used: keeps ${current}${field.isDefault ? " (the method's sample value)" : ""}`) : "";
      keep.classList.toggle("warn", !!field.isDefault); keep.hidden = row.use || !current; card.append(keep);
      const story = field.meta ? fieldStoryHint(field.meta, thesis, lang) : null; if (story) card.append(node("p", "vc-story-hint", story));
      const check = checks[field.label]; if (check) card.append(node("p", "vc-flow-param-check", t("和过去几年比：", "Compared with history: ") + check));
      use.addEventListener("change", () => { row.use = use.checked; card.classList.toggle("on", row.use); keep.hidden = row.use || !keep.textContent; notify(); update(); });
      list.append(card);
    }
    content.append(list);
    const next = button(t("下一步：看估值", "Next: see the value"), () => { applyRows(); go("result"); }, true);
    const why = node("p", "vc-question-help vc-flow-why"); // 主按钮不能点时说明原因
    function update() {
      next.disabled = (state.rows || []).some((r) => r.use && (r.single ? !finite(r.v) : !(caseKey ? finite(r[caseKey]) : finite(r.c) && finite(r.o))));
      why.textContent = next.disabled ? caseKey ? t("请填完整当前情景勾选采用的参数。", "Complete every input marked Use for this case.") : t("勾选「采用」的参数需要填完整（两个场景都要填）。", "Fill in every input marked “Use” (both cases).") : ""; why.hidden = !next.disabled;
    }
    update();
    content.append(why, actions(next, button(t("上一步", "Back"), () => go(caseKey === "o" ? "review" : "method")), button(t("重新建议", "Suggest again"), () => { state.rows = null; loadParams(); })));
  }

  function renderResult(content) {
    if (caseKey) { renderCaseResult(content); return; }
    const r = hooks.result();
    const box = node("div", "vc-flow-result");
    if (r && finite(r.low) && finite(r.high)) {
      const lo = Math.min(r.low, r.high), hi = Math.max(r.low, r.high);
      const cur = r.currency ? ` ${r.currency}` : "";
      box.append(node("p", "vc-flow-result-label", t("你的合理价值区间（每股，保守 – 乐观）", "Your fair value per share (conservative – optimistic)")),
        node("p", "vc-flow-result-range", (lo === hi ? r.fmt(lo) : `${r.fmt(lo)} – ${r.fmt(hi)}`) + cur));
      if (finite(r.price)) box.append(node("p", "vc-flow-result-price", t(`现价 ${r.fmt(r.price)}${cur}`, `Price ${r.fmt(r.price)}${cur}`) + (r.verdict ? ` · ${r.verdict}` : "")));
      if (/安全边际|margin of safety/i.test(r.verdict)) box.append(node("p", "vc-flow-result-note", t("安全边际：现价比你算出的合理价值低多少。越高，买错的余地越大。", "Margin of safety: how far the price sits below your fair value. Higher leaves more room for error.")));
      if (r.method) box.append(node("p", "vc-flow-result-note", t(`方法：${r.method}`, `Method: ${r.method}`) + (r.inputs?.length ? t(` · ${r.inputs.join("，")}`, ` · ${r.inputs.join(", ")}`) : "")));
      if (r.inverted) box.append(node("p", "vc-guide-error", t("保守场景算出的价值反而高于乐观场景，可能是两组参数填反了。可以返回上一步检查。", "The conservative case comes out higher than the optimistic one; the inputs may be swapped. Go back to check.")));
      if (r.sample) box.append(node("p", "vc-guide-error", t("参数仍是方法自带的示例值，这个结果还不是你的判断。可以返回上一步填参数。", "Inputs are still the method's samples, so this is not your view yet. Go back to fill them in.")));
      else if (r.samples?.length) box.append(node("p", "vc-guide-error", t(`这些参数仍是示例值：${r.samples.join("、")}。建议返回上一步按公司情况填写。`, `Still sample values: ${r.samples.join(", ")}. Consider going back to fill them in.`)));
    } else box.append(node("p", "vc-guide-error", t("还算不出结果：", "Can't calculate yet: ") + (r?.missing?.length ? t(`${r.missing.join("、")} 还没填。`, `${r.missing.join(", ")} missing. `) : t("有参数没填完整。", "some inputs are missing. ")) + t("返回上一步补齐，或进入编辑后再填。", "Go back, or fill them in the editor.")));
    // 能保存就在这里直接保存；不能保存（区间不完整、两档相同）时去编辑页补全
    const canSave = r?.canSave && !r.sample;
    content.append(box, node("p", "vc-guide-lead", canSave ? t("确认没问题就直接保存；也可以先去编辑页看看敏感性分析、再改改。", "Save now, or open the editor first to review sensitivity and adjust.") : t("还不能保存：先去编辑页把参数补完整，保守和乐观要算出不同的价值。", "Not ready to save: complete the inputs in the editor so the two cases give different values.")));
    const restart = node("button", "vc-guide-link", t("从头再来", "Start over")); restart.type = "button";
    restart.addEventListener("click", () => { if (!confirm(t("清空引导里的问答，重新开始？已经填进表单的内容不受影响。", "Clear the guide's answers and start again? What's already in the form stays."))) return; state = empty(); notify(); render(true); });
    content.append(canSave
      ? actions(button(t("保存估值", "Save valuation"), () => hooks.save(), true), button(t("先去编辑页看看", "Open the editor first"), () => hooks.finish()), button(t("上一步", "Back"), () => go("params")), restart)
      : actions(button(t("去编辑页补全", "Complete in the editor"), () => hooks.finish(), true), button(t("上一步", "Back"), () => go("params")), restart));
  }

  function renderCaseResult(content) {
    const r = hooks.result(caseKey), value = caseKey === "c" ? r?.low : r?.high;
    const valid = finite(value) && value > 0 && !r?.missing?.length;
    const box = node("div", "vc-flow-result");
    box.append(node("p", "vc-flow-result-label", t(`${caseName()} · 每股合理价值`, `${caseName()} · fair value per share`)),
      node("p", "vc-flow-result-range", valid ? `${r.fmt(value)} ${r.currency || ""}` : t("参数尚未完整", "Inputs incomplete")));
    box.append(node("p", "vc-question-help", t("本情景参数已写入草稿，尚未保存为正式估值。", "This case’s inputs are in the draft; the valuation is not saved yet.")));
    if (r?.samples?.length) box.append(node("p", "vc-guide-error", t(`仍需核对示例值：${r.samples.join("、")}`, `Review sample values: ${r.samples.join(", ")}`)));
    if (!valid) box.append(node("p", "vc-guide-error", t(`请返回补齐：${r?.missing?.join("、") || "参数"}`, `Go back to complete: ${r?.missing?.join(", ") || "inputs"}`)));
    const next = button(singleCase ? t("确认单场景估值", "Confirm single-case valuation") : caseKey === "c" ? t("保守情景完成，开始乐观情景", "Conservative case complete; start optimistic case") : t("乐观情景完成，对比两个情景", "Optimistic case complete; compare cases"), () => hooks.completeCase(), true);
    next.disabled = !valid;
    content.append(box, actions(next, button(t("返回修改参数", "Revise inputs"), () => go("params")), button(t("去编辑页核对", "Review in editor"), () => hooks.exit())));
  }

  // 开始页：先让人知道接下来要做什么、要多久、谁说了算，再给一个明确的开始按钮
  const INTRO = [
    ["chat-smile-2-line", t("回答 3–4 个经营问题", "Answer 3–4 business questions"), t("AI 结合公司资料提问，选一个答案或自己写", "AI asks about the company; pick an answer or write your own")],
    ["compass-3-line", caseKey === "o" ? t("沿用共用方法", "Keep the shared method") : t("选估值方法", "Choose a method"), caseKey === "o" ? t("沿用已确认的方法和基础数据", "Use the confirmed method and base data") : t("按你的叙事推荐合适的方法", "Methods that fit your story")],
    ["equalizer-line", t("确认关键数字", "Confirm key numbers"), caseKey ? t(`只确认${caseName()}的参数`, `Confirm only the ${caseName()} inputs`) : t("AI 给出保守和乐观两组建议值，可以改", "Suggested conservative and optimistic values you can edit")],
    ["line-chart-line", t("看估值结果", "See the result"), singleCase ? t("核对主情景的每股合理价值", "Review the main case’s fair value per share") : caseKey ? t("先看本情景的每股价值，两边完成后再对照", "See this case’s value; compare after completing both") : t("合理价值区间和现价对比", "Fair value range vs. the current price")],
  ];
  function renderIntro(content) {
    host.classList.add("intro");
    const list = node("ol", "vc-flow-intro");
    for (const [icon, title, detail] of INTRO) {
      const item = node("li", ""), mark = node("i", "ri-" + icon); mark.setAttribute("aria-hidden", "true");
      const words = node("span", ""); words.append(node("strong", "", title), node("small", "", detail));
      item.append(mark, words); list.append(item);
    }
    const start = button(caseKey ? t(`开始${caseName()}`, `Start the ${caseName()}`) : t("开始", "Start"), askNext, true); start.classList.add("vc-flow-start");
    const manual = node("button", "vc-guide-link", t("我想自己填写", "I'd rather fill it in myself")); manual.type = "button";
    manual.addEventListener("click", () => hooks.exit());
    const go = node("div", "vc-flow-intro-go"); go.append(start, manual);
    content.append(list, node("p", "vc-flow-intro-note", caseKey ? singleCase ? t("只完成一套业务判断和参数，得到一个每股合理价值。随时可以返回修改。", "Complete one set of business views and inputs for one fair value per share. Revise anytime.") : t("每个情景分别完成业务判断、叙事和参数，再对照估值。随时可以返回修改。", "Complete each case’s business views, story and inputs before comparing values. Return to revise anytime.") : t("大约 5 分钟。每一步都由你确认，随时可以返回修改。", "About 5 minutes. You confirm every step and can go back anytime.")), go);
  }
  function renderAssumptions(content) {
    if (state.guideMode !== "drivers" || !state.driverPlan) return;
    const box = node("section", "vc-guide-assumptions"); box.setAttribute("aria-label", t("已选主叙事假设", "Selected narrative assumptions"));
    const currentKey = state.driverPlan.keys[state.turns.length];
    const current = GUIDE_DRIVERS.find((d) => d.key === currentKey);
    const planText = state.driverPlan.status === "used"
      ? t("已按公司资料选出关键变量", "Key drivers selected from company evidence")
      : t("先从经营变量出发；具体业务适配仍待确认", "Starting with business drivers; company fit still needs confirmation");
    box.append(node("p", "vc-question-help", planText + (current && state.stage === "story" ? t(` · 本题：${current.zh}`, ` · This question: ${current.en}`) : "")));
    if (state.turns.length) {
      box.append(node("strong", "", t("已选主叙事假设", "Selected narrative assumptions")), node("p", "vc-question-help", t("点击可返回修改；后续回答需重新确认。", "Click to revise. Subsequent answers will need reconfirmation.")));
      const list = node("div", "vc-guide-assumption-list");
      state.turns.forEach((turn, i) => {
        const driver = GUIDE_DRIVERS.find((d) => d.key === state.driverPlan.keys[i]);
        const revise = button("", () => {
          if (busy) return;
          while (state.turns.length > i) backQuestion();
          error = ""; notify(); render(true);
        });
        revise.title = turn.question + "\n" + turn.answer;
        revise.append(node("strong", "", driver ? (zh ? driver.zh : driver.en) : turn.question), node("span", "", turn.answer));
        list.append(revise);
      });
      box.append(list);
    }
    content.append(box);
  }

  function render(focus = false) {
    host.replaceChildren(); host.classList.remove("intro");
    const intro = !busy && !error && state.stage === "story" && !state.question && !state.turns.length;
    const heading = node("h3", "vc-guide-title", caseKey ? `${company} · ${caseName()}` : intro ? t(`和 AI 一起完成 ${company} 的估值`, `Value ${company} with AI`) : t(`${company} 估值`, `Valuing ${company}`)); heading.tabIndex = -1;
    const top = node("div", "vc-flow-top"); top.append(heading);
    if (!intro) { const leave = button(t("退出引导", "Leave guide"), () => { active?.abort(); hooks.exit(); }); leave.title = t("已回答的内容会保留，之后可以从「AI 引导」回来继续。", "Your answers are kept; resume from “AI guide” later."); top.append(leave); }
    host.append(top);
    if (intro) host.append(node("p", "vc-flow-intro-lead", singleCase ? t("围绕你认为最合理的主情景，分别确认业务判断、资料依据和估值参数。", "Develop your most plausible main case, its evidence and valuation inputs.") : caseKey ? t(caseKey === "c" ? "先判断偏保守但合理的经营情况，确认这一路的叙事和参数后，再开始乐观情景。" : "重新判断乐观情况下哪些增长能兑现、需要什么条件。本轮回答只用于乐观情景。", caseKey === "c" ? "Start with a prudent, plausible business case. Confirm its story and inputs before the optimistic case." : "Assess what can improve and the conditions required. These answers apply only to the optimistic case.") : t("不用先懂估值。回答几个关于这家公司的问题，AI 帮你把判断整理成一份估值。", "No valuation background needed. Answer a few questions about the company and AI turns your views into a valuation.")));
    else host.append(progress());
    const content = node("div", "vc-guide-content"); host.append(content);
    const revenue = businessReportElement(state.businessReports, lang, { onRetry: hooks.retryBusinessReports }); if (revenue) content.append(revenue);
    const management = managementResearchElement(state.managementResearch, lang, { onRetry: hooks.retryManagementResearch }); if (management) content.append(management);
    if (["story", "review"].includes(state.stage) && !busy) renderAssumptions(content);
    // 方法 / 参数两步自己在原地显示错误和重试；其他步骤在顶部显示
    if (error && !["method", "params"].includes(state.stage)) {
      const box = node("div", "vc-flow-retry"); box.setAttribute("role", "alert");
      const words = node("div", ""); words.append(node("p", "", error)); box.append(words);
      const change = switchModelButton(); if (change) box.append(change);
      content.append(box);
    }
    if (busy) loader(content, busy === "draft" ? ["line", "line short", "card", "card"] : busy === "params" ? ["line", "line short", "card", "card", "card"] : ["line", "line short", "opt", "opt", "opt"]);
    else if (state.stage === "review" && state.drafts) renderReview(content);
    // 恢复到这两步但还没有数据时，渲染完再去取（不能在渲染中途触发新的渲染）
    // 卡片隐藏时（「自己填写」模式下恢复草稿）不自动调用 AI，等用户回到引导再取
    else if (state.stage === "method") { if (state.picks || error) renderMethod(content); else if (visible()) queueMicrotask(loadPicks); }
    else if (state.stage === "params") {
      if (freshRows()) renderParams(content);
      else if (error) { retryBox(content, t("AI 参数建议暂时失败。可以重试，或返回换一个方法。", "Input suggestions failed. Retry, or go back and change the method."), t("重试 AI 建议", "Retry"), loadParams); content.append(actions(button(t("手动填写参数", "Enter inputs manually"), () => hooks.finish()), button(t("上一步", "Back"), () => go("method")))); }
      else if (visible()) queueMicrotask(loadParams);
    }
    else if (state.stage === "result") renderResult(content);
    else if (state.question) renderQuestion(content);
    else if (state.turns.length || error) content.append(actions(button(t("继续", "Continue"), askNext, true),
      state.turns.length ? button(t("上一步", "Back"), () => { error = ""; backQuestion(); notify(); render(true); }) : null));
    else renderIntro(content);
    if (!busy && state.audit && ["story", "review"].includes(state.stage) && (state.question || state.drafts)) {
      if (state.audit.status === "used") host.append(node("p", "vc-guide-audit-note", t("Jev 按本轮提供的资料核对陈述与引用；未独立验证原始来源，也不代表预测会兑现。", "Jev checks passages against the supplied excerpts; original sources and future outcomes have not been independently verified.")));
      else if (state.audit.status === "unavailable") host.append(node("p", "vc-guide-audit-note", t("Jev 语义核验暂不可用，引用内容仍可展开查看；本轮陈述未通过语义核验。", "Jev semantic checks are unavailable. You can still inspect the sources; these passages have not been checked.")));
    }
    if (state.turns.length && ["story", "review"].includes(state.stage)) {
      const history = node("details", "vc-guide-history"); history.append(node("summary", "", t(`已回答 ${state.turns.length} 个问题 · 查看记录`, `${state.turns.length} answers · Review history`)));
      for (const turn of state.turns) history.append(node("p", "vc-guide-history-q", turn.question), node("p", "", turn.answer));
      host.append(history);
    }
    if (state.references.length && state.stage === "review") {
      const references = node("details", "vc-guide-history"); references.append(node("summary", "", t("全部参考资料（带编号）", "All source material (numbered)")));
      state.references.forEach((line, i) => references.append(node("p", "", `[${i + 1}] ${line}`))); host.append(references);
    }
    if (locked) for (const control of host.querySelectorAll("button,input,textarea,select")) control.disabled = true;
    if (focus) {
      heading.focus({ preventScroll: true });
      if (host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }
  render();
  return {
    setBusinessReports(raw) {
      if (destroyed) return;
      state.businessReports = cleanBusinessReports(raw); replies.clear(); notify(); render();
    },
    setManagementResearch(raw) {
      if (destroyed || state.managementResearch?.sources.length) return;
      state.managementResearch = recoverManagementResearch(state.managementResearch, raw);
      replies.clear(); notify(); render();
    },
    snapshot: () => JSON.parse(JSON.stringify(state)),
    refresh: () => { if (busy) return; if (stopped) { error = ""; stopped = false; } render(); },
    setLocked(value) { locked = !!value; if (locked) active?.abort(); render(); },
    pause() { active?.abort(); },
    destroy() { destroyed = true; active?.abort(); },
    isBusy: () => !!busy,
  };
}

// Version 2 keeps independent histories and parameter confirmation for each case.
export function cleanFlowState(raw) {
  if (raw?.guideMode === "choose" && raw.version === 2) return { version: 2, guideMode: "choose", managementResearch: recoverManagementResearch(null, raw.managementResearch), businessReports: cleanBusinessReports(raw.businessReports) };
  if (!["single", "sequential"].includes(raw?.guideMode)) return cleanCaseFlowState(raw);
  const single = raw.guideMode === "single";
  if (raw.version !== 2 || !["c", "o", "compare"].includes(raw.activeCase) || !object(raw.cases)) return null;
  const cases = {};
  for (const key of ["c", "o"]) {
    if (!raw.cases[key]) { cases[key] = null; continue; }
    cases[key] = cleanCaseFlowState(raw.cases[key]);
    if (!cases[key] || cases[key].caseKey !== key || cases[key].guideMode !== "drivers" || (single && (key !== "c" || !cases[key].singleCase))) return null;
  }
  const completed = { c: raw.completed?.c === true && cases.c?.stage === "result", o: raw.completed?.o === true && cases.o?.stage === "result" };
  if (raw.activeCase !== "c" && !completed.c) return null;
  if (single && raw.activeCase === "o") return null;
  if (raw.activeCase === "compare" && !(single ? completed.c : completed.o)) return null;
  const basis = { c: typeof raw.basis?.c === "string" ? raw.basis.c.slice(0, 12000) : "", o: typeof raw.basis?.o === "string" ? raw.basis.o.slice(0, 12000) : "" };
  return { version: 2, guideMode: raw.guideMode, modeChosen: raw.modeChosen === true, activeCase: raw.activeCase, cases, completed, basis,
    basisChanged: raw.basisChanged === true,
    managementResearch: recoverManagementResearch(null, raw.managementResearch), businessReports: cleanBusinessReports(raw.businessReports) };
}

export function mountValuationFlow(host, options) {
  const { lang, hooks, onChange } = options, zh = lang !== "en", t = (a, b) => zh ? a : b;
  let initial = cleanFlowState(options.initial);
  // Preserve interviews with real answers; untouched introductions enter the new flow.
  if (initial && !["single", "sequential", "choose"].includes(initial.guideMode) && (initial.turns.length || initial.question || initial.drafts)) return mountCaseFlow(host, options);
  let state = ["single", "sequential"].includes(initial?.guideMode) ? initial : { version: 2, guideMode: "choose", activeCase: "c", cases: { c: null, o: null }, completed: { c: false, o: false }, basis: { c: "", o: "" },
    managementResearch: initial?.managementResearch || null, businessReports: initial?.businessReports || null };
  if (state.guideMode === "sequential" && !state.modeChosen && !state.cases.c?.turns.length && !state.cases.c?.question) state.guideMode = "choose";
  const single = () => state.guideMode === "single";
  let child = null, destroyed = false, locked = false;
  const basisKey = () => JSON.stringify([hooks.currentMethod(), hooks.sharedKey?.() || "", hooks.fields().map((f) => [f.k, f.col, f.col === "single" ? f.value : null])]);
  const capture = () => { if (child && state.activeCase !== "compare") state.cases[state.activeCase] = child.snapshot(); };
  const notify = () => { if (destroyed) return; capture(); updateNavigation(); onChange?.(); };
  function updateNavigation() {
    for (const b of host.querySelectorAll("[data-case-key]")) {
      const key = b.dataset.caseKey;
      b.textContent = (key === "compare" ? (single() ? t("2 确认估值", "2 Confirm valuation") : t("3 对照估值", "3 Compare values")) : (key === "c" ? "1 " : "2 ") + name(key)) + (state.completed[key] ? " ✓" : "");
      b.disabled = locked || (key === "o" && !state.completed.c) || (key === "compare" && !(state.completed.c && (single() || state.completed.o)));
    }
  }
  const name = (key) => single() ? t("单场景估值", "Single-case valuation") : key === "c" ? t("保守情景", "Conservative case") : t("乐观情景", "Optimistic case");
  const button = (label, action, primary = false) => {
    const b = node("button", primary ? "vc-guide-primary" : "vc-guide-secondary", label); b.type = "button";
    b.disabled = locked; b.addEventListener("click", () => { if (!locked && !child?.isBusy()) action(); }); return b;
  };
  function invalidateChangedBasis() {
    const current = basisKey();
    for (const key of ["c", "o"]) {
      const page = state.cases[key];
      const fields = new Map(hooks.fields().map((f) => [f.k, f]));
      const changedInputs = page?.stage === "result" && page.rows?.some((row) => row.use && (row.single
        ? fields.get(row.k)?.value !== row.v : fields.get(row.k)?.value?.[key] !== row[key]));
      if (page && ((state.basis[key] && state.basis[key] !== current) || changedInputs) && ["params", "result"].includes(page.stage)) {
        state.basisChanged = true;
        page.rows = null; page.paramsFor = ""; page.picks = null; page.method = hooks.currentMethod(); page.stage = page.drafts ? "review" : "story";
        state.completed[key] = false;
      }
    }
    if (state.activeCase !== "c" && !state.completed.c) state.activeCase = "c";
    else if (state.activeCase === "compare" && !single() && !state.completed.o) state.activeCase = "o";
  }
  function open(key) {
    capture(); child?.destroy(); child = null; state.activeCase = key; invalidateChangedBasis();
    render(); onChange?.();
  }
  function compare(content) {
    if (single()) {
      const r = hooks.result("c"), value = r?.low;
      content.append(node("h3", "vc-guide-title", t("单场景估值", "Single-case valuation")), node("p", "vc-flow-result-range", finite(value) ? `${r.fmt(value)} ${r.currency || ""}` : "—"), node("p", "", state.cases.c?.drafts?.c?.story || ""));
      const rows = node("dl", "");
      for (const f of hooks.fields()) rows.append(node("dt", "", f.label), node("dd", "", `${f.col === "dual" ? f.value?.c ?? "—" : f.value ?? "—"}${f.unit || ""}`));
      content.append(rows, node("p", "vc-question-help", t("这是一个条件情景下的估值，不代表未来价格确定会达到。", "This valuation depends on one set of assumptions; it is not a guaranteed future price.")));
      const bar = node("div", "vc-guide-actions vc-guide-sticky");
      if (r?.canSave && !r.sample) bar.append(button(t("保存估值", "Save valuation"), () => hooks.save(), true));
      bar.append(button(t("返回修改", "Revise"), () => open("c")), button(t("去编辑页核对", "Review in editor"), () => hooks.finish())); content.append(bar); return;
    }
    const r = hooks.result(), grid = node("div", "vc-flow-cases");
    content.append(node("h3", "vc-guide-title", t("对比保守与乐观情景", "Compare conservative and optimistic cases")),
      node("p", "vc-guide-lead", t("两边分别完成引导，沿用相同方法和基础数据。核对经营假设如何造成估值差异。", "Both interviews are complete, using the same method and base data. Review how their business assumptions explain the value difference.")));
    for (const key of ["c", "o"]) {
      const box = node("section", "vc-flow-case " + key), page = state.cases[key], draft = page?.drafts?.[key], value = key === "c" ? r?.low : r?.high;
      box.append(node("h4", "", name(key)), node("p", "vc-flow-result-range", finite(value) ? `${r.fmt(value)} ${r.currency || ""}` : "—"), node("p", "", draft?.story || ""));
      if (draft?.uncertainties) box.append(node("strong", "", t("待验证条件", "Conditions to verify")), node("p", "", draft.uncertainties));
      const list = node("dl", "");
      for (const field of hooks.fields().filter((f) => f.col === "dual")) {
        list.append(node("dt", "", field.label), node("dd", "", finite(field.value?.[key]) ? `${field.value[key]}${field.unit || ""}` : "—"));
      }
      box.append(list, button(t("返回修改", "Revise this case"), () => { state.completed[key] = false; open(key); })); grid.append(box);
    }
    content.append(grid);
    if (r?.inverted) content.append(node("p", "vc-guide-error", t("保守估值高于乐观估值，请核对两组假设及参数；不会自动交换数值。", "The conservative value exceeds the optimistic value. Check the assumptions and inputs; values have not been swapped.")));
    if (r?.samples?.length) content.append(node("p", "vc-guide-error", t(`仍需核对示例值：${r.samples.join("、")}`, `Review sample values: ${r.samples.join(", ")}`)));
    const actions = node("div", "vc-guide-actions vc-guide-sticky");
    if (r?.canSave && !r.sample) actions.append(button(t("保存估值", "Save valuation"), () => hooks.save(), true));
    actions.append(button(t("去编辑页核对", "Review in editor"), () => hooks.finish(), !r?.canSave)); content.append(actions);
  }
  function render() {
    host.replaceChildren(); host.classList.add("vc-thesis-guide");
    if (state.guideMode === "choose") {
      host.append(node("h3", "vc-guide-title", t("这次想怎样估值？", "How would you like to value this company?")), node("p", "vc-guide-lead", t("先选情景数量。两种方式都会使用财报依据，由你确认业务判断和参数。", "Choose how many cases to build. Both use report evidence and your confirmed business assumptions and inputs.")));
      const list = node("div", "vc-guide-options");
      for (const [mode, title, description] of [["single", t("单场景估值", "Single-case valuation"), t("围绕你认为最合理的一套经营假设，得到一个每股合理价值。", "Build one plausible set of business assumptions for one fair value per share.")], ["sequential", t("保守／乐观情景估值", "Conservative / optimistic valuation"), t("先完整完成保守情景，再完整完成乐观情景，最后对照估值区间。", "Complete the conservative case, then the optimistic case, and compare the valuation range.")]]) {
        const card = node("section", "vc-flow-case"); card.append(node("h4", "", title), node("p", "", description), button(t("选择", "Choose") + title, () => {
          state.guideMode = mode; state.modeChosen = true; state.activeCase = "c"; state.cases = { c: null, o: null }; state.completed = { c: false, o: false }; state.basis = { c: "", o: "" };
          hooks.setScenarioMode?.(mode === "single" ? "single" : "range"); render(); onChange?.();
        }, true)); list.append(card);
      }
      host.append(list); return;
    }
    const steps = node("nav", "vc-guide-progress"); steps.setAttribute("aria-label", t("情景引导进度", "Case guide progress"));
    for (const key of (single() ? ["c", "compare"] : ["c", "o", "compare"])) {
      const b = button((key === "compare" ? (single() ? t("2 确认估值", "2 Confirm valuation") : t("3 对照估值", "3 Compare values")) : (key === "c" ? "1 " : "2 ") + name(key)) + (state.completed[key] ? " ✓" : ""), () => open(key));
      b.disabled = locked || (key === "o" && !state.completed.c) || (key === "compare" && !(state.completed.c && (single() || state.completed.o)));
      b.dataset.caseKey = key;
      if (key === state.activeCase) b.setAttribute("aria-current", "step"); steps.append(b);
    }
    host.append(steps);
    if (state.basisChanged && state.activeCase !== "compare") host.append(node("p", "vc-guide-error", t("估值方法、基础数据或已确认参数已变化。问答已保留，请重新确认参数后再对照。", "The method, base data or confirmed inputs changed. Your answers are kept; reconfirm inputs before comparing.")));
    const content = node("div", "vc-scenario-content"); host.append(content);
    if (state.activeCase === "compare") { compare(content); return; }
    const key = state.activeCase;
    const seed = state.cases[key] || { ...(single() ? { singleCase: true } : {}), caseKey: key, guideMode: "drivers", driverPlan: key === "o" ? state.cases.c?.driverPlan : null, stage: "story", turns: [], history: [] };
    seed.managementResearch = state.managementResearch; seed.businessReports = state.businessReports;
    // The optimistic case reuses the selected method; it never changes confirmed base data.
    const wrapped = { ...hooks,
      applyParams(params, scenario) { hooks.applyParams(params, scenario); state.basis[key] = basisKey(); state.completed[key] = false; },
      applyThesis(drafts) { hooks.applyThesis(drafts); state.completed[key] = false; },
      completeCase() {
        capture(); state.completed[key] = true; state.basis[key] = basisKey();
        if (key === "o") state.basisChanged = false;
        open(single() ? "compare" : key === "c" ? "o" : "compare");
      },
    };
    child = mountCaseFlow(content, { ...options, initial: seed, caseKey: key, singleCase: single(), driverPlan: seed.driverPlan, hooks: wrapped, onChange: notify });
    if (locked) child.setLocked(true);
  }
  if (state.guideMode !== "choose") hooks.setScenarioMode?.(single() ? "single" : "range");
  invalidateChangedBasis(); render();
  return {
    snapshot() { capture(); return JSON.parse(JSON.stringify(state)); },
    setBusinessReports(raw) { state.businessReports = cleanBusinessReports(raw); child?.setBusinessReports(raw); notify(); },
    setManagementResearch(raw) { state.managementResearch = recoverManagementResearch(state.managementResearch, raw); child?.setManagementResearch(state.managementResearch); notify(); },
    refresh() { capture(); const before = JSON.stringify(state.cases); invalidateChangedBasis(); if (JSON.stringify(state.cases) !== before) { child?.destroy(); child = null; render(); onChange?.(); } else child?.refresh(); },
    setLocked(value) { locked = !!value; child?.setLocked(value); updateNavigation(); },
    pause() { child?.pause(); }, destroy() { destroyed = true; child?.destroy(); }, isBusy: () => !!child?.isBusy(),
  };
}
