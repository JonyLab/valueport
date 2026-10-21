import { cleanManagementResearch } from "./valuation/management-research.js";
import { managementResearchElement } from "./valuation/management-research-ui.js";

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
 * 返回 { open(), close(), toggle(), openModelPicker() }
 */

function ri(name) { const i = document.createElement("i"); i.className = "ri-" + name; i.setAttribute("aria-hidden", "true"); return i; }
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }

const TX = {
  zh: {
    title: "AI 估值助手", sub: "聊聊这家公司，让 AI 帮你填假设", close: "关闭", ph: "问点什么，如「增速给多少合适？」", send: "发送",
    intro: "我会结合这只股票的数据和当前估值方法，给出保守 / 乐观两档假设和理由。建议的参数需要你确认后才会写入表单。",
    quick: ["帮我给出一套完整的保守 / 乐观假设", "看看我现在的假设是否合理", "折现率 / WACC 该取多少？"],
    more: ["保守和乐观之间差多大比较合适？", "这家公司最大的风险是什么？", "和同行比，现在的估值贵不贵？", "哪个假设对结论影响最大？", "这个估值方法适合这家公司吗？", "当前价格隐含了多少增长？"],
    fieldQ: (f) => `「${f}」该取多少？`, sugHint: "↑↓ 选择 · Enter 发送 · Tab 填入", sugBtn: "常用问题",
    stop: "停止生成", stopped: "已停止生成", thinking: "思考中…", copy: "复制", copied: "已复制", copyFail: "复制失败，可以手动选中文字复制", retry: "重试", suggest: "建议参数", field: "字段", now: "当前", next: "建议", apply: "应用到表单", applied: "已应用", undo: "撤销",
    cons: "保守", opt: "乐观", scenC: "保守情景", scenO: "乐观情景", scenDrivers: "关键假设", scenBreaks: "可能错在哪", scenSignals: "跟踪信号", err: "AI 暂时不可用", limit: "今天的 AI 对话次数已用完，明天再来", clear: "新对话", hist: "历史对话", histEmpty: "这只股票还没有保存的对话", histDel: "删除这条对话", histDelQ: "删除这条对话？", untitled: "（无标题）", cur: "当前",
    disclaimer: "AI 建议仅供参考，不构成投资建议",
    risk: "AI 的回答可能出错。它不是持牌投资顾问，以上内容仅供参考，不构成投资建议；数字和结论请自己核实，不要盲目照做。",
    sens: "敏感性", sensLow: "合理价 低", sensHigh: "高", peers: "倍数对比", setTo: (x, y) => `把 ${x} 改成 ${y}`, setDone: "已改",
  },
  en: {
    title: "AI valuation assistant", sub: "Talk it through and let AI fill in assumptions", close: "Close", ph: "Ask about growth, margins, WACC…", send: "Send",
    intro: "I'll use this stock's data and the current method to suggest conservative / optimistic assumptions with reasons. Nothing is written to the form until you apply it.",
    quick: ["Suggest a full set of conservative / optimistic assumptions", "Are my current assumptions reasonable?", "What discount rate / WACC should I use?"],
    more: ["How far apart should the conservative and optimistic cases be?", "What's the biggest risk for this company?", "Is it expensive compared with peers?", "Which assumption moves the result most?", "Does this method suit this company?", "How much growth does today's price imply?"],
    fieldQ: (f) => `What should "${f}" be?`, sugHint: "↑↓ choose · Enter send · Tab fill in", sugBtn: "Suggested questions",
    stop: "Stop generating", stopped: "Generation stopped", thinking: "Thinking…", copy: "Copy", copied: "Copied", copyFail: "Couldn't copy — select the text to copy it", retry: "Retry", suggest: "Suggested inputs", field: "Field", now: "Now", next: "Suggested", apply: "Apply to form", applied: "Applied", undo: "Undo",
    cons: "Cons.", opt: "Opt.", scenC: "Conservative case", scenO: "Optimistic case", scenDrivers: "Key assumptions", scenBreaks: "Where it could be wrong", scenSignals: "Signals to watch", err: "AI is unavailable right now", limit: "Daily AI limit reached — try again tomorrow", clear: "New chat", hist: "Chat history", histEmpty: "No saved chats for this stock yet", histDel: "Delete this chat", histDelQ: "Delete this chat?", untitled: "(untitled)", cur: "Current",
    disclaimer: "AI suggestions are for reference only, not investment advice",
    risk: "AI can be wrong. It is not a licensed financial adviser — treat this as reference only, not investment advice. Check the numbers and conclusions yourself; don't follow it blindly.",
    sens: "Sensitivity", sensLow: "Fair value low", sensHigh: "High", peers: "Multiple check", setTo: (x, y) => `Set ${x} to ${y}`, setDone: "Changed",
  },
};

