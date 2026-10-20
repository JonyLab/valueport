import { cleanThesis, THESIS_LIMIT, THESIS_IMPACTS, IMPACT_DIRECTIONS, suggestedImpacts, impactDirection, impactParameterHint } from "./thesis.js";

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
}

// Questions remain usable without AI. Suggestions name topics, never assume facts.
export function mountThesisQuestions(panel, followup, { lang, scenario, initial }) {
  const zh = lang !== "en", caseName = zh ? scenario.zh : scenario.en;
  const inputs = {}, rows = new Map();
  let currentFields = [], currentMethod = null;
  const changed = () => panel.dispatchEvent(new Event("input", { bubbles: true }));
  const help = (text) => node("p", "vc-question-help", text);
  function textField(parent, key, title, placeholder, explanation) {
    const label = node("label", "vc-thesis-field");
    label.append(node("span", "vc-question-label", title));
    if (explanation) label.append(help(explanation));
    const input = node("textarea", "vc-note-input"); input.rows = 2; input.maxLength = THESIS_LIMIT;
    input.placeholder = placeholder; input.setAttribute("aria-label", `${caseName} · ${title}`);
    inputs[key] = input; label.append(input); parent.append(label); return input;
  }
  const storySection = node("section", "vc-question");
  const story = textField(storySection, "story", zh ? "1. 在这个场景下，你认为公司未来会怎样？" : "1. What happens to the business in this case?",
    zh ? "例如：竞争加剧，老客户还在，但新客户增长会变慢。" : "For example: competition increases; existing customers stay, but new customer growth slows.",
    zh ? "先写一句话就可以。想想产品、客户和竞争会发生什么变化，不用先懂估值术语。" : "One sentence is enough. Think about products, customers and competition; no valuation jargon needed.");
  const example = node("details", "vc-question-example");
  example.append(node("summary", "", zh ? "不知道怎么写？看个例子" : "Need an example?"), help(zh
    ? (scenario.key === "c" ? "假设性例子：新产品推广比预期慢，公司主要靠老客户维持收入。你可以接着想：客户为什么愿意留下？竞争对手会不会降价？" : "假设性例子：新产品得到客户认可，海外渠道逐渐成熟。你可以接着想：谁会购买？为什么选它？公司能否持续交付？")
    : (scenario.key === "c" ? "Hypothetical: new products gain traction slowly, and existing customers sustain revenue. Why would they stay? Could competitors cut prices?" : "Hypothetical: customers adopt new products and overseas channels mature. Who buys, why do they choose this company, and can it deliver?")));
  storySection.append(example); panel.append(storySection);

  const evidenceSection = node("section", "vc-question");
  evidenceSection.append(node("h3", "vc-question-label", zh ? "2. 什么支持这个判断？还有什么没证实？" : "2. What supports your view, and what is unverified?"), help(zh ? "把事实和预期分开。也可以记下反面证据；暂时没有资料，可以先留待验证。" : "Separate facts from expectations. Include contrary evidence; missing information can remain unverified."));
  const evidence = textField(evidenceSection, "evidence", zh ? "已有依据" : "Supporting evidence", zh ? "例如：年报显示海外收入连续增长。写下来源或链接，方便以后核实。" : "For example: annual reports show overseas revenue growth. Note a source or link to check later.");
  const noEvidence = node("button", "vc-question-action", zh ? "暂时没有依据" : "No evidence yet"); noEvidence.type = "button";
  noEvidence.addEventListener("click", () => {
    const text = zh ? "暂时没有依据，以上判断待验证。" : "No evidence yet; this view remains unverified.";
    if (!evidence.value.trim()) evidence.value = text;
    noEvidence.hidden = true; evidence.focus(); changed();
  });
  evidence.addEventListener("input", () => { noEvidence.hidden = !!evidence.value.trim(); });
  evidenceSection.append(noEvidence);
  textField(evidenceSection, "uncertainties", zh ? "还没证实 / 反面证据" : "Unverified / contrary evidence", zh ? "例如：还不知道新品是否有持续订单；竞争对手正在降价。" : "For example: repeat orders are unconfirmed; competitors are cutting prices.");
  panel.append(evidenceSection);

  const impactSection = node("section", "vc-question");
  impactSection.append(node("h3", "vc-question-label", zh ? "3. 这些变化，会怎样影响公司的赚钱能力？" : "3. How do these changes affect the business financially?"), help(zh ? "选出受影响的项目，再判断方向和原因。这里不用填数字，量化时再确认参数。" : "Choose affected topics, then a direction and reason. Confirm numerical inputs later."));
  const suggestions = node("div", "vc-impact-suggestions");
  const all = node("details", "vc-question-example");
  all.append(node("summary", "", zh ? "自己选择影响项" : "Choose topics yourself"));
  const choices = node("div", "vc-impact-choices"); all.append(choices);
  const list = node("div", "vc-impact-list");
  const next = help(zh ? "确认影响后，再往下选择估值方法，把判断变成数字。" : "After reviewing these effects, choose a valuation method below to quantify them.");
  impactSection.append(suggestions, all, list, next); panel.append(impactSection);
  const choiceButtons = new Map();
  function addImpact(key, value = {}) {
    if (rows.has(key)) return;
    const item = THESIS_IMPACTS.find((entry) => entry.key === key); if (!item) return;
    const title = zh ? item.zh : item.en;
    const row = node("section", "vc-impact-row"), head = node("div", "vc-impact-head");
    const remove = node("button", "vc-question-action", zh ? "移除" : "Remove"); remove.type = "button"; remove.setAttribute("aria-label", `${caseName} · ${zh ? "移除" : "Remove"} ${title}`);
    head.append(node("strong", "", title), remove); row.append(head);
    const label = node("label", "vc-impact-direction"); label.append(node("span", "", zh ? "你预计的方向" : "Expected direction"));
    const direction = node("select", ""); direction.setAttribute("aria-label", `${caseName} · ${title} · ${zh ? "方向" : "Direction"}`);
    for (const dir of ["unknown", ...IMPACT_DIRECTIONS.filter((entry) => entry !== "unknown")]) {
      const option = node("option", "", impactDirection(key, dir, lang)); option.value = dir; direction.append(option);
    }
    direction.value = value.direction || "unknown"; label.append(direction); row.append(label);
    const reasonLabel = node("label", "vc-thesis-field"); reasonLabel.append(node("span", "", zh ? "故事里的哪件事，会带来这个变化？" : "What in your story causes this change?"));
    const reason = node("textarea", "vc-note-input"); reason.rows = 2; reason.maxLength = THESIS_LIMIT; reason.value = value.reason || "";
    reason.placeholder = zh ? "例如：要覆盖更多地区，就需要增加渠道和库存投入。还不确定也可以先留空。" : "For example: reaching more regions requires more channel and inventory investment. Leave blank if uncertain.";
    reason.setAttribute("aria-label", `${caseName} · ${title} · ${zh ? "原因" : "Reason"}`); reasonLabel.append(reason);
    const hint = help(impactParameterHint(key, currentFields, currentMethod, lang));
    row.append(reasonLabel, hint); list.append(row); rows.set(key, { row, direction, reason, hint });
    remove.addEventListener("click", () => { row.remove(); rows.delete(key); refreshSuggestions(); changed(); choiceButtons.get(key)?.focus(); });
    direction.addEventListener("change", changed);
  }
  function addFromChoice(key) { addImpact(key); refreshSuggestions(); changed(); rows.get(key)?.direction.focus(); }
  for (const item of THESIS_IMPACTS) {
    const button = node("button", "vc-impact-chip", (zh ? "+ " : "+ ") + (zh ? item.zh : item.en)); button.type = "button";
    button.addEventListener("click", () => addFromChoice(item.key)); choices.append(button); choiceButtons.set(item.key, button);
  }
  function refreshSuggestions() {
    const keys = suggestedImpacts(story.value).filter((key) => !rows.has(key));
    suggestions.replaceChildren();
    suggestions.append(help(zh ? (keys.length ? "根据你的用词，可以先检查这些影响（需你确认）：" : "不确定影响什么？展开下面的选项，也可以稍后再判断。") : (keys.length ? "Your wording suggests these topics to review; you decide whether they apply:" : "Not sure yet? Browse the topics below, or come back later.")));
    if (keys.length) {
      const chips = node("div", "vc-impact-choices");
      for (const key of keys) {
        const item = THESIS_IMPACTS.find((entry) => entry.key === key);
        const button = node("button", "vc-impact-chip", "+ " + (zh ? item.zh : item.en)); button.type = "button";
        button.addEventListener("click", () => addFromChoice(key)); chips.append(button);
      }
      suggestions.append(chips);
    }
    for (const [key, button] of choiceButtons) { button.disabled = rows.has(key); }
    next.hidden = !rows.size;
  }
  story.addEventListener("input", refreshSuggestions);

  // Existing prose stays editable and survives round trips, without demanding it again.
  const previous = node("details", "vc-question-example"); previous.append(node("summary", "", zh ? "之前写过的检验与假设" : "Previous research notes"));
  textField(previous, "assessment", zh ? "原有故事检验" : "Previous story assessment", "");
  textField(previous, "drivers", zh ? "原有关键假设" : "Previous assumptions", ""); panel.append(previous);
  textField(followup, "signals", zh ? "5. 什么变化会让你重新考虑这个故事？" : "5. What would make you reconsider this story?", zh ? "例如：新品迟迟没有复购、客户流失增加。先写观察事项，有依据后再定阈值。" : "For example: no repeat orders, or more customers leaving. Set thresholds once supported by evidence.");

  function write(value) {
    const clean = cleanThesis({ [scenario.key]: value })[scenario.key] || {};
    for (const [key, input] of Object.entries(inputs)) input.value = clean[key] || "";
    noEvidence.hidden = !!evidence.value.trim();
    for (const { row } of rows.values()) row.remove(); rows.clear();
    for (const item of clean.impacts || []) addImpact(item.key, item);
    previous.hidden = !clean.assessment && !clean.drivers; refreshSuggestions();
  }
  write(initial);
  return {
    read: () => ({ ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])), impacts: [...rows].map(([key, row]) => ({ key, direction: row.direction.value, reason: row.reason.value })) }),
    write,
    focus: () => story.focus(),
    updateModel(fields, methodKey) {
      currentFields = fields; currentMethod = methodKey;
      for (const [key, row] of rows) row.hint.textContent = impactParameterHint(key, fields, methodKey, lang);
    },
  };
}
