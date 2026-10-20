import { GUIDE_STEPS, guideQuestion, guideDraft, guideAnswer, cleanGuideState } from "./thesis-guide.js";
import { impactDirection, THESIS_IMPACTS } from "./thesis.js";
import { aiErrorText } from "../ai-panel.js";

const node = (tag, cls, text) => {
  const element = document.createElement(tag); if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text; return element;
};

export function mountThesisGuide(host, { lang, scenario, company, getContext, getThesis, onApply, onChange, initial }) {
  const zh = lang !== "en", caseName = zh ? scenario.zh : scenario.en;
  const empty = () => ({ turns: [], history: [], question: null, draft: null, selected: [], freeText: "", base: "", applied: false, references: [] });
  let state = cleanGuideState(initial) || empty(), busy = false, error = "", stale = false, active = null, destroyed = false;
  host.classList.add("vc-guide");
  const status = node("div", "vc-guide-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  function button(text, action, primary = false) {
    const element = node("button", primary ? "vc-guide-primary" : "vc-guide-secondary", text); element.type = "button";
    element.addEventListener("click", action); return element;
  }
  function notify() { onChange?.(); }
  function answer() { return state.question ? guideAnswer(state.question, state.selected, state.freeText, lang) : ""; }
  function back() {
    active?.abort(); active = null; busy = false; error = ""; stale = false;
    const last = state.turns.pop(), page = state.history.pop();
    if (!last) return;
    state.question = page?.question || null; state.selected = page?.selected || []; state.freeText = page?.freeText || (page ? "" : last.answer);
    state.draft = null; state.applied = false; notify(); render(true);
  }
  async function request() {
    if (busy || destroyed) return;
    busy = true; error = ""; stale = false;
    if (!state.base) state.base = JSON.stringify(getThesis());
    const controller = new AbortController(); active = controller;
    const timeout = setTimeout(() => controller.abort("timeout"), 45000);
    render();
    try {
      const context = await Promise.race([getContext(), new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
      if (controller.signal.aborted) return;
      const response = await fetch("/api/my/ai/thesis-guide", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang, scenario: scenario.key, turns: state.turns, thesis: { [scenario.key]: getThesis() }, context }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(aiErrorText(response.status, result, lang));
      const question = state.turns.length < 3 ? guideQuestion(result) : null;
      const draft = state.turns.length === 3 && result.type === "summary" ? guideDraft(result.draft) : null;
      if (!question && !draft) throw new Error(zh ? "AI 返回的内容不完整，请重试。" : "The AI response is incomplete. Please retry.");
      if (active !== controller || destroyed) return;
      state.question = question; state.draft = draft; state.selected = []; state.freeText = "";
      state.references = Array.isArray(result.references) ? result.references.filter((line) => typeof line === "string").slice(0, 24) : [];
      notify();
    } catch (e) {
      if (active !== controller || destroyed) return;
      error = controller.signal.aborted ? (controller.signal.reason === "timeout" ? (zh ? "这次等待较久，回答已保留。可以重试。" : "This took too long. Your answers are kept; retry when ready.") : (zh ? "已暂停，回答已保留。" : "Paused. Your answers are kept.")) : String(e.message || e);
    } finally {
      clearTimeout(timeout);
      if (active === controller && !destroyed) { active = null; busy = false; render(true); }
    }
  }
  function submit() {
    const value = answer(); if (busy || !value || value.length > 800) return;
    state.history.push({ question: state.question, selected: [...state.selected], freeText: state.freeText });
    state.turns.push({ question: state.question.question, answer: value });
    state.question = null; state.selected = []; state.freeText = ""; state.draft = null; notify(); request();
  }
  function render(focus = false) {
    host.replaceChildren();
    const heading = node("h3", "vc-guide-title", zh ? `一起梳理 ${company} 的${caseName}` : `Build ${company}'s ${caseName.toLowerCase()}`);
    heading.tabIndex = -1;
    host.append(heading);
    const progress = node("ol", "vc-guide-progress"); progress.setAttribute("aria-label", zh ? "AI 引导进度" : "AI guide progress");
    for (const [i, step] of GUIDE_STEPS.entries()) {
      const item = node("li", i < state.turns.length ? "done" : "", `${i + 1} ${zh ? step.zh : step.en}`);
      if (i === state.turns.length) item.setAttribute("aria-current", "step"); progress.append(item);
    }
    host.append(progress);
    const content = node("div", "vc-guide-content"); host.append(content);
    if (error) { const message = node("p", "vc-guide-error", error); message.setAttribute("role", "alert"); content.append(message); }
    if (busy) {
      status.textContent = zh ? (state.turns.length === 3 ? "正在整理你的观点…" : "正在结合公司资料准备问题…") : (state.turns.length === 3 ? "Organizing your answers…" : "Preparing a question from company information…");
      content.append(status, button(zh ? "暂停生成" : "Pause", () => active?.abort()));
    } else if (state.draft) {
      content.append(node("p", "vc-guide-lead", zh ? "这是根据你的回答整理的草稿。先检查，确认后只填入当前场景；数字由你后续决定。" : "Review this draft based on your answers. Confirm to fill this case only; numerical assumptions come later."));
      const draft = state.draft;
      const section = (title, lines) => { const card = node("section", "vc-guide-review"); card.append(node("h4", "", title)); for (const line of lines) card.append(node("p", "", line)); content.append(card); };
      section(zh ? "1. 公司未来会怎样" : "1. The business story", [draft.story]);
      section(zh ? "2. 依据与待验证" : "2. Evidence & uncertainties", [(zh ? "已有依据：" : "Evidence: ") + draft.evidence, (zh ? "待验证：" : "Unverified: ") + draft.uncertainties]);
      section(zh ? "3. 如何影响赚钱能力" : "3. Financial effects", draft.impacts?.length ? draft.impacts.map((impact) => {
        const meta = THESIS_IMPACTS.find((item) => item.key === impact.key);
        return `${zh ? meta.zh : meta.en} · ${impactDirection(impact.key, impact.direction, lang)}：${impact.reason}`;
      }) : [zh ? "影响方向还不确定，可以在填入后继续研究。" : "Financial effects are still uncertain. Research them after filling the draft."]);
      const watch = node("details", "vc-question-example"); watch.append(node("summary", "", zh ? "后续观察事项" : "What to watch"), node("p", "", draft.signals)); content.append(watch);
      const actions = node("div", "vc-guide-actions");
      const apply = button(state.applied ? (zh ? "已填入当前场景" : "Filled into this case") : (zh ? "确认并填入，继续编辑" : "Confirm and continue editing"), () => {
        if (state.applied) return;
        if (state.base !== JSON.stringify(getThesis())) {
          stale = true; error = zh ? "你已修改手动填写的内容。请按当前内容重新整理，避免覆盖新判断。" : "Your manual notes changed. Regenerate using the current notes before filling."; render(); return;
        }
        try { onApply(draft); state.applied = true; notify(); } catch (e) { error = String(e.message || e); render(); }
      }, true); apply.disabled = state.applied || stale;
      actions.append(apply);
      if (stale) actions.append(button(zh ? "按当前内容重新整理" : "Regenerate with current notes", () => { state.base = JSON.stringify(getThesis()); state.draft = null; state.applied = false; notify(); request(); }));
      content.append(actions);
    } else if (state.question) {
      const q = state.question;
      content.append(node("p", "vc-guide-context", q.context));
      const fieldset = node("fieldset", "vc-guide-options"); fieldset.append(node("legend", "", q.question));
      content.append(node("p", "vc-question-help", zh ? (q.selection === "multiple" ? "可以多选，也可以直接在下方写你的看法。" : "选一个更接近你的判断的回答，或直接在下方写。") : (q.selection === "multiple" ? "Choose any that apply, or write your own answer below." : "Choose the closest view, or write your own answer below.")));
      const choiceInputs = new Map();
      for (const option of [...q.options, { id: "unknown", label: zh ? "还不确定，先留待验证" : "Not sure yet; keep it unverified", detail: "" }]) {
        const label = node("label", "vc-guide-option"), input = node("input", ""); input.type = q.selection === "multiple" ? "checkbox" : "radio"; input.name = `guide-${scenario.key}`; input.value = option.id; input.checked = state.selected.includes(option.id);
        const words = node("span", ""); words.append(node("strong", "", option.label)); if (option.detail) words.append(node("small", "", option.detail));
        label.append(input, words); fieldset.append(label); choiceInputs.set(option.id, input);
        input.addEventListener("change", () => {
          state.selected = q.selection === "single" ? [option.id] : option.id === "unknown" ? (input.checked ? ["unknown"] : []) : [...choiceInputs].filter(([id, box]) => id !== "unknown" && box.checked).map(([id]) => id);
          for (const [id, box] of choiceInputs) box.checked = state.selected.includes(id);
          updateAnswer(); notify();
        });
      }
      content.append(fieldset);
      const label = node("label", "vc-thesis-field"); label.append(node("span", "", zh ? "你的看法或补充（也可以只打字）" : "Your view or additional detail (typing alone is fine)"));
      const free = node("textarea", "vc-note-input"); free.rows = 3; free.maxLength = 800; free.value = state.freeText;
      free.placeholder = zh ? "不必用专业术语，说说你的判断和不确定的地方。" : "Use your own words, including what you are unsure about.";
      free.setAttribute("aria-label", `${caseName} · ${zh ? "引导回答" : "Guide answer"}`); label.append(free); content.append(label);
      const count = node("p", "vc-question-help"), actions = node("div", "vc-guide-actions");
      const next = button(zh ? (state.turns.length === 2 ? "整理我的回答" : "继续") : (state.turns.length === 2 ? "Review my answers" : "Continue"), submit, true);
      function updateAnswer() { state.freeText = free.value; const length = answer().length; count.textContent = `${length}/800` + (length > 800 ? (zh ? " · 回答过长，请精简选项或文字。" : " · Please shorten your answer.") : ""); next.disabled = !length || length > 800; }
      free.addEventListener("input", () => { updateAnswer(); notify(); });
      free.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } });
      updateAnswer(); actions.append(next); content.append(count, actions);
    } else {
      content.append(node("p", "vc-guide-lead", zh ? "不用先写一篇分析。AI 会结合公司资料问你三个问题，你可以选答案，也可以打字；最后一起检查草稿。" : "No analysis essay needed. AI asks three company-specific questions. Choose answers or type, then review the draft."));
      content.append(button(zh ? (error ? "重试，继续引导" : state.turns.length ? "继续引导" : "开始 AI 引导") : (error ? "Retry" : state.turns.length ? "Resume guide" : "Start AI guide"), request, true));
    }
    if (state.turns.length) {
      const history = node("details", "vc-guide-history"); history.append(node("summary", "", zh ? `已回答 ${state.turns.length} 个问题 · 查看记录` : `${state.turns.length} answers · Review history`));
      for (const turn of state.turns) { history.append(node("p", "vc-guide-history-q", turn.question), node("p", "", turn.answer)); }
      host.append(history, button(zh ? "返回修改上一轮" : "Edit previous answer", back));
    }
    if (state.references.length) {
      const references = node("details", "vc-guide-history"); references.append(node("summary", "", zh ? "本轮参考的公司资料" : "Company information used"));
      for (const line of state.references) references.append(node("p", "", line)); host.append(references);
    }
    if (focus) heading.focus({ preventScroll: true });
  }
  render();
  return {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    restore(value) { state = cleanGuideState(value) || empty(); render(); },
    pause() { active?.abort(); },
    destroy() { destroyed = true; active?.abort(); },
    isBusy: () => busy,
  };
}