// AI 接口失败时给用户看的一句话：区分「全站免费额度用完」（Workers AI 每天 10,000 Neurons，UTC 0 点 = 北京时间 8 点重置）
// 和「个人每天次数用完」，两种都提示可以配置自己的模型（不受限制）
export function aiErrorText(status, j, lang) {
  const zh = lang !== "en", e = j && j.error;
  if (e === "search_not_configured") return zh ? "联网搜索暂未配置" : "Web search is not configured";
  if (e === "search_company_required") return zh ? "缺少公司名称或代码，无法搜索" : "A company name or ticker is required for search";
  if (e === "search_timeout" || e === "search_failed") return zh ? "联网搜索失败，请重试或关闭搜索后发送" : "Search failed. Retry or turn off web search.";
  if (e === "site_quota") return zh ? "站点的免费 AI 额度今天已用完（全站共用），北京时间早上 8 点恢复；也可以在「设置 → AI 模型」里配置自己的模型，不受这个限制"
    : "The site's free AI allowance is used up for today (shared by everyone); it resets at 00:00 UTC. Add your own model under Settings → AI models to skip this limit";
  if (e === "daily_limit" || status === 429) return zh ? "你今天的 AI 次数已用完，明天再来；在「设置 → AI 模型」里配置自己的模型可不受限制"
    : "You've used today's AI requests; try again tomorrow, or add your own model under Settings → AI models";
  if (e === "bad_ai_output") return zh ? "AI 返回的格式不对，请重试" : "Unexpected AI output, try again";
  if (/访问量过大|稍后再试/.test((j && j.detail) || "")) return zh ? "智谱免费模型现在太忙（并发有限制），稍等一会儿再试，或切换模型" : "The free Zhipu model is busy right now (concurrency is limited); try again shortly or switch models";
  // 用户不该看到 503、upstream_error 这类代号或英文报错：一律换成人话，原始信息只记到控制台便于排查
  const raw = String((j && j.detail) || e || "");
  if (raw || status) console.warn("[ai]", status, raw);
  if (status === 401 || status === 403) return zh ? "登录已过期，请刷新页面后重新登录" : "Your session has expired. Refresh the page and sign in again";
  if (status === 400 || status === 413) return zh ? "这次提交的内容太多或格式不对，可以精简一下回答后再试" : "This request was too long or malformed. Shorten your answers and try again";
  if (/[\u4e00-\u9fff]/.test(raw) && raw.length < 200 && !/\d{3}/.test(raw)) return raw; // 已经是给人看的中文说明
  return zh ? "AI 暂时没有响应，可能是服务繁忙，请稍后再试" : "The AI didn't respond. It may be busy; please try again shortly";
}

// History is user-editable data too: validate links on both new replies and restoration.
export function normalizeResearch(value) {
  if (!value || !["ok", "empty"].includes(value.status) || !Array.isArray(value.sources)) return null;
  const sources = [];
  for (const s of value.sources.slice(0, 5)) {
    try {
      const u = new URL(s.url);
      if (u.protocol !== "https:" || u.username || u.password || u.href.length > 1200 || !Number.isInteger(s.id) || s.id < 1 || s.id > 5) continue;
      sources.push({ id: s.id, url: u.href, title: typeof s.title === "string" ? s.title.slice(0, 200) : u.hostname,
        publishedAt: typeof s.publishedAt === "string" ? s.publishedAt.slice(0, 80) : null });
    } catch { /* Ignore unsafe links in old or edited history. */ }
  }
  return { status: sources.length ? "ok" : "empty", searchedAt: typeof value.searchedAt === "string" ? value.searchedAt.slice(0, 80) : "", sources };
}

