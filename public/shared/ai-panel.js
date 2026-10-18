/**
 * ai-panel.js — 估值工作台的 AI 助手抽屉（右侧滑出）。
 * 和 AI 聊估值假设；AI 回复若带建议参数，消息下方出现「建议参数」卡：逐项列出 当前 → 建议 + 理由，点「应用」才写入表单，可撤销。
 * 回复还可带最多 2 个交互组件（敏感性表 / 倍数对比条 / 一键改值按钮），见下方 widgets。
 * 导出：mountAiPanel(host, { lang, getContext, onApply, onUndo, fmtField })
 *   getContext() → { stock, method, mode, fields:[{k,label,col,unit,money,value}], facts }  —— 每次发送时现取，始终是当前方法与当前表单
 *   onApply(params) → snapshot   —— 写入表单，返回写入前的快照
 *   onUndo(snapshot)             —— 恢复快照
 *   fmtField(field, value) → 文本 —— 金额字段用 B/亿 等单位显示
 *   widgets（可选）—— AI 回复里的交互组件由宿主现算数值，模型只给组件类型和字段：
 *     sweep(fieldKey, steps) → { rows:[{ step, value, low, high, current }] } | null   「敏感性」
 *     peers(multiple)        → { unit, items:[{ key, label, value, pct }] } | null     「倍数对比」，null = 数据缺失不显示
 *     fmtPrice(n) → 文本                                                              合理价显示
 *   「一键改值」组件走 onApply / onUndo，和建议参数卡一样可撤销。未知组件直接忽略。
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
    cons: "保守", opt: "乐观", scenC: "保守情景", scenO: "乐观情景", scenDrivers: "关键假设", scenBreaks: "可能错在哪", scenSignals: "跟踪信号", err: "AI 暂时不可用", limit: "今天的 AI 对话次数已用完，明天再来", clear: "清空对话",
    disclaimer: "AI 建议仅供参考，不构成投资建议",
    sens: "敏感性", sensLow: "合理价 低", sensHigh: "高", peers: "倍数对比", setTo: (x, y) => `把 ${x} 改成 ${y}`, setDone: "已改",
  },
  en: {
    title: "AI valuation assistant", sub: "Talk it through and let AI fill in assumptions", close: "Close", ph: "Ask about growth, margins, WACC…", send: "Send",
    intro: "I'll use this stock's data and the current method to suggest conservative / optimistic assumptions with reasons. Nothing is written to the form until you apply it.",
    quick: ["Suggest a full set of conservative / optimistic assumptions", "Are my current assumptions reasonable?", "What discount rate / WACC should I use?"],
    thinking: "Thinking…", suggest: "Suggested inputs", field: "Field", now: "Now", next: "Suggested", apply: "Apply to form", applied: "Applied", undo: "Undo",
    cons: "Cons.", opt: "Opt.", scenC: "Conservative case", scenO: "Optimistic case", scenDrivers: "Key assumptions", scenBreaks: "Where it could be wrong", scenSignals: "Signals to watch", err: "AI is unavailable right now", limit: "Daily AI limit reached — try again tomorrow", clear: "Clear chat",
    disclaimer: "AI suggestions are for reference only, not investment advice",
    sens: "Sensitivity", sensLow: "Fair value low", sensHigh: "High", peers: "Multiple check", setTo: (x, y) => `Set ${x} to ${y}`, setDone: "Changed",
  },
};

// AI 接口失败时给用户看的一句话：区分「全站免费额度用完」（Workers AI 每天 10,000 Neurons，UTC 0 点 = 北京时间 8 点重置）
// 和「个人每天次数用完」，两种都提示可以配置自己的模型（不受限制）
export function aiErrorText(status, j, lang) {
  const zh = lang !== "en", e = j && j.error;
  if (e === "site_quota") return zh ? "站点的免费 AI 额度今天已用完（全站共用），北京时间早上 8 点恢复；也可以在「设置 → AI 模型」里配置自己的模型，不受这个限制"
    : "The site's free AI allowance is used up for today (shared by everyone); it resets at 00:00 UTC. Add your own model under Settings → AI models to skip this limit";
  if (e === "daily_limit" || status === 429) return zh ? "你今天的 AI 次数已用完，明天再来；在「设置 → AI 模型」里配置自己的模型可不受限制"
    : "You've used today's AI requests; try again tomorrow, or add your own model under Settings → AI models";
  if (e === "bad_ai_output") return zh ? "AI 返回的格式不对，请重试" : "Unexpected AI output, try again";
  if (/访问量过大|稍后再试/.test((j && j.detail) || "")) return zh ? "智谱免费模型现在太忙（并发有限制），稍等一会儿再试，或在 AI 面板顶部的模型菜单换一个模型" : "The free Zhipu model is busy right now (concurrency is limited); try again shortly or switch models from the menu at the top of the AI panel";
  return String((j && j.detail) || e || status);
}

export function mountAiPanel(host, { lang, getContext, onApply, onUndo, fmtField, widgets: wx, checkParams }) {
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
  // 副标题位置放模型切换：显示当前模型，点开在已配置好的模型里切换（配置在设置页）
  const modelWrap = el("div", "vc-ai-modelwrap");
  const modelBtn = el("button", "vc-ai-model"); modelBtn.type = "button"; modelBtn.setAttribute("aria-haspopup", "menu");
  const modelName = el("span", "", T.sub); modelBtn.append(modelName, ri("arrow-down-s-line"));
  const modelMenu = el("div", "vc-ai-mmenu"); modelMenu.setAttribute("role", "menu"); modelMenu.hidden = true;
  modelWrap.append(modelBtn, modelMenu);
  titles.append(el("div", "vc-ai-title", T.title), modelWrap);
  let models = null;
  const slug = (location.pathname.match(/^\/b\/([^/]+)/) || [])[1];
  function drawModels() {
    const all = [models.site, ...models.workers, ...(models.siteKey || []), ...models.custom];
    const cur = all.find((m) => m.id === models.active) || models.site;
    modelName.textContent = (lang === "zh" ? "模型：" : "Model: ") + cur.name;
    modelMenu.innerHTML = "";
    const group = (label, items) => {
      if (!items.length) return;
      modelMenu.appendChild(el("div", "vc-ai-mgroup", label));
      for (const m of items) {
        const b = el("button", m.id === models.active ? "on" : ""); b.type = "button"; b.setAttribute("role", "menuitemradio");
        b.append(el("span", "vc-ai-mname", m.name), el("span", "vc-ai-mmodel", m.kind === "site" ? (lang === "zh" ? "站点默认" : "Site default") : m.model));
        b.addEventListener("click", async () => {
          modelMenu.hidden = true;
          if (m.id === models.active) return;
          const r = await fetch("/api/my/ai/active", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: m.id }) }).catch(() => null);
          if (r && r.ok) { models.active = m.id; drawModels(); }
        });
        modelMenu.appendChild(b);
      }
    };
    group(lang === "zh" ? "站点默认" : "Site default", [models.site]);
    group("Workers AI", models.workers.filter((w) => w.model !== (models.site.provider === "workers-ai" ? models.site.model : "")));
    group(lang === "zh" ? "免费模型" : "Free models", models.siteKey || []); // 站点配了 Key 的免费模型（如智谱 GLM-4.7-Flash）
    group(lang === "zh" ? "我的模型" : "My models", models.custom);
    const manage = document.createElement("a"); manage.className = "vc-ai-manage";
    manage.textContent = models.custom.length ? (lang === "zh" ? "管理模型…" : "Manage models…") : (lang === "zh" ? "添加自己的模型（OpenAI 兼容 / Anthropic）…" : "Add your own model…");
    manage.href = slug ? `/b/${slug}#ai` : "#"; manage.target = "_blank"; manage.rel = "noopener"; // 新标签打开设置，不打断正在编辑的估值
    modelMenu.appendChild(manage);
  }
  const loadModels = () => fetch("/api/my/ai/models").then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) { models = j; drawModels(); } }).catch(() => {});
  loadModels();
  modelBtn.addEventListener("click", (e) => { e.stopPropagation(); if (!models) return; if (modelMenu.hidden) loadModels(); modelMenu.hidden = !modelMenu.hidden; });
  document.addEventListener("click", (e) => { if (!modelWrap.contains(e.target)) modelMenu.hidden = true; });
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

  // 保守 / 乐观两个情景的分析：故事 + 关键假设 + 可能错在哪 + 跟踪信号
  function scenarioBlock(key, sc) {
    const box = el("div", "vc-ai-scen " + key);
    box.appendChild(el("div", "vc-ai-scen-head", key === "c" ? T.scenC : T.scenO));
    if (sc.story) box.appendChild(el("p", "vc-ai-scen-story", sc.story));
    if (sc.drivers && sc.drivers.length) {
      box.appendChild(el("div", "vc-ai-scen-k", T.scenDrivers));
      const ul = el("ul", "vc-ai-scen-list"); sc.drivers.forEach((d) => ul.appendChild(el("li", "", d))); box.appendChild(ul);
    }
    for (const [k, lab] of [["breaks", T.scenBreaks], ["signals", T.scenSignals]]) {
      if (!sc[k]) continue;
      const row = el("div", "vc-ai-scen-row"); row.append(el("span", "vc-ai-scen-k", lab), el("span", "", sc[k])); box.appendChild(row);
    }
    return box;
  }
  function suggestionCard(params, reasons, fields, scenarios) {
    const byKey = new Map(fields.map((f) => [f.k, f]));
    const card = el("div", "vc-ai-sugg");
    const top = el("div", "vc-ai-sugg-head");
    top.append(ri("magic-line"), el("span", "", T.suggest));
    card.appendChild(top);
    if (scenarios && (scenarios.c || scenarios.o)) {
      const wrap = el("div", "vc-ai-scens");
      if (scenarios.c) wrap.appendChild(scenarioBlock("c", scenarios.c));
      if (scenarios.o) wrap.appendChild(scenarioBlock("o", scenarios.o));
      card.appendChild(wrap);
    }
    const same = (f, v) => f.col === "dual" ? (v && f.value && v.c === f.value.c && v.o === f.value.o) : v === f.value;
    let checks = {}; try { checks = (checkParams && checkParams(params)) || {}; } catch { checks = {}; }
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
      // 系统核对：建议值相对最新实际值的位置（代码算的，不依赖模型怎么说）
      if (checks[k]) { const ck = el("div", "vc-ai-scheck"); ck.append(ri("scales-3-line"), el("span", "", (lang === "zh" ? "系统核对：" : "Check: ") + checks[k])); row.appendChild(ck); }
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

  // ── 交互组件：数值全部由宿主现算，模型只决定放哪个组件 ──
  const unitOf = (f) => (f.unit === "%" ? "%" : "");
  function sensitivityWidget(w, f) {
    const data = wx && wx.sweep && wx.sweep(w.field, w.steps);
    if (!data || !data.rows.some((r) => r.low !== null)) return null;
    const card = el("div", "vc-ai-widget");
    const top = el("div", "vc-ai-sugg-head"); top.append(ri("line-chart-line"), el("span", "", `${T.sens} · ${f.label}`));
    const tbl = el("div", "vc-ai-wsens");
    const head = el("div", "vc-ai-wsrow head");
    head.append(el("span", "", f.label + (f.unit === "%" ? " %" : "")), el("span", "", T.sensLow), el("span", "", T.sensHigh));
    tbl.appendChild(head);
    const price = (n) => (n === null ? "—" : (wx.fmtPrice ? wx.fmtPrice(n) : String(Math.round(n * 100) / 100)));
    for (const r of data.rows) {
      const row = el("div", "vc-ai-wsrow" + (r.current ? " cur" : ""));
      row.append(el("span", "", showVal(f, r.value) + unitOf(f)), el("span", "", price(r.low)), el("span", "", price(r.high)));
      tbl.appendChild(row);
    }
    card.append(top, tbl);
    return card;
  }
  function peersWidget(w) {
    const data = wx && wx.peers && wx.peers(w.multiple);
    if (!data) return null;
    const card = el("div", "vc-ai-widget");
    const top = el("div", "vc-ai-sugg-head"); top.append(ri("bar-chart-horizontal-line"), el("span", "", `${T.peers} · ${{ pe: "P/E", pb: "P/B", ps: "P/S" }[w.multiple]}`));
    card.appendChild(top);
    for (const it of data.items) {
      const row = el("div", "vc-ai-wbar" + (it.key === "current" ? " cur" : ""));
      const track = el("div", "vc-ai-wtrack"); const fill = el("div", "vc-ai-wfill"); fill.style.width = Math.max(4, it.pct * 100) + "%"; track.appendChild(fill);
      row.append(el("span", "vc-ai-wblab", it.label), track, el("span", "vc-ai-wbval", it.value.toFixed(1) + data.unit));
      card.appendChild(row);
    }
    return card;
  }
  function setWidget(w, f) {
    const same = f.col === "dual" ? (f.value && w.value.c === f.value.c && w.value.o === f.value.o) : w.value === f.value;
    if (same) return null;
    const wrap = el("div", "vc-ai-wset");
    const btn = el("button", "vc-ai-chip vc-ai-setchip"); btn.type = "button";
    const label = T.setTo(f.label, showVal(f, w.value) + unitOf(f));
    btn.append(ri("edit-2-line"), document.createTextNode(label));
    if (w.label) btn.title = w.label;
    const undo = el("button", "vc-ai-undo", T.undo); undo.type = "button"; undo.hidden = true;
    let snap = null;
    btn.addEventListener("click", () => {
      snap = onApply({ [w.field]: w.value });
      btn.disabled = true; btn.replaceChildren(ri("check-line"), document.createTextNode(`${T.setDone} · ${label}`));
      undo.hidden = false;
    });
    undo.addEventListener("click", () => {
      if (snap) onUndo(snap);
      snap = null; undo.hidden = true;
      btn.disabled = false; btn.replaceChildren(ri("edit-2-line"), document.createTextNode(label));
    });
    wrap.append(btn, undo);
    return wrap;
  }
  // 前端再校验一遍：字段必须在当前方法里，类型必须在目录里；渲染失败的组件直接不显示（正文照常）
  function renderWidgets(list, fields) {
    const byKey = new Map(fields.map((f) => [f.k, f]));
    const out = [];
    for (const w of (Array.isArray(list) ? list : []).slice(0, 2)) {
      let node = null;
      try {
        if (w.type === "sensitivity" && byKey.has(w.field)) node = sensitivityWidget(w, byKey.get(w.field));
        else if (w.type === "peers") node = peersWidget(w);
        else if (w.type === "set" && byKey.has(w.field)) node = setWidget(w, byKey.get(w.field));
      } catch { node = null; }
      if (node) out.push(node);
    }
    return out;
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
        const m = bubble("ai", r.status === 429 ? aiErrorText(r.status, j, lang) : `${T.err}${j && j.detail ? "：" + j.detail : ""}`);
        m.classList.add("error");
        return;
      }
      const extra = renderWidgets(j.widgets, context.fields);
      const reply = j.reply || (j.params || extra.length ? "" : "…");
      const tail = {};
      if (j.params) tail.params = j.params;
      if (Array.isArray(j.widgets) && j.widgets.length) tail.widgets = j.widgets;
      history.push({ role: "assistant", content: reply + (Object.keys(tail).length ? "\n" + JSON.stringify(tail) : "") });
      const m = reply ? bubble("ai", reply) : bubble("ai", "");
      if (!reply) m.querySelector(".vc-ai-bubble").remove();
      if (j.params) m.appendChild(suggestionCard(j.params, j.reasons, context.fields, j.scenarios));
      for (const node of extra) m.appendChild(node);
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
  // history()：给备注草稿用的对话摘录（只读副本）
  return { open, close, toggle: () => (panel.hidden ? open() : close()), history: () => history.slice(-20) };
}
