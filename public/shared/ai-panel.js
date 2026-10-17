/**
 * ai-panel.js — 估值工作台的 AI 助手抽屉（右侧滑出）。
 * 和 AI 聊估值假设；AI 回复若带建议参数，消息下方出现「建议参数」卡：逐项列出 当前 → 建议 + 理由，点「应用」才写入表单，可撤销。
 * 导出：mountAiPanel(host, { lang, getContext, onApply, onUndo, fmtField })
 *   getContext() → { stock, method, mode, fields:[{k,label,col,unit,money,value}], facts }  —— 每次发送时现取，始终是当前方法与当前表单
 *   onApply(params) → snapshot   —— 写入表单，返回写入前的快照
 *   onUndo(snapshot)             —— 恢复快照
 *   fmtField(field, value) → 文本 —— 金额字段用 B/亿 等单位显示
 * 返回 { open(), close(), toggle() }
 */

function ri(name) { const i = document.createElement("i"); i.className = "ri-" + name; i.setAttribute("aria-hidden", "true"); return i; }
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }

const TX = {
  zh: {
    title: "AI 估值助手", sub: "聊聊这家公司，让 AI 帮你填假设", close: "关闭", ph: "问点什么，如「增速给多少合适？」", send: "发送",
    intro: "我会结合这只股票的数据和当前估值方法，给出保守 / 乐观两档假设和理由。建议的参数需要你确认后才会写入表单。",
    quick: ["帮我给出一套完整的保守 / 乐观假设", "看看我现在的假设是否合理", "折现率 / WACC 该取多少？"],
    thinking: "思考中…", suggest: "建议参数", field: "字段", now: "当前", next: "建议", apply: "应用到表单", applied: "已应用", undo: "撤销",
    cons: "保守", opt: "乐观", err: "AI 暂时不可用", limit: "今天的 AI 对话次数已用完，明天再来", clear: "清空对话",
    disclaimer: "AI 建议仅供参考，不构成投资建议",
  },
  en: {
    title: "AI valuation assistant", sub: "Talk it through and let AI fill in assumptions", close: "Close", ph: "Ask about growth, margins, WACC…", send: "Send",
    intro: "I'll use this stock's data and the current method to suggest conservative / optimistic assumptions with reasons. Nothing is written to the form until you apply it.",
    quick: ["Suggest a full set of conservative / optimistic assumptions", "Are my current assumptions reasonable?", "What discount rate / WACC should I use?"],
    thinking: "Thinking…", suggest: "Suggested inputs", field: "Field", now: "Now", next: "Suggested", apply: "Apply to form", applied: "Applied", undo: "Undo",
    cons: "Cons.", opt: "Opt.", err: "AI is unavailable right now", limit: "Daily AI limit reached — try again tomorrow", clear: "Clear chat",
    disclaimer: "AI suggestions are for reference only, not investment advice",
  },
};