export function mountAiPanel(host, { lang, getContext, prepareContext, onApply, onUndo, fmtField, widgets: wx, checkParams, chatKey }) {
  const T = TX[lang] || TX.zh;
  const history = []; // { role, content } —— 发给后端的对话（不含建议卡）
  let busy = false, activeRequest = null;

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
  let models = null, inlineModelMenu = null;
  const slug = (location.pathname.match(/^\/b\/([^/]+)/) || [])[1];
  function drawModels(menu = modelMenu) {
    const all = [models.site, ...models.workers, ...(models.siteKey || []), ...models.custom];
    const cur = all.find((m) => m.id === models.active) || models.site;
    modelName.textContent = (lang === "zh" ? "模型：" : "Model: ") + cur.name;
    menu.innerHTML = "";
    const group = (label, items) => {
      if (!items.length) return;
      menu.appendChild(el("div", "vc-ai-mgroup", label));
      for (const m of items) {
        const b = el("button", m.id === models.active ? "on" : ""); b.type = "button"; b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(m.id === models.active));
        b.append(el("span", "vc-ai-mname", m.name), el("span", "vc-ai-mmodel", m.kind === "site" ? (lang === "zh" ? "站点默认" : "Site default") : m.model));
        b.addEventListener("click", async () => {
          const dismiss = () => { if (menu.matches(":popover-open")) menu.hidePopover(); else menu.hidden = true; };
          if (m.id === models.active) { dismiss(); return; }
          for (const option of menu.querySelectorAll("button")) option.disabled = true;
          const r = await fetch("/api/my/ai/active", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: m.id }) }).catch(() => null);
          if (r && r.ok) { models.active = m.id; dismiss(); drawModels(); }
          else {
            for (const option of menu.querySelectorAll("button")) option.disabled = false;
            let error = menu.querySelector('[role="alert"]');
            if (!error) { error = el("p", "vc-ai-mgroup"); error.setAttribute("role", "alert"); menu.append(error); }
            error.textContent = lang === "zh" ? "切换失败，请重试。" : "Could not switch models. Try again.";
          }
        });
        menu.appendChild(b);
      }
    };
    group(lang === "zh" ? "站点默认" : "Site default", [models.site]);
    group("Workers AI", models.workers.filter((w) => w.model !== (models.site.provider === "workers-ai" ? models.site.model : "")));
    group(lang === "zh" ? "免费模型" : "Free models", models.siteKey || []); // 站点配了 Key 的免费模型（如智谱 GLM-4.7-Flash）
    group(lang === "zh" ? "我的模型" : "My models", models.custom);
    const manage = document.createElement("a"); manage.className = "vc-ai-manage";
    manage.textContent = models.custom.length ? (lang === "zh" ? "管理模型…" : "Manage models…") : (lang === "zh" ? "添加自己的模型（OpenAI 兼容 / Anthropic）…" : "Add your own model…");
    manage.href = slug ? `/b/${slug}#ai` : "#"; manage.target = "_blank"; manage.rel = "noopener"; // 新标签打开设置，不打断正在编辑的估值
    menu.appendChild(manage);
  }
  const loadModels = () => fetch("/api/my/ai/models").then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j) {
      models = j; drawModels();
      searchBtn.disabled = !j.webSearchAvailable;
      searchBtn.title = j.webSearchAvailable
        ? (lang === "zh" ? "仅搜索公司公开资料" : "Search public company information only")
        : (lang === "zh" ? "联网搜索暂未配置" : "Web search is not configured");
      if (!j.webSearchAvailable) { useSearch = false; searchBtn.setAttribute("aria-pressed", "false"); }
    }
  }).catch(() => {});
  loadModels();
  modelBtn.addEventListener("click", (e) => { e.stopPropagation(); if (!models) { openModelPicker(); return; } if (modelMenu.hidden) loadModels(); modelMenu.hidden = !modelMenu.hidden; });
  document.addEventListener("click", (e) => { if (!modelWrap.contains(e.target)) modelMenu.hidden = true; });
  // 「历史」：这只股票保存过的对话；「新对话」：开一段新的（旧的仍在历史里）
  const histWrap = el("div", "vc-ai-histwrap");
  const histBtn = el("button", "btn icon sm vc-ai-iconbtn"); histBtn.type = "button"; histBtn.title = T.hist; histBtn.setAttribute("aria-label", T.hist); histBtn.setAttribute("aria-haspopup", "menu"); histBtn.appendChild(ri("history-line"));
  const histMenu = el("div", "vc-ai-mmenu vc-ai-hmenu"); histMenu.setAttribute("role", "menu"); histMenu.hidden = true;
  histWrap.append(histBtn, histMenu);
  const clearBtn = el("button", "btn icon sm vc-ai-iconbtn"); clearBtn.type = "button"; clearBtn.title = T.clear; clearBtn.setAttribute("aria-label", T.clear); clearBtn.appendChild(ri("chat-new-line"));
  const closeBtn = el("button", "btn icon sm vc-ai-iconbtn"); closeBtn.type = "button"; closeBtn.setAttribute("aria-label", T.close); closeBtn.appendChild(ri("close-line"));
  head.append(badge, titles, histWrap, clearBtn, closeBtn);

  const log = el("div", "vc-ai-log");
  log.setAttribute("aria-live", "polite");

  const foot = el("form", "vc-ai-foot");
  let useSearch = false;
  const searchBtn = el("button", "vc-ai-search"); searchBtn.type = "button"; searchBtn.disabled = true;
  searchBtn.setAttribute("aria-pressed", "false");
  searchBtn.append(ri("global-line"), document.createTextNode(lang === "zh" ? "联网搜索" : "Web search"));
  searchBtn.addEventListener("click", () => { if (busy) return; useSearch = !useSearch; searchBtn.setAttribute("aria-pressed", String(useSearch)); });
  const input = el("textarea", "vc-ai-input"); input.rows = 1; input.placeholder = T.ph; input.maxLength = 2000;
  const sendBtn = el("button", "vc-ai-send"); sendBtn.type = "submit"; sendBtn.setAttribute("aria-label", T.send); sendBtn.appendChild(ri("arrow-up-line"));
  // 常用问题：默认收起，点输入框左边的灯泡才展开；展开时输入会按关键字过滤
  const sugToggle = el("button", "vc-ai-sugbtn"); sugToggle.type = "button"; sugToggle.title = T.sugBtn; sugToggle.setAttribute("aria-label", T.sugBtn); sugToggle.setAttribute("aria-expanded", "false");
  sugToggle.appendChild(ri("lightbulb-line"));
  const box = el("div", "vc-ai-box"); box.append(sugToggle, input, sendBtn);
  // 预设问题建议：输入框聚焦时在上方弹出；空着时列常用问题，输入后按关键字过滤；问题里也带上当前方法的字段
  const sug = el("div", "vc-ai-sug"); sug.hidden = true; sug.setAttribute("role", "listbox");
  foot.append(sug, searchBtn, box, el("div", "vc-ai-disclaimer", T.disclaimer));

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

  // 每条消息下的小操作行：复制（所有消息）、重试（失败的消息），和常见 AI 应用一样
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch { ok = false; } ta.remove(); return ok;
    }
  }
  function msgActions(m, { copy, retry } = {}) {
    const row = el("div", "vc-ai-macts");
    const iconBtn = (icon, label) => { const b = el("button", "vc-ai-mact"); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.appendChild(ri(icon)); return b; };
    if (copy) {
      const b = iconBtn("file-copy-line", T.copy);
      b.addEventListener("click", async () => {
        const ok = await copyText(typeof copy === "function" ? copy() : copy);
        b.replaceChildren(ri(ok ? "check-line" : "error-warning-line")); b.title = ok ? T.copied : T.copyFail; b.classList.add(ok ? "done" : "fail");
        setTimeout(() => { b.replaceChildren(ri("file-copy-line")); b.title = T.copy; b.classList.remove("done", "fail"); }, ok ? 1500 : 2500);
      });
      row.appendChild(b);
    }
    if (retry) { const b = iconBtn("refresh-line", T.retry); b.addEventListener("click", retry); row.appendChild(b); }
    m.appendChild(row);
    return row;
  }
  // AI 回复复制成纯文本：正文 + 两个情景 + 建议参数（字段：保守 / 乐观 — 理由）
  function replyAsText(reply, j, fields) {
    const parts = [];
    if (reply) parts.push(reply);
    const byKey = new Map(fields.map((f) => [f.k, f]));
    const sc = j.scenarios || {};
    for (const [k, title] of [["c", T.scenC], ["o", T.scenO]]) {
      const x = sc[k]; if (!x) continue;
      const lines = [title + (x.story ? "：" + x.story : "")];
      if (x.drivers && x.drivers.length) lines.push(T.scenDrivers + "：", ...x.drivers.map((d) => "· " + d));
      if (x.breaks) lines.push(T.scenBreaks + "：" + x.breaks);
      if (x.signals) lines.push(T.scenSignals + "：" + x.signals);
      parts.push(lines.join("\n"));
    }
    if (j.params) {
      const lines = [T.suggest + "："];
      for (const [k, v] of Object.entries(j.params)) {
        const f = byKey.get(k); if (!f) continue;
        const val = f.col === "dual" && v && typeof v === "object" ? `${T.cons} ${fmtField(f, v.c)} / ${T.opt} ${fmtField(f, v.o)}` : showVal(f, v);
        lines.push(`· ${f.label}${f.unit === "%" ? "（%）" : ""}：${val}` + (j.reasons && j.reasons[k] ? " — " + j.reasons[k] : ""));
      }
      parts.push(lines.join("\n"));
    }
    const research = normalizeResearch(j.research);
    if (research?.sources.length) parts.push((lang === "zh" ? "搜索来源（摘要待核实）：" : "Search sources (excerpts need verification):") + "\n" + research.sources.map((s) => `[${s.id}] ${s.title}${s.publishedAt ? " · " + s.publishedAt : ""}\n${s.url}`).join("\n"));
    parts.push("—— " + T.risk); // 复制出去也带上风险提示
    return parts.join("\n\n");
  }

  const showVal = (f, v) => {
    if (v && typeof v === "object") return `${fmtField(f, v.c)} / ${fmtField(f, v.o)}`;
    return fmtField(f, v);
  };

  // 保守 / 乐观两个情景的分析：叙事 + 关键假设 + 可能错在哪 + 跟踪信号
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
      const f = byKey.get(k); if (!f || (same(f, v) && !reasons?.[k])) return;
      const row = el("div", "vc-ai-srow");
      const lab = el("div", "vc-ai-slab", f.label + (f.unit ? ` (${f.unit})` : ""));
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
      snap = onApply(params, fields);
      if (snap === null) return;
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
      snap = onApply({ [w.field]: w.value }, [f]);
      if (snap === null) return;
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

  function userMsg(text) { const um = bubble("user", text); msgActions(um, { copy: text }); return um; }
  // 一条 AI 回复：正文 + 建议参数卡（含情景）+ 交互组件 + 复制；发送和恢复历史共用。返回正文
  function renderAssistant(view, fields) {
    if (Array.isArray(view.resourceFields)) fields = fields.filter((f) => !f.k.startsWith("resource.")).concat(view.resourceFields);
    const extra = renderWidgets(view.widgets, fields);
    const reply = view.reply || (view.params || extra.length ? "" : "…");
    const m = bubble("ai", reply);
    if (!reply) m.querySelector(".vc-ai-bubble").remove();
    const management = managementResearchElement(view.managementResearch, lang); if (management) m.append(management);
    const research = normalizeResearch(view.research);
    if (research) {
      const sources = el("div", "vc-ai-sources");
      sources.appendChild(el("div", "vc-ai-source-title", research.status === "empty"
        ? (lang === "zh" ? "未找到相关公开资料" : "No relevant public sources found")
        : (lang === "zh" ? "搜索来源 · 摘要待核实" : "Search sources · verify excerpts")));
      if (research.searchedAt) {
        const date = new Date(research.searchedAt);
        if (!isNaN(date)) sources.appendChild(el("div", "vc-ai-source-date", (lang === "zh" ? "检索于 " : "Searched ") + date.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US")));
      }
      for (const s of research.sources) {
        const row = el("div", "vc-ai-source"), link = el("a", "", `[${s.id}] ${s.title}`);
        link.href = s.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        row.append(link, el("span", "vc-ai-source-date", `${new URL(s.url).hostname} · ${s.publishedAt || (lang === "zh" ? "发布日期未提供" : "Publication date unavailable")}`));
        sources.appendChild(row);
      }
      m.appendChild(sources);
    }
    if (view.params) m.appendChild(suggestionCard(view.params, view.reasons, fields, view.scenarios));
    for (const node of extra) m.appendChild(node);
    // 每条 AI 回复底部一条醒目的风险提示：可能出错、不是持牌顾问、只能参考
    const risk = el("div", "vc-ai-risk"); risk.append(ri("error-warning-line"), el("span", "", T.risk));
    m.appendChild(risk);
    msgActions(m, { copy: () => replyAsText(reply === "…" ? "" : reply, view, fields) });
    log.scrollTop = log.scrollHeight;
    return reply;
  }
  // 发给后端的历史里，AI 回复带上它给过的参数 / 组件（JSON 一行），让后续追问有上下文
  function historyContent(reply, view) {
    const tail = {};
    if (view.params) tail.params = view.params;
    if (view.widgets && view.widgets.length) tail.widgets = view.widgets;
    const research = normalizeResearch(view.research);
    if (research) tail.previousSearch = { searchedAt: research.searchedAt,
      sources: research.sources.map(({ id, title, publishedAt }) => ({ id, title, publishedAt })) };
    return (reply + (Object.keys(tail).length ? "\n" + JSON.stringify(tail) : "")).slice(0, 4000);
  }

  // ── 对话记录：每次问答成功后存到服务端（按标的），面板第一次打开时恢复最近一次 ──
  const saved = []; // [{ role, content, view? }]
  let chatId = null, restoredOnce = false;
  const keyNow = () => { try { return chatKey ? chatKey() : null; } catch { return null; } };
  let saving = Promise.resolve();
  function saveChat() {
    const k = keyNow(); if (!k || !k.symbol || !saved.length) return;
    const body = { id: chatId || undefined, symbol: k.symbol, method: k.method || "", messages: saved.slice(-80) };
    saving = saving.then(() => fetch("/api/my/ai/chats", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j && j.id) chatId = j.id; }).catch(() => {}));
  }
  function resetChat() { history.length = 0; saved.length = 0; chatId = null; renderIntro(); }
  function restoreChat(chat) {
    let fields = [];
    try { const c = getContext(); fields = (c && c.fields) || []; } catch { fields = []; }
    history.length = 0; saved.length = 0; chatId = chat.id;
    log.innerHTML = "";
    for (const msg of chat.messages || []) {
      if (msg.role === "user") { userMsg(msg.content); history.push({ role: "user", content: msg.content }); }
      else { const view = msg.view || { reply: msg.content }; renderAssistant(view, fields); history.push({ role: "assistant", content: historyContent(msg.content, view) }); }
      saved.push(msg);
    }
    if (!saved.length) renderIntro();
  }
  async function listChats() {
    const k = keyNow(); if (!k || !k.symbol) return [];
    try { const r = await fetch("/api/my/ai/chats?symbol=" + encodeURIComponent(k.symbol)); return r.ok ? (await r.json()).chats || [] : []; } catch { return []; }
  }
  async function openChat(id) {
    try { const r = await fetch("/api/my/ai/chats/" + id); if (r.ok) restoreChat((await r.json()).chat); } catch { /* 拿不到就保持现状 */ }
  }
  async function restoreLatest() {
    if (restoredOnce || saved.length || busy) return;
    restoredOnce = true;
    const list = await listChats();
    if (list.length && !saved.length && !busy) await openChat(list[0].id);
  }
  const whenText = (iso) => {
    const d = new Date(iso); if (isNaN(d)) return "";
    const days = Math.floor((Date.now() - d) / 86400000);
    if (days < 1) return d.toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric" });
  };
  async function drawHistory() {
    histMenu.innerHTML = "";
    histMenu.appendChild(el("div", "vc-ai-mgroup", T.hist));
    const list = await listChats();
    if (!list.length) { histMenu.appendChild(el("div", "vc-ai-hempty", T.histEmpty)); return; }
    for (const c of list) {
      const row = el("div", "vc-ai-hrow" + (c.id === chatId ? " on" : ""));
      const b = el("button", ""); b.type = "button"; b.setAttribute("role", "menuitem");
      b.append(el("span", "vc-ai-mname", c.title || T.untitled), el("span", "vc-ai-mmodel", `${whenText(c.updatedAt)} · ${Math.ceil(c.count / 2)} ${lang === "zh" ? "轮" : c.count > 2 ? "turns" : "turn"}${c.id === chatId ? " · " + T.cur : ""}`));
      b.addEventListener("click", () => { histMenu.hidden = true; if (busy || c.id === chatId) return; openChat(c.id); });
      const del = el("button", "vc-ai-hdel"); del.type = "button"; del.title = T.histDel; del.setAttribute("aria-label", T.histDel); del.appendChild(ri("delete-bin-6-line"));
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(T.histDelQ)) return;
        await fetch("/api/my/ai/chats/" + c.id, { method: "DELETE" }).catch(() => null);
        if (c.id === chatId && !busy) resetChat();
        drawHistory();
      });
      row.append(b, del); histMenu.appendChild(row);
    }
  }
  histBtn.addEventListener("click", (e) => { e.stopPropagation(); const show = histMenu.hidden; histMenu.hidden = !show; if (show) drawHistory(); });
  document.addEventListener("click", (e) => { if (!histWrap.contains(e.target)) histMenu.hidden = true; });

  function setBusy(value) {
    busy = value;
    sendBtn.setAttribute("aria-label", value ? T.stop : T.send);
    sendBtn.title = value ? T.stop : T.send;
    sendBtn.replaceChildren(ri(value ? "stop-fill" : "arrow-up-line"));
    log.setAttribute("aria-busy", String(value));
  }
  function stop() { activeRequest?.stop(); }

  async function send(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    let context;
    try { context = getContext(); } catch { context = null; }
    if (!context || !context.fields || !context.fields.length) return;
    const controller = new AbortController();
    const request = { stop: null };
    activeRequest = request;
    setBusy(true);
    input.value = ""; autosize();
    const um = userMsg(text);
    history.push({ role: "user", content: text });
    const pending = bubble("ai", ""); pending.classList.add("pending");
    const pendingBody = pending.querySelector(".vc-ai-bubble");
    // DotMatrix Core Spiral adapted to the native DOM (no React runtime).
    // https://dotmatrix.zzzzshawn.cloud/r/dotm-square-3.json
    const loader = el("span", "vc-ai-dotmatrix"); loader.setAttribute("aria-hidden", "true");
    const spiral = [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5, 6, 7, 8, 13, 18, 17, 16, 11, 12];
    for (let i = 0; i < 25; i++) {
      const dot = el("span");
      dot.style.animationDelay = `${(spiral.indexOf(i) * 0.04 - 1) * 2.025}s`;
      loader.appendChild(dot);
    }
    pendingBody.append(loader, el("span", "", useSearch ? (lang === "zh" ? "检索公开资料并分析中…" : "Searching public sources and analyzing…") : T.thinking));
    // 失败时：错误消息带「重试」——去掉这一问一答，用同样的问题重新发
    const failed = (msg) => {
      const m = bubble("ai", msg); m.classList.add("error");
      msgActions(m, { copy: msg, retry: () => { if (busy) return; m.remove(); um.remove(); send(text); } });
    };
    const finish = () => {
      if (activeRequest !== request) return;
      activeRequest = null;
      setBusy(false);
      if (!panel.hidden) input.focus();
    };
    request.stop = () => {
      controller.abort();
      history.pop(); // 取消的问题不混入后续模型上下文，也不保存为完整问答。
      pending.classList.remove("pending");
      pending.querySelector(".vc-ai-bubble").textContent = T.stopped;
      msgActions(pending, { retry: () => {
        if (busy) return;
        pending.remove(); um.remove(); send(text);
      } });
      finish();
    };
    try {
      if (prepareContext) { await prepareContext(); if (controller.signal.aborted) return; context = getContext(); }
      const r = await fetch("/api/my/ai/valuation", {
        signal: controller.signal,
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang, messages: history.slice(-20), context, webSearch: useSearch }),
      });
      if (controller.signal.aborted) return;
      const j = await r.json().catch(() => ({}));
      if (controller.signal.aborted) return;
      pending.remove();
      if (!r.ok) {
        history.pop();
        failed(r.status === 429 || j.error?.startsWith("search_") ? aiErrorText(r.status, j, lang) : `${T.err}${j && j.detail ? "：" + j.detail : ""}`);
        return;
      }
      const view = { reply: j.reply || "", params: j.params || null, reasons: j.reasons || null, scenarios: j.scenarios || null, widgets: Array.isArray(j.widgets) ? j.widgets : [] };
      const research = normalizeResearch(j.research); if (research) view.research = research;
      const management = cleanManagementResearch(context.managementResearch); if (management) view.managementResearch = management;
      const usedFields = new Set([...Object.keys(view.params || {}), ...view.widgets.map((w) => w.field)]);
      const resourceFields = context.fields.filter((f) => f.k.startsWith("resource.") && usedFields.has(f.k));
      if (resourceFields.length) view.resourceFields = resourceFields;
      const reply = renderAssistant(view, context.fields);
      history.push({ role: "assistant", content: historyContent(reply, view) });
      saved.push({ role: "user", content: text }, { role: "assistant", content: reply, view });
      saveChat();
    } catch {
      if (controller.signal.aborted) return;
      pending.remove(); history.pop();
      failed(T.err);
    } finally {
      finish();
    }
  }

  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  // ── 预设问题建议 ──
  let sugItems = [], sugIdx = -1;
  function presets() {
    let fields = [];
    try { const c = getContext(); fields = (c && c.fields || []).map((f) => f.label || f.k).filter(Boolean); } catch { fields = []; }
    const all = [...T.quick, ...T.more, ...fields.map((f) => T.fieldQ(f))];
    return [...new Set(all)];
  }
  // 打分：整串包含 > 按空格 / 标点切出的词都命中 > 命中的字数；没输入时按预设顺序
  function rank(q, list) {
    const t = q.trim().toLowerCase();
    if (!t) return list.slice(0, 5);
    const words = t.split(/[\s,，。？?！!、/]+/).filter(Boolean);
    return list.map((x) => {
      const lx = x.toLowerCase();
      let score = 0;
      if (lx.includes(t)) score = 1000 - lx.indexOf(t);
      else if (words.length && words.every((w) => lx.includes(w))) score = 500;
      else if (/[\u4e00-\u9fff]/.test(t)) { const chars = [...new Set(t.replace(/[^\u4e00-\u9fff]/g, ""))]; score = chars.length && chars.filter((ch) => lx.includes(ch)).length / chars.length >= 0.6 ? 100 + chars.length : 0; } // 中文按字模糊匹配；英文字母重合没意义
      return [score, x];
    }).filter(([sc, x]) => sc > 0 && x.toLowerCase() !== t).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, x]) => x);
  }
  let sugOpen = false; // 只有点了灯泡才展开
  function hideSug() { sug.hidden = true; sugIdx = -1; sugOpen = false; sugToggle.classList.remove("on"); sugToggle.setAttribute("aria-expanded", "false"); }
  function showSug() {
    if (busy || !sugOpen) return hideSug();
    sugItems = rank(input.value, presets());
    if (!sugItems.length) return hideSug();
    sug.innerHTML = "";
    sugItems.forEach((q, i) => {
      const b = el("button", "vc-ai-sugitem" + (i === sugIdx ? " on" : ""), q); b.type = "button"; b.setAttribute("role", "option");
      b.addEventListener("mousedown", (e) => e.preventDefault()); // 不让输入框先失焦
      b.addEventListener("click", () => { hideSug(); send(q); });
      sug.appendChild(b);
    });
    sug.appendChild(el("div", "vc-ai-sughint", T.sugHint));
    sug.hidden = false;
  }
  const moveSug = (d) => { if (sug.hidden || !sugItems.length) return false; sugIdx = (sugIdx + d + sugItems.length) % sugItems.length; showSug(); return true; };
  input.addEventListener("input", () => { autosize(); sugIdx = -1; if (sugOpen) showSug(); });
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== sugToggle) hideSug(); }, 120));
  sugToggle.addEventListener("mousedown", (e) => e.preventDefault()); // 保持输入框焦点
  sugToggle.addEventListener("click", () => {
    if (sugOpen) { hideSug(); input.focus(); return; }
    sugOpen = true; sugToggle.classList.add("on"); sugToggle.setAttribute("aria-expanded", "true"); sugIdx = -1; showSug(); input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" && moveSug(1)) { e.preventDefault(); return; }
    if (e.key === "ArrowUp" && moveSug(-1)) { e.preventDefault(); return; }
    if (e.key === "Tab" && !sug.hidden && sugItems.length) { e.preventDefault(); input.value = sugItems[Math.max(0, sugIdx)]; autosize(); hideSug(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const pick = !sug.hidden && sugIdx >= 0 ? sugItems[sugIdx] : null;
      hideSug(); send(pick || input.value);
    }
  });
  foot.addEventListener("submit", (e) => { e.preventDefault(); if (busy) stop(); else send(input.value); });
  clearBtn.addEventListener("click", () => { if (busy) return; resetChat(); input.focus(); });
  closeBtn.addEventListener("click", () => close());
  // Esc 只关面板：捕获阶段接住，避免宿主页的全局 Esc 顺带退出整个编辑器
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (inlineModelMenu?.matches(":popover-open")) {
      e.stopPropagation(); e.preventDefault(); inlineModelMenu.hidePopover(); return;
    }
    if (panel.hidden || !panel.isConnected) return;
    e.stopPropagation(); e.preventDefault();
    if (!modelMenu.hidden) { modelMenu.hidden = true; modelBtn.focus(); return; }
    if (!sug.hidden) { hideSug(); return; } // 先收起建议，再按一次才关面板
    close();
  }, true);

  function open(focusInput = true) { restoreLatest(); panel.hidden = false; document.body.classList.add("vc-ai-open"); requestAnimationFrame(() => panel.classList.add("on")); if (focusInput) setTimeout(() => { if (!panel.hidden) input.focus(); }, 50); }
  async function openModelPicker(anchor = modelBtn) {
    if (anchor !== modelBtn) {
      const menu = el("div", "vc-ai-mmenu vc-ai-inline-models");
      menu.setAttribute("popover", "auto"); menu.setAttribute("role", "menu");
      inlineModelMenu = menu;
      menu.setAttribute("aria-label", lang === "zh" ? "切换模型" : "Switch model");
      menu.append(el("p", "vc-ai-mgroup", lang === "zh" ? "正在加载模型…" : "Loading models…"));
      anchor.parentElement.append(menu);
      const position = () => {
        const rect = anchor.getBoundingClientRect(), width = Math.min(300, innerWidth - 24);
        menu.style.width = `${width}px`;
        menu.style.left = `${Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))}px`;
        const height = menu.getBoundingClientRect().height;
        menu.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - height - 12))}px`;
      };
      menu.addEventListener("toggle", (event) => {
        anchor.setAttribute("aria-expanded", String(event.newState === "open"));
        if (event.newState === "closed") { if (inlineModelMenu === menu) inlineModelMenu = null; menu.remove(); if (anchor.isConnected) anchor.focus(); }
      });
      menu.showPopover(); position();
      await loadModels();
      if (!menu.isConnected || !menu.matches(":popover-open")) return;
      if (models) drawModels(menu);
      else menu.replaceChildren(el("p", "vc-ai-mgroup", lang === "zh" ? "模型列表加载失败，请关闭后重试。" : "Could not load models. Close and retry."));
      position();
      (menu.querySelector('[aria-checked="true"]') || menu).focus();
      return;
    }
    open(false);
    modelBtn.focus();
    await Promise.all([loadModels(), new Promise(requestAnimationFrame)]); // 等待 click 冒泡和面板展开，再显示菜单
    if (panel.hidden || !panel.classList.contains("on")) return;
    if (!models) {
      modelMenu.replaceChildren(el("p", "vc-ai-mgroup", lang === "zh" ? "模型列表加载失败，请再次点击模型菜单重试。" : "Could not load models. Click the model menu to retry."));
    }
    modelMenu.hidden = false;
    (modelMenu.querySelector('[role="menuitemradio"].on') || modelBtn).focus();
  }
  function close() { modelMenu.hidden = true; panel.classList.remove("on"); document.body.classList.remove("vc-ai-open"); setTimeout(() => { if (!panel.classList.contains("on")) panel.hidden = true; }, 220); }
  // history()：给备注草稿用的对话摘录（只读副本）
  return { open, close, openModelPicker, toggle: () => (panel.hidden ? open() : close()), history: () => history.slice(-20) };
}
