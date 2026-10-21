import { FLOW_STEPS, guideQuestion, guideDrafts, guideAnswer, validGuideTurns } from "./thesis-guide.js";
import { impactDirection, THESIS_IMPACTS, fieldStoryHint } from "./thesis.js";
import { aiErrorText } from "../ai-panel.js";

const node = (tag, cls, text) => {
  const element = document.createElement(tag); if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text; return element;
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

// 整条「从故事到数字」的 AI 流程：五轮问答 → 两个场景的草稿 → 选方法 → 逐项确认参数 → 看结果。
// 每一步只显示当前这一屏；完成后交给编辑器的可修改面板。模型输出都按受约束的数据处理，数字只在用户确认后写入。
export const FLOW_STAGES = [
  { key: "story", zh: "讲故事", en: "Story" },
  { key: "method", zh: "选方法", en: "Method" },
  { key: "params", zh: "填参数", en: "Inputs" },
  { key: "result", zh: "看估值", en: "Value" },
];
const STAGE_KEYS = ["story", "review", "method", "params", "result"];

// 浏览器里恢复的状态同样不可信：不合法就丢弃，从头开始
export function cleanFlowState(raw) {
  if (!object(raw) || !STAGE_KEYS.includes(raw.stage) || !validGuideTurns(raw.turns, FLOW_STEPS.length)) return null;
  const question = raw.question ? guideQuestion(raw.question) : null;
  const drafts = raw.drafts ? guideDrafts(raw.drafts) : null;
  if ((raw.question && !question) || (raw.drafts && !drafts)) return null;
  const history = Array.isArray(raw.history) ? raw.history.slice(0, FLOW_STEPS.length).map((page) => {
    const q = object(page) && guideQuestion(page.question);
    return q ? { question: q, selected: Array.isArray(page.selected) ? page.selected.filter((id) => typeof id === "string").slice(0, 8) : [],
      freeText: typeof page.freeText === "string" ? page.freeText.slice(0, 800) : "", otherText: typeof page.otherText === "string" ? page.otherText.slice(0, 400) : "" } : null;
  }) : [];
  if (history.some((page) => !page)) return null;
  const turns = raw.turns.slice(0, history.length); // 每一轮都要能「上一步」回到原问题；对不上的部分丢弃
  const selected = Array.isArray(raw.selected) && question ? [...new Set(raw.selected.filter((id) => id === "unknown" || id === "other" || question.options.some((option) => option.id === id)))] : [];
  const picks = object(raw.picks) && Array.isArray(raw.picks.picks) ? { summary: typeof raw.picks.summary === "string" ? raw.picks.summary.slice(0, 600) : "",
    picks: raw.picks.picks.filter((p) => object(p) && typeof p.key === "string").slice(0, 3).map((p) => ({ key: p.key.slice(0, 40), reason: typeof p.reason === "string" ? p.reason.slice(0, 300) : "" })) } : null;
  let rows = null;
  if (Array.isArray(raw.rows)) {
    rows = raw.rows.filter((row) => object(row) && typeof row.k === "string").slice(0, 40).map((row) => ({ k: row.k.slice(0, 60), use: row.use !== false, single: row.single === true,
      c: finite(row.c) ? row.c : null, o: finite(row.o) ? row.o : null, v: finite(row.v) ? row.v : null, reason: typeof row.reason === "string" ? row.reason.slice(0, 300) : "", ai: row.ai === true }));
  }
  return { stage: turns.length === raw.turns.length ? raw.stage : "story", turns: turns.map(({ question: q, answer }) => ({ question: q, answer })), history, question: turns.length === raw.turns.length ? question : null, drafts: turns.length === raw.turns.length ? drafts : null,
    selected: selected.includes("unknown") ? ["unknown"] : question?.selection === "single" ? selected.slice(0, 1) : selected,
    freeText: typeof raw.freeText === "string" ? raw.freeText.slice(0, 800) : "", otherText: typeof raw.otherText === "string" ? raw.otherText.slice(0, 400) : "",
    references: Array.isArray(raw.references) ? raw.references.filter((line) => typeof line === "string").slice(0, 24).map((line) => line.slice(0, 1600)) : [],
    picks, method: typeof raw.method === "string" ? raw.method.slice(0, 40) : "", rows, paramsFor: typeof raw.paramsFor === "string" ? raw.paramsFor.slice(0, 40) : "" };
}

export function mountValuationFlow(host, { lang, company, initial, hooks, onChange, visible = () => true }) {
  const zh = lang !== "en", t = (a, b) => (zh ? a : b);
  const empty = () => ({ stage: "story", turns: [], history: [], question: null, drafts: null, selected: [], freeText: "", otherText: "",
    references: [], picks: null, method: "", rows: null, paramsFor: "" });
  let state = cleanFlowState(initial) || empty(), busy = "", error = "", stopped = false, active = null, destroyed = false;
  const replies = new Map(); // 本次打开期间：同样的已答内容 → 上次 AI 的回复（返回再前进、答案没改时不重复调用）
  host.classList.add("vc-guide", "vc-guide-card");
  // 窄屏下吸底按钮会盖住正在输入的框：聚焦时把它滚到可视区中间
  host.addEventListener("focusin", (e) => {
    if (!e.target.matches?.("input[type=text], input[type=number], textarea") || innerWidth > 760) return;
    setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "auto" }), 250);
  });
  const status = node("div", "vc-guide-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const notify = () => onChange?.();
  function button(text, action, primary = false) {
    const element = node("button", primary ? "vc-guide-primary" : "vc-guide-secondary", text); element.type = "button";
    element.addEventListener("click", action); return element;
  }

  // ── 异步任务：同一时间只有一个；可暂停；超时 / 失败保留已答内容 ──
  async function run(label, task) {
    if (busy || destroyed) return;
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

  // ── 第 1 段：五轮问答 → 两份草稿 ──
  function askNext() {
    return run(state.turns.length === FLOW_STEPS.length ? "draft" : "question", async (signal) => {
      const cacheKey = JSON.stringify(state.turns);
      let result = replies.get(cacheKey);
      if (!result) {
        const context = await raceAbort(hooks.getContext(), signal);
        const response = await fetch("/api/my/ai/thesis-guide", { method: "POST", signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ lang, scenario: "both", turns: state.turns, thesis: hooks.getThesis(), context }) });
        result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(aiErrorText(response.status, result, lang));
      }
      const done = state.turns.length === FLOW_STEPS.length;
      const question = done ? null : guideQuestion(result);
      const drafts = done && result.type === "summary" ? guideDrafts(result.drafts) : null;
      if (!question && !drafts) throw new Error(t("AI 返回的内容不完整，请重试。", "The AI response is incomplete. Please retry."));
      replies.set(cacheKey, result);
      if (signal.aborted) throw new Error("aborted");
      state.references = Array.isArray(result.references) ? result.references.filter((line) => typeof line === "string").slice(0, 24) : [];
      if (question) { state.question = question; state.selected = []; state.freeText = ""; state.otherText = ""; }
      else { state.drafts = drafts; state.question = null; state.stage = "review"; state.picks = null; state.rows = null; state.paramsFor = ""; state.method = ""; } // 故事变了：方法推荐和参数建议都要按新故事重来
    });
  }
  function answerText() { return state.question ? guideAnswer(state.question, state.selected, state.freeText, lang, state.otherText) : ""; }
  function submitAnswer() {
    const value = answerText(); if (busy || !value || value.length > 800) return;
    state.history.push({ question: state.question, selected: [...state.selected], freeText: state.freeText, otherText: state.otherText });
    state.turns.push({ question: state.question.question, answer: value });
    state.question = null; state.selected = []; state.freeText = ""; state.otherText = ""; notify(); askNext();
  }
  function backQuestion() {
    const last = state.turns.pop(), page = state.history.pop();
    if (!last) return;
    state.question = page?.question || null; state.selected = page?.selected || []; state.freeText = page?.freeText || (page ? "" : last.answer); state.otherText = page?.otherText || "";
    state.drafts = null; state.stage = "story";
  }

  // ── 第 2 段：选方法（AI 按故事推荐，用户确认）──
  function loadPicks() {
    return run("picks", async (signal) => {
      const picks = await raceAbort(hooks.recommendMethods(), signal);
      const known = new Set(hooks.methods().map((m) => m.key));
      state.picks = { summary: String(picks?.summary || picks?.reply || "").slice(0, 600), picks: (picks?.picks || []).filter((p) => known.has(p.key)).map((p) => ({ key: p.key, reason: p.reason || "" })) };
      if (!state.method) state.method = state.picks.picks[0]?.key || hooks.currentMethod() || "";
    });
  }

  // ── 第 3 段：参数（AI 给每项一对建议值，用户逐项确认 / 修改 / 跳过）──
  function loadParams() {
    return run("params", async (signal) => {
      const suggestion = await raceAbort(hooks.suggestParams(), signal);
      const params = suggestion?.params || {}, reasons = suggestion?.reasons || {};
      // 两档参数逐项确认；单值参数只在缺数据或 AI 给了建议时出现（缺数据的必须补上，否则算不出结果）
      state.rows = hooks.fields().flatMap((f) => {
        const p = params[f.k];
        if (f.col === "dual") {
          const ai = object(p) && finite(p.c) && finite(p.o);
          return [{ k: f.k, use: ai, c: ai ? p.c : (finite(f.value?.c) ? f.value.c : null), o: ai ? p.o : (finite(f.value?.o) ? f.value.o : null), reason: reasons[f.k] || "", ai }];
        }
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
      else if (finite(row.c) && finite(row.o)) params[row.k] = { c: row.c, o: row.o };
    }
    if (Object.keys(params).length) hooks.applyParams(params);
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
      if (i === 0 && state.stage === "story") label += zh ? ` · 第 ${Math.min(state.turns.length + 1, FLOW_STEPS.length)}/${FLOW_STEPS.length} 题` : ` · ${Math.min(state.turns.length + 1, FLOW_STEPS.length)}/${FLOW_STEPS.length}`;
      const item = node("li", i < at ? "done" : "", label); if (i === at) item.setAttribute("aria-current", "step");
      if (i < at) item.setAttribute("aria-label", `${zh ? stage.zh : stage.en} · ${t("已完成", "done")}`); list.append(item);
    });
    return list;
  }
  function loader(content, shape) {
    const box = node("div", "vc-guide-loader"), head = node("div", "vc-guide-loader-head"), icon = node("i", "ri-sparkling-2-fill");
    icon.setAttribute("aria-hidden", "true");
    status.textContent = ({ question: t("正在结合公司资料准备问题…", "Preparing a question from company information…"), draft: t("正在把你的回答整理成两个场景…", "Turning your answers into two cases…"),
      picks: t("正在按你的故事挑选估值方法…", "Choosing methods that fit your story…"), params: t("正在按故事和财报给出参数建议…", "Suggesting inputs from your story and the financials…") })[busy] || "";
    head.append(icon, status, button(t("停止", "Stop"), () => active?.abort())); box.append(head);
    const skeleton = node("div", "vc-guide-skeleton"); skeleton.setAttribute("aria-hidden", "true");
    for (const cls of shape) skeleton.append(node("span", cls));
    box.append(skeleton); content.append(box);
  }
  // AI 这一步失败时：错误说明 + 就近的重试按钮，放在这一步最上面（不要让人去长列表底部找）
  function retryBox(content, message, label, retry) {
    const box = node("div", "vc-flow-retry"); box.setAttribute("role", "alert");
    const words = node("div", ""); words.append(node("strong", "", message), node("p", "", error));
    const again = button(label, retry, true); box.append(words, again); content.append(box);
  }
  function actions(...items) { const bar = node("div", "vc-guide-actions vc-guide-sticky"); bar.append(...items.filter(Boolean)); return bar; }

  function renderQuestion(content) {
    const q = state.question;
    const fieldset = node("fieldset", "vc-guide-options"), legend = node("legend", "", q.question);
    if (q.selection === "multiple") legend.append(node("span", "vc-guide-tag", t("可多选", "Select all that apply")));
    fieldset.append(legend, node("p", "vc-guide-context", q.context));
    const inputs = new Map(); let otherInput = null;
    for (const option of [...q.options, { id: "other", label: t("其他，我自己写", "Something else (write your own)"), detail: "" }, { id: "unknown", label: t("还不确定，先待验证", "Not sure yet; mark as to verify"), detail: "" }]) {
      const label = node("label", "vc-guide-option"), input = node("input", "");
      input.type = q.selection === "multiple" ? "checkbox" : "radio"; input.name = "flow-guide"; input.value = option.id; input.checked = state.selected.includes(option.id);
      const words = node("span", ""); words.append(node("strong", "", option.label)); if (option.detail) words.append(node("small", "", option.detail));
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
    const last = state.turns.length === FLOW_STEPS.length - 1;
    const next = button(last ? t("下一步：整理成两个场景", "Next: draft both cases") : t("下一题", "Next question"), submitAnswer, true);
    function update() { state.freeText = free.value; const n = answerText().length; count.textContent = `${n}/800` + (n > 800 ? t(" · 回答过长，请精简。", " · Please shorten your answer.") : ""); count.hidden = n < 600; next.disabled = !n || n > 800; }
    free.addEventListener("input", () => { update(); notify(); });
    free.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitAnswer(); } });
    update();
    content.append(addNote, noteLabel, count, actions(next, state.turns.length ? button(t("上一步", "Back"), () => { backQuestion(); notify(); render(true); }) : null));
  }

  function renderReview(content) {
    const { conflict, c, o } = state.drafts;
    content.append(node("p", "vc-guide-lead", t("AI 根据你的回答写了两个场景。看看是否符合你的想法，之后随时能改。", "AI wrote both cases from your answers. Check they match your view; you can edit them anytime.")));
    if (conflict) {
      const warn = node("div", "vc-guide-conflict"); warn.setAttribute("role", "note");
      warn.append(node("strong", "", t("回答和场景方向可能不一致", "Your answers may not fit the case direction")), node("p", "", conflict),
        node("p", "", t("可以返回修改回答，或确认后在编辑时再调整。", "Go back and adjust, or confirm and edit later.")));
      content.append(warn);
    }
    const grid = node("div", "vc-flow-cases");
    for (const [key, draft] of [["c", c], ["o", o]]) {
      const card = node("section", "vc-flow-case " + key);
      const caseName = key === "c" ? t("保守场景", "Conservative case") : t("乐观场景", "Optimistic case");
      // 故事可以直接在这里改一句，不用退回去重新回答
      const story = node("textarea", "vc-flow-story"); story.value = draft.story; story.maxLength = 800; story.rows = 3;
      story.setAttribute("aria-label", `${caseName} · ${t("故事", "Story")}`);
      story.addEventListener("input", () => { draft.story = story.value; notify(); next.disabled = !c.story.trim() || !o.story.trim(); });
      card.append(node("h4", "", caseName), story);
      const dl = node("dl", "");
      const row = (label, value) => { if (!value) return; dl.append(node("dt", "", label), node("dd", "", value)); };
      row(t("依据", "Evidence"), draft.evidence); row(t("待验证", "To verify"), draft.uncertainties);
      card.append(dl);
      if (draft.impacts?.length) {
        const list = node("ul", "vc-flow-impacts");
        for (const impact of draft.impacts) {
          const meta = THESIS_IMPACTS.find((item) => item.key === impact.key);
          const li = node("li", ""); li.append(node("strong", "", `${zh ? meta.zh : meta.en} ${impactDirection(impact.key, impact.direction, lang)}`));
          if (impact.reason) li.append(node("span", "", impact.reason)); list.append(li);
        }
        card.append(node("p", "vc-flow-impacts-label", t("会影响", "Affects")), list);
      }
      grid.append(card);
    }
    const next = button(t("下一步：选方法", "Next: choose a method"), () => { hooks.applyThesis({ c, o }); go("method"); }, true);
    content.append(node("p", "vc-question-help", t("故事可以直接在框里改；依据和影响进入编辑页后也都能改。", "Edit the story right here; evidence and effects stay editable in the editor.")), grid, actions(
      next,
      button(t("上一步", "Back"), () => { backQuestion(); notify(); render(true); })));
  }

  function renderMethod(content) {
    const methods = hooks.methods(), byKey = new Map(methods.map((m) => [m.key, m]));
    if (state.method && !byKey.has(state.method)) state.method = "";
    const fieldset = node("fieldset", "vc-guide-options"), legend = node("legend", "", t("用哪种方法把故事变成数字？", "Which method turns this story into numbers?"));
    if (error) retryBox(content, t("AI 推荐方法暂时失败。可以重试，也可以直接从下面选一个方法。", "Method recommendation failed. Retry, or pick a method below."), t("重试 AI 推荐", "Retry"), () => { state.picks = null; loadPicks(); });
    fieldset.append(legend, node("p", "vc-guide-context", state.picks?.summary || t("从下面选一个方法；不确定时可以先选 P/E 市盈率。", "Pick a method below; P/E is a reasonable default if unsure.")),
      node("p", "vc-question-help", t("先用一个方法完成估值；想对照的话，之后可以再加一张用备选方法的估值卡。", "Finish with one method first; you can add another card with an alternative method later to compare.")));
    const choice = (method, reason, tag) => {
      const label = node("label", "vc-guide-option"), input = node("input", ""); input.type = "radio"; input.name = "flow-method"; input.value = method.key; input.checked = state.method === method.key;
      const words = node("span", ""), title = node("strong", "", method.title); if (tag) title.append(node("span", "vc-guide-tag", tag));
      // 方法名对新手不直观：方法本身的一句话说明始终显示，AI 的理由另起一行
      words.append(title); if (method.subtitle) words.append(node("small", "", method.subtitle)); if (reason) words.append(node("small", "vc-flow-reason", t("为什么推荐：", "Why: ") + reason));
      label.append(input, words);
      input.addEventListener("change", () => { state.method = method.key; next.disabled = false; notify(); });
      return label;
    };
    const picked = (state.picks?.picks || []).filter((p) => byKey.has(p.key));
    picked.forEach((p, i) => fieldset.append(choice(byKey.get(p.key), p.reason, i ? t("备选", "Alternative") : t("推荐", "Recommended"))));
    const others = methods.filter((m) => !picked.some((p) => p.key === m.key));
    const more = node("details", "vc-flow-more"); more.append(node("summary", "", t(`其他方法（${others.length}）`, `Other methods (${others.length})`)));
    const moreList = node("div", "vc-guide-options vc-flow-more-list"); for (const m of others) moreList.append(choice(m, "", ""));
    more.append(moreList); more.open = !picked.length || others.some((m) => m.key === state.method);
    content.append(fieldset, more);
    const next = button(t("下一步：填参数", "Next: enter inputs"), () => { hooks.selectMethod(state.method); go("params"); }, true);
    next.disabled = !state.method;
    content.append(actions(next, button(t("上一步", "Back"), () => go("review"))));
  }

  function renderParams(content) {
    const fields = new Map(hooks.fields().map((f) => [f.k, f]));
    const thesis = hooks.getThesis(), checks = hooks.checkParams(Object.fromEntries((state.rows || []).filter((r) => !r.single && finite(r.c) && finite(r.o)).map((r) => [r.k, { c: r.c, o: r.o }])));
    const head = node("div", "vc-guide-options"); head.append(node("legend", "", t("保守和乐观场景，各取多少？", "How much in each case?")),
      node("p", "vc-guide-context", t("AI 按你的故事和财报给了建议值，可以直接改。不想用某一项就取消「采用」，表单里会保留现有的数（可能是示例值）。", "AI suggested values from your story and the financials; edit freely. Untick “Use” to keep the existing value instead (it may be a sample).")));
    content.append(head);
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
      const values = node("div", "vc-flow-param-values" + (row.single ? " single" : ""));
      const box = (key, caption) => {
        const wrap = node("label", ""), input = node("input", "vc-input"); input.type = "number"; input.step = "any"; input.value = finite(row[key]) ? String(row[key]) : "";
        input.setAttribute("aria-label", `${field.label} · ${caption}`);
        input.addEventListener("input", () => { const n = Number(input.value); row[key] = input.value !== "" && Number.isFinite(n) ? n : null; if (!row.use) { row.use = true; use.checked = true; card.classList.add("on"); keep.hidden = true; } notify(); update(); });
        wrap.append(node("span", "", caption), input); return wrap;
      };
      if (row.single) values.append(box("v", t("数值（两个场景共用）", "Value (both cases)")));
      else values.append(box("c", t("保守", "Conservative")), box("o", t("乐观", "Optimistic")));
      card.append(top, values);
      if (row.reason) card.append(node("p", "vc-flow-param-reason", row.reason));
      // 历史参考：点一下填入（和编辑页的参考一致）；区间按 保守=最低、乐观=最高
      if (field.refs?.chips?.length) {
        const fmtRef = (v) => field.refs.unit === "%" ? `${v}%` : `${v}x`;
        const refs = node("div", "vc-flow-refs"); refs.append(node("span", "", t("历史参考：", "History: ")));
        const set = (cv, ov) => { if (row.single) row.v = cv; else { row.c = cv; row.o = ov; } row.use = true; notify(); render(); };
        const vals = field.refs.chips.map((c) => c.value), lo = Math.min(...vals), hi = Math.max(...vals);
        if (!row.single && hi > lo) { const b = node("button", "vc-refchip vc-refrange", `${t("填入区间", "Use range")} ${fmtRef(lo)}–${fmtRef(hi)}`); b.type = "button"; b.addEventListener("click", () => set(lo, hi)); refs.append(b); }
        for (const chip of field.refs.chips.slice(0, 3)) { const b = node("button", "vc-refchip", `${chip.label} ${fmtRef(chip.value)}`); b.type = "button"; b.addEventListener("click", () => set(chip.value, chip.value)); refs.append(b); }
        card.append(refs);
      }
      const keep = node("p", "vc-flow-keep"); // 不采用时说清楚会用什么数
      const current = row.single ? (finite(field.value) ? String(field.value) : "") : (finite(field.value?.c) ? `${field.value.c} / ${field.value.o}` : "");
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
      next.disabled = (state.rows || []).some((r) => r.use && (r.single ? !finite(r.v) : !(finite(r.c) && finite(r.o))));
      why.textContent = next.disabled ? t("勾选「采用」的参数需要填完整（两个场景都要填）。", "Fill in every input marked “Use” (both cases).") : ""; why.hidden = !next.disabled;
    }
    update();
    content.append(why, actions(next, button(t("上一步", "Back"), () => go("method")), button(t("重新建议", "Suggest again"), () => { state.rows = null; loadParams(); })));
  }

  function renderResult(content) {
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

  // 开始页：先让人知道接下来要做什么、要多久、谁说了算，再给一个明确的开始按钮
  const INTRO = [
    ["chat-smile-2-line", t("回答 5 个问题", "Answer 5 questions"), t("AI 结合公司资料提问，选一个答案或自己写", "AI asks about the company; pick an answer or write your own")],
    ["compass-3-line", t("选估值方法", "Choose a method"), t("按你的故事推荐合适的方法", "Methods that fit your story")],
    ["equalizer-line", t("确认关键数字", "Confirm key numbers"), t("AI 给出保守和乐观两组建议值，可以改", "Suggested conservative and optimistic values you can edit")],
    ["line-chart-line", t("看估值结果", "See the result"), t("合理价值区间和现价对比", "Fair value range vs. the current price")],
  ];
  function renderIntro(content) {
    host.classList.add("intro");
    const list = node("ol", "vc-flow-intro");
    for (const [icon, title, detail] of INTRO) {
      const item = node("li", ""), mark = node("i", "ri-" + icon); mark.setAttribute("aria-hidden", "true");
      const words = node("span", ""); words.append(node("strong", "", title), node("small", "", detail));
      item.append(mark, words); list.append(item);
    }
    const start = button(t("开始", "Start"), askNext, true); start.classList.add("vc-flow-start");
    const manual = node("button", "vc-guide-link", t("我想自己填写", "I'd rather fill it in myself")); manual.type = "button";
    manual.addEventListener("click", () => hooks.exit());
    const go = node("div", "vc-flow-intro-go"); go.append(start, manual);
    content.append(list, node("p", "vc-flow-intro-note", t("大约 5 分钟。每一步都由你确认，随时可以返回修改。", "About 5 minutes. You confirm every step and can go back anytime.")), go);
  }
  function render(focus = false) {
    host.replaceChildren(); host.classList.remove("intro");
    const intro = !busy && !error && state.stage === "story" && !state.question && !state.turns.length;
    const heading = node("h3", "vc-guide-title", intro ? t(`和 AI 一起完成 ${company} 的估值`, `Value ${company} with AI`) : t(`${company} 估值`, `Valuing ${company}`)); heading.tabIndex = -1;
    const top = node("div", "vc-flow-top"); top.append(heading);
    if (!intro) { const leave = button(t("退出引导", "Leave guide"), () => { active?.abort(); hooks.exit(); }); leave.title = t("已回答的内容会保留，之后可以从「AI 引导」回来继续。", "Your answers are kept; resume from “AI guide” later."); top.append(leave); }
    host.append(top);
    if (intro) host.append(node("p", "vc-flow-intro-lead", t("不用先懂估值。回答几个关于这家公司的问题，AI 帮你把判断整理成一份估值。", "No valuation background needed. Answer a few questions about the company and AI turns your views into a valuation.")));
    else host.append(progress());
    const content = node("div", "vc-guide-content"); host.append(content);
    // 方法 / 参数两步自己在原地显示错误和重试；其他步骤在顶部显示
    if (error && !["method", "params"].includes(state.stage)) { const message = node("p", "vc-guide-error", error); message.setAttribute("role", "alert"); content.append(message); }
    if (busy) loader(content, busy === "draft" ? ["line", "line short", "card", "card"] : busy === "params" ? ["line", "line short", "card", "card", "card"] : ["line", "line short", "opt", "opt", "opt"]);
    else if (state.stage === "review" && state.drafts) renderReview(content);
    // 恢复到这两步但还没有数据时，渲染完再去取（不能在渲染中途触发新的渲染）
    // 卡片隐藏时（「自己填写」模式下恢复草稿）不自动调用 AI，等用户回到引导再取
    else if (state.stage === "method") { if (state.picks || error) renderMethod(content); else if (visible()) queueMicrotask(loadPicks); }
    else if (state.stage === "params") {
      if (freshRows()) renderParams(content);
      else if (error) { retryBox(content, t("AI 参数建议暂时失败。可以重试，或返回换一个方法。", "Input suggestions failed. Retry, or go back and change the method."), t("重试 AI 建议", "Retry"), loadParams); content.append(actions(button(t("上一步", "Back"), () => go("method")))); }
      else if (visible()) queueMicrotask(loadParams);
    }
    else if (state.stage === "result") renderResult(content);
    else if (state.question) renderQuestion(content);
    else if (state.turns.length || error) content.append(actions(button(t("继续", "Continue"), askNext, true),
      state.turns.length ? button(t("上一步", "Back"), () => { error = ""; backQuestion(); notify(); render(true); }) : null));
    else renderIntro(content);
    if (state.turns.length && ["story", "review"].includes(state.stage)) {
      const history = node("details", "vc-guide-history"); history.append(node("summary", "", t(`已回答 ${state.turns.length} 个问题 · 查看记录`, `${state.turns.length} answers · Review history`)));
      for (const turn of state.turns) history.append(node("p", "vc-guide-history-q", turn.question), node("p", "", turn.answer));
      host.append(history);
    }
    if (state.references.length && ["story", "review"].includes(state.stage)) {
      const references = node("details", "vc-guide-history"); references.append(node("summary", "", t("参考的公司资料", "Company information used")));
      for (const line of state.references) references.append(node("p", "", line)); host.append(references);
    }
    if (focus) {
      heading.focus({ preventScroll: true });
      if (host.getBoundingClientRect().top < 0) host.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }
  render();
  return {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    refresh: () => { if (busy) return; if (stopped) { error = ""; stopped = false; } render(); },
    pause() { active?.abort(); },
    destroy() { destroyed = true; active?.abort(); },
    isBusy: () => !!busy,
  };
}