export function mountAiPanel(host, { lang, getContext, onApply, onUndo, fmtField }) {
  const T = TX[lang] || TX.zh;
  const history = []; // { role, content } —— 发给后端的对话（不含建议卡）
  let busy = false;

  const panel = el("aside", "vc-ai");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", T.title);

  const head = el("div", "vc-ai-head");
  const badge = el("div", "vc-ai-badge"); badge.appendChild(ri("sparkling-2-fill"));
  const titles = el("div", "vc-ai-titles");
  titles.append(el("div", "vc-ai-title", T.title), el("div", "vc-ai-sub", T.sub));
  const clearBtn = el("button", "btn icon sm vc-ai-iconbtn"); clearBtn.type = "button"; clearBtn.title = T.clear; clearBtn.setAttribute("aria-label", T.clear); clearBtn.appendChild(ri("delete-bin-6-line"));
  const closeBtn = el("button", "btn icon sm vc-ai-iconbtn"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", T.close); closeBtn.appendChild(ri("close-line"));
  head.append(badge, titles, clearBtn, closeBtn);

  const log = el("div", "vc-ai-log");
  log.setAttribute("aria-live", "polite");

  const foot = el("form", "vc-ai-foot");
  const input = el("textarea", "vc-ai-input"); input.rows = 1; input.placeholder = T.ph; input.maxLength = 2000;
  const sendBtn = el("button", "vc-ai-send"); sendBtn.type = "submit"; sendBtn.setAttribute("aria-label", T.send); sendBtn.appendChild(ri("arrow-up-line"));
  const box = el("div", "vc-ai-box"); box.append(input, sendBtn);
  foot.append(box, el("div", "vc-ai-disclaimer", T.disclaimer));

  panel.append(head, log, foot);
  host.appendChild(panel);

  function renderIntro() {
    log.innerHTML = "";
    const intro = el("div", "vc-ai-intro");
    intro.appendChild(el("p", "", T.intro));
    const chips = el("div", "vc-ai-quick");
    T.quick.forEach((q) => {
      const b = el("button", "vc-ai-chip", q); b.type = "button";
      b.addEventListener("click", () => send(q));
      chips.appendChild(b);
    });
    intro.appendChild(chips);
    log.appendChild(intro);
  }
  renderIntro();

  function bubble(role, text) {
    const intro = log.querySelector(".vc-ai-intro"); if (intro) intro.remove();
    const m = el("div", "vc-ai-msg " + (role === "user" ? "me" : "ai"));
    const b = el("div", "vc-ai-bubble"); b.textContent = text;
    m.appendChild(b); log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  const showVal = (f, v) => {
    if (v && typeof v === "object") return `${fmtField(f, v.c)} / ${fmtField(f, v.o)}`;
    return fmtField(f, v);
  };

  function suggestionCard(params, reasons, fields) {
    const byKey = new Map(fields.map((f) => [f.k, f]));
    const card = el("div", "vc-ai-sugg");
    const top = el("div", "vc-ai-sugg-head");
    top.append(ri("magic-line"), el("span", "", T.suggest));
    card.appendChild(top);
    const same = (f, v) => f.col === "dual" ? (v && f.value && v.c === f.value.c && v.o === f.value.o) : v === f.value;
    Object.entries(params).forEach(([k, v]) => {
      const f = byKey.get(k); if (!f || same(f, v)) return; // 和当前值一样的不列
      const row = el("div", "vc-ai-srow");
      const lab = el("div", "vc-ai-slab", f.label + (f.unit === "%" ? " %" : ""));
      const vals = el("div", "vc-ai-svals");
      const now = el("span", "vc-ai-snow", showVal(f, f.value));
      const arrow = ri("arrow-right-line");
      const next = el("span", "vc-ai-snext");
      if (f.col === "dual" && v && typeof v === "object") {
        next.append(el("em", "", T.cons + " "), document.createTextNode(fmtField(f, v.c)), el("em", "", "  " + T.opt + " "), document.createTextNode(fmtField(f, v.o)));
      } else next.textContent = showVal(f, v);
      vals.append(now, arrow, next);
      row.append(lab, vals);
      if (reasons && reasons[k]) row.appendChild(el("div", "vc-ai-sreason", reasons[k]));
      card.appendChild(row);
    });
    const actions = el("div", "vc-ai-sact");
    const apply = el("button", "vc-ai-apply"); apply.type = "button"; apply.append(ri("check-line"), document.createTextNode(T.apply));
    const undo = el("button", "vc-ai-undo", T.undo); undo.type = "button"; undo.hidden = true;
    let snap = null;
    apply.addEventListener("click", () => {
      snap = onApply(params);
      apply.disabled = true; apply.replaceChildren(ri("check-double-line"), document.createTextNode(T.applied));
      undo.hidden = false;
    });
    undo.addEventListener("click", () => {
      if (snap) onUndo(snap);
      snap = null; undo.hidden = true;
      apply.disabled = false; apply.replaceChildren(ri("check-line"), document.createTextNode(T.apply));
    });
    actions.append(apply, undo);
    card.appendChild(actions);
    return card;
  }

  async function send(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    let context;
    try { context = getContext(); } catch { context = null; }
    if (!context || !context.fields || !context.fields.length) return;
    busy = true; sendBtn.disabled = true;
    input.value = ""; autosize();
    bubble("user", text);
    history.push({ role: "user", content: text });
    const pending = bubble("ai", T.thinking); pending.classList.add("pending");
    try {
      const r = await fetch("/api/my/ai/valuation", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang, messages: history.slice(-20), context }),
      });
      const j = await r.json().catch(() => ({}));
      pending.remove();
      if (!r.ok) {
        history.pop();
        const m = bubble("ai", r.status === 429 ? T.limit : `${T.err}${j && j.detail ? "：" + j.detail : ""}`);
        m.classList.add("error");
        return;
      }
      const reply = j.reply || (j.params ? "" : "…");
      history.push({ role: "assistant", content: reply + (j.params ? "\n" + JSON.stringify({ params: j.params }) : "") });
      const m = reply ? bubble("ai", reply) : bubble("ai", "");
      if (!reply) m.querySelector(".vc-ai-bubble").remove();
      if (j.params) m.appendChild(suggestionCard(j.params, j.reasons, context.fields));
      log.scrollTop = log.scrollHeight;
    } catch {
      pending.remove(); history.pop();
      bubble("ai", T.err).classList.add("error");
    } finally {
      busy = false; sendBtn.disabled = false; input.focus();
    }
  }

  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  foot.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  clearBtn.addEventListener("click", () => { if (busy) return; history.length = 0; renderIntro(); });
  closeBtn.addEventListener("click", () => close());
  // Esc 只关面板：捕获阶段接住，避免宿主页的全局 Esc 顺带退出整个编辑器
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || panel.hidden || !panel.isConnected) return;
    e.stopPropagation(); e.preventDefault(); close();
  }, true);

  function open() { panel.hidden = false; document.body.classList.add("vc-ai-open"); requestAnimationFrame(() => panel.classList.add("on")); setTimeout(() => input.focus(), 50); }
  function close() { panel.classList.remove("on"); document.body.classList.remove("vc-ai-open"); setTimeout(() => { if (!panel.classList.contains("on")) panel.hidden = true; }, 220); }
  return { open, close, toggle: () => (panel.hidden ? open() : close()) };
}
