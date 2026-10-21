// 全站 AI 助手（右上角入口）：顶栏一个圆形图标按钮，只对已登录用户显示；点开右侧抽屉，结合当前页面聊投研问题。
// 和估值工作台里的 AI 估值助手（/shared/ai-panel.js，aside.vc-ai）互斥：打开一个就关掉另一个，两个抽屉不会叠在一起。
// 后端：POST /api/my/ai/assist { lang, messages, page } → { reply }（额度 / 错误码同其它 AI 接口）。
// 用法：mountGlobalAi(容器, { getPage, extraHosts })
//   getPage() → { kind: "watchlist"|"stock"|"portfolio"|"macro"|"other", path, title, symbol?, name?, summary? }（发送时现取；不传按路径推断）
//   extraHosts（可选）—— CSS 选择器：页面后来才画出来的工具条（如个股详情页的 .vd-backrow-right），出现时自动也放一个按钮
// 快捷键 ⌘K / Ctrl+K 开关；Esc 关闭。对话按页面路径存在 sessionStorage，返回这页时还在。样式在 /shared/styles.css 的 .gai-*。
import { LANG } from "./i18n.js";

const zh = LANG === "zh";
const TX = zh ? {
  btn: "AI 助手", title: "AI 助手", close: "关闭", clear: "新对话", send: "发送", stop: "停止生成", stopped: "已停止生成",
  ph: "问点什么…", thinking: "思考中…", retry: "重试", copy: "复制", copied: "已复制",
  intro: "我可以结合你当前所在的页面，解释估值概念、帮你梳理研究思路，或者告诉你应用里的功能怎么用。",
  disclaimer: "AI 回答可能出错，不是持牌投资顾问，仅供参考，不构成投资建议",
  cur: "当前：", model: "模型：", modelLoading: "选择模型", site: "站点默认", free: "免费模型", mine: "我的模型",
  manageAdd: "添加自己的模型…", manage: "管理模型…", switchFail: "切换失败，请重试。", shortcut: "⌘K",
  kinds: { watchlist: "自选看板", stock: "个股详情", portfolio: "资产页", macro: "宏观看板", other: "当前页面" },
  quick: {
    stock: ["这家公司的估值钟摆现在说明什么？", "给这只股票估值，该从哪种方法入手？", "研究这家公司要重点看哪些风险？"],
    watchlist: ["怎么读懂看板上的估值钟摆？", "击球区、低估、高估分别是什么意思？", "怎样给新标的设定合理价值区间？"],
    portfolio: ["目标仓位和偏离该怎么设？", "高估区的持仓一般怎么复盘？", "资产页有哪些功能？"],
    macro: ["这些宏观指标对估值有什么影响？", "利率上升时估值假设该怎么调整？", "怎么看市场温度？"],
    other: ["这个应用能帮我做什么？", "什么是安全边际？", "DCF 估值的核心假设有哪些？"],
  },
  err: "AI 暂时没有响应，请稍后再试",
} : {
  btn: "AI assistant", title: "AI assistant", close: "Close", clear: "New chat", send: "Send", stop: "Stop generating", stopped: "Generation stopped",
  ph: "Ask anything…", thinking: "Thinking…", retry: "Retry", copy: "Copy", copied: "Copied",
  intro: "I can use the page you're on to explain valuation concepts, help structure your research, or show how the app's features work.",
  disclaimer: "AI can be wrong and isn't a licensed adviser — for reference only, not investment advice",
  cur: "Current: ", model: "Model: ", modelLoading: "Choose model", site: "Site default", free: "Free models", mine: "My models",
  manageAdd: "Add your own model…", manage: "Manage models…", switchFail: "Could not switch models. Try again.", shortcut: "⌘K",
  kinds: { watchlist: "Watchlist", stock: "Stock detail", portfolio: "Portfolio", macro: "Macro board", other: "This page" },
  quick: {
    stock: ["What does this stock's valuation pendulum tell me?", "Which valuation method should I start with here?", "What risks matter most for this company?"],
    watchlist: ["How do I read the valuation pendulums?", "What do strike zone, undervalued and overvalued mean?", "How do I set a fair-value range for a new stock?"],
    portfolio: ["How should I set target weights and drift?", "How do I review holdings in the overvalued zone?", "What can the portfolio page do?"],
    macro: ["How do these macro indicators affect valuation?", "How should rising rates change my assumptions?", "How do I read market temperature?"],
    other: ["What can this app help me with?", "What is a margin of safety?", "What are the key assumptions in a DCF?"],
  },
  err: "The AI didn't respond. Please try again shortly",
};
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const SHORTCUT = IS_MAC ? "⌘K" : "Ctrl+K";

// 和后端 src/ai-assist.js 的 ASSIST_LIMITS 保持一致：发送前先裁好，避免被 400
const LIM = { messages: 20, content: 4000, path: 200, title: 120, symbol: 24, name: 80, summary: 2000 };
const KINDS = ["watchlist", "stock", "portfolio", "macro", "other"];
const CAP_KEY = "gai_cap";       // sessionStorage：本次会话确认已登录（navboot 据此首帧放占位按钮；退出登录会清空会话存储）
const CHAT_PREFIX = "gai_chat:"; // sessionStorage：按页面路径存对话
const OPEN_KEY = "gai_open";     // sessionStorage：抽屉开着就记下，切页后保持打开（navboot.js 首帧前先加 html.gai-open，布局不跳）
const root = typeof document !== "undefined" ? document.documentElement : null; // 单测（node）里只用纯函数
const remember = (on) => { try { on ? sessionStorage.setItem(OPEN_KEY, "1") : sessionStorage.removeItem(OPEN_KEY); } catch { /* ignore */ } };
const wasOpen = () => { try { return sessionStorage.getItem(OPEN_KEY) === "1"; } catch { return false; } };
const CHAT_MAX_CHARS = 24000;    // 每页对话最多存这么多字（超了丢最早的一问一答）

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function ri(name) { const i = el("i", "ri-" + name); i.setAttribute("aria-hidden", "true"); return i; }
const line = (v, max) => (typeof v === "string" ? v.replace(/[\r\n`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/* ---------- 页面上下文 ---------- */
// 默认：按路径推断页面类型（/b/<slug>/<代码> 个股详情、/b/<slug> 自选看板、/portfolio、/macro）
export function pageFromPath(pathname = location.pathname) {
  const m = pathname.match(/^\/b\/[^/]+(?:\/([^/]+))?/);
  if (m && m[1]) { let symbol = ""; try { symbol = decodeURIComponent(m[1]); } catch { symbol = m[1]; } return { kind: "stock", symbol }; }
  if (m) return { kind: "watchlist" };
  if (/^\/portfolio\/?$/.test(pathname)) return { kind: "portfolio" };
  if (/^\/macro\/?$/.test(pathname)) return { kind: "macro" };
  return { kind: "other" };
}
const txt = (sel, root = document) => { const n = root.querySelector(sel); return n ? n.textContent.replace(/\s+/g, " ").trim() : ""; };
// 自选看板 / 个股详情（index.html）：只读页面上已经画出来的文字，轻量、不碰页面状态
export function watchlistPage() {
  const base = pageFromPath();
  const editing = document.body.classList.contains("ve-mode"); // 估值编辑页盖在详情页上：详情头部隐藏但还在 DOM 里，照样读
  if (document.body.classList.contains("vd-mode") || editing) {
    const hero = document.querySelector(".vd-hero");
    if (hero) {
      const name = txt(".vd-name", hero), code = txt(".vd-code", hero) || base.symbol || "";
      const facts = [
        [zh ? "市场" : "Market", txt(".vd-metatext", hero)],
        [zh ? "现价" : "Price", txt(".vd-price", hero)],
        [zh ? "当日涨跌" : "Day change", txt(".vd-chg", hero)],
        [zh ? "估值钟摆判定" : "Pendulum verdict", txt(".vd-verdict", hero)],
        ...(editing ? [[zh ? "当前操作" : "Current task", (txt(".ve-title") || (zh ? "估值编辑" : "Editing a valuation")) + (zh ? "（估值工作台）" : " (valuation workbench)")]] : []),
      ].filter(([, v]) => v && v !== "—");
      return { kind: "stock", name, symbol: code, summary: facts.map(([k, v]) => `${k}: ${v}`).join("\n") };
    }
  }
  if (base.kind === "watchlist") {
    const facts = [
      [zh ? "看板标题" : "Board title", txt("#title")],
      [zh ? "标的数" : "Holdings tracked", txt("#statTotal")],
      [zh ? "击球区" : "In strike zone", txt("#statStrike")],
      [zh ? "泡沫区" : "In bubble zone", txt("#statBubble")],
    ].filter(([, v]) => v);
    return { kind: "watchlist", summary: facts.map(([k, v]) => `${k}: ${v}`).join("\n") };
  }
  return base;
}
function cleanPage(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const kind = KINDS.includes(p.kind) ? p.kind : pageFromPath().kind;
  const out = { kind, path: line(typeof p.path === "string" && p.path.startsWith("/") ? p.path : location.pathname, LIM.path) || "/", title: line(p.title || document.title, LIM.title) };
  const symbol = line(p.symbol, LIM.symbol).replace(/[^A-Za-z0-9.\-_:]/g, "");
  if (symbol) out.symbol = symbol;
  const name = line(p.name, LIM.name); if (name) out.name = name;
  if (typeof p.summary === "string" && p.summary.trim()) out.summary = p.summary.trim().slice(0, LIM.summary);
  return out;
}
function chipText(page) {
  if (page.kind === "stock" && (page.name || page.symbol)) return TX.cur + [page.name, page.symbol].filter(Boolean).join(" ");
  return TX.cur + TX.kinds[page.kind];
}

/* ---------- 登录探测（兼取模型列表） ---------- */
const buttons = new Set();
let cap = false, capP = null, models = null;
try { cap = sessionStorage.getItem(CAP_KEY) === "1" || !!sessionStorage.getItem("fb_cap"); } catch { cap = false; } // 反馈的 fb_cap 也说明已登录
function syncButtons() {
  for (const b of buttons) { if (!b.isConnected) buttons.delete(b); else b.classList.toggle("hidden", !cap); }
}
// GET /api/my/ai/models：200 = 已登录（顺便拿到模型切换器的数据），401 = 没登录 → 不显示入口
function loadCap(force = false) {
  if (!capP || force) capP = fetch("/api/my/ai/models", { credentials: "same-origin" })
    .then((r) => {
      if (r.status === 401 || r.status === 403) { cap = false; models = null; return null; }
      if (!r.ok) return null; // 服务端出错：保留会话里的旧判断
      cap = true;
      return r.json().then((j) => { models = j && j.site ? j : null; }).catch(() => {});
    })
    .catch(() => { /* 网络失败：保留会话里的旧值 */ })
    .then(() => {
      try { cap ? sessionStorage.setItem(CAP_KEY, "1") : sessionStorage.removeItem(CAP_KEY); } catch { /* ignore */ }
      syncButtons();
      if (ui) ui.drawModels();
      return cap;
    });
  return capP;
}

let getPageFn = null, ui = null, lastFocus = null, keysBound = false, restored = false;

function makeButton() {
  const btn = el("button", "btn icon gai-btn" + (cap ? "" : " hidden"));
  btn.type = "button"; btn.title = `${TX.btn} (${SHORTCUT})`; btn.setAttribute("aria-label", TX.btn);
  btn.setAttribute("aria-haspopup", "dialog"); btn.setAttribute("aria-expanded", ui && ui.isOpen() ? "true" : "false");
  btn.setAttribute("aria-keyshortcuts", "Meta+K Control+K");
  btn.appendChild(ri("sparkling-2-line"));
  btn.addEventListener("click", (e) => toggle(e.currentTarget));
  buttons.add(btn);
  return btn;
}
// 放在反馈按钮 / 语言按钮之前；navboot.js 首帧放过静态占位就原地替换
function placeButton(host) {
  const btn = makeButton();
  const stub = host.querySelector(":scope > .gai-btn[data-static]");
  if (stub) stub.replaceWith(btn);
  else host.insertBefore(btn, host.querySelector(":scope > .fb-btn") || host.querySelector(":scope > .lang-menu"));
  return btn;
}

export function mountGlobalAi(host, { getPage, extraHosts } = {}) {
  if (typeof getPage === "function") getPageFn = getPage;
  const btn = host ? placeButton(host) : null;
  if (extraHosts) {
    // 详情页等后来才画出来的工具条：出现时补一个按钮（MutationObserver 回调本身已按微任务合并，查询很便宜）
    const scan = () => { document.querySelectorAll(extraHosts).forEach((h) => { if (!h.querySelector(":scope > .gai-btn")) placeButton(h); }); };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    scan();
  }
  bindKeys();
  // 上一页抽屉开着：直接打开（无动画、不抢焦点）；确认没登录就收起并清掉记录
  if (!restored) {
    restored = true;
    // 窄屏是整屏面板，切页后不自动盖住新页面
    if (wasOpen() && cap && !(window.matchMedia && window.matchMedia("(max-width:760px)").matches)) open(null, { restore: true });
    else root.classList.remove("gai-open");
    if (root.classList.contains("gai-boot")) { void getComputedStyle(document.body).paddingRight; root.classList.remove("gai-boot"); } // 先按无动画算好位置再去掉 boot
  }
  loadCap().then((ok) => { if (!ok && ui && ui.isOpen()) close(false); if (!ok) { remember(false); root.classList.remove("gai-open"); } });
  return btn;
}

function currentPage() {
  let raw = null;
  try { raw = getPageFn ? getPageFn() : null; } catch { raw = null; }
  return cleanPage(raw || pageFromPath());
}
function isEditable(t) {
  return !!(t && t.closest && t.closest("input,textarea,select,[contenteditable=''],[contenteditable='true']"));
}
function bindKeys() {
  if (keysBound) return; keysBound = true;
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      if (!cap) return;
      const inDrawer = ui && ui.panel.contains(e.target);
      if (isEditable(e.target) && !inDrawer) return; // 页面自己的输入框里不抢快捷键
      e.preventDefault(); e.stopPropagation();
      toggle(null);
      return;
    }
    if (e.key === "Escape" && ui && ui.isOpen()) {
      const a = document.activeElement;
      // 焦点在抽屉里、页面空白处或入口按钮上才由抽屉接 Esc；焦点在页面别的弹窗里时让它们自己处理
      if (!(ui.panel.contains(a) || a === document.body || a == null || (a.classList && a.classList.contains("gai-btn")))) return;
      e.preventDefault(); e.stopPropagation();
      if (ui.closeMenu()) return;
      close(true);
    }
  }, true);
}

function toggle(from) { if (ui && ui.isOpen()) close(true); else open(from); }
function open(from, { restore = false } = {}) {
  lastFocus = from || (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  if (!ui) ui = build();
  // 估值工作台的 AI 抽屉开着：先关掉它（点它自己的关闭按钮，走它的收尾逻辑）
  document.querySelectorAll("aside.vc-ai.on").forEach((p) => { const x = p.querySelector(".vc-ai-head > button:last-of-type"); if (x) x.click(); });
  ui.open({ restore });
  if (!restore) loadCap(true);
}
function close(returnFocus) {
  if (!ui || !ui.isOpen()) return;
  ui.close();
  if (!returnFocus) return;
  const target = lastFocus && lastFocus.isConnected && lastFocus.offsetParent !== null ? lastFocus
    : [...buttons].find((b) => b.isConnected && b.offsetParent !== null);
  if (target && target.focus) target.focus();
}

/* ---------- 对话存储（sessionStorage，按路径） ---------- */
function loadChat(path) {
  try {
    const j = JSON.parse(sessionStorage.getItem(CHAT_PREFIX + path) || "null");
    if (!j || !Array.isArray(j.msgs)) return [];
    return j.msgs.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
      .map((m) => ({ role: m.role, content: m.content.slice(0, LIM.content) })).slice(-40);
  } catch { return []; }
}
function saveChat(path, msgs) {
  let list = msgs.slice(-40);
  const size = (l) => l.reduce((n, m) => n + m.content.length, 0);
  while (list.length > 2 && size(list) > CHAT_MAX_CHARS) list = list.slice(2);
  try {
    if (!list.length) sessionStorage.removeItem(CHAT_PREFIX + path);
    else sessionStorage.setItem(CHAT_PREFIX + path, JSON.stringify({ v: 1, msgs: list }));
  } catch { /* 存储满了 / 不可用：只是不保留 */ }
}
// 发给后端的历史：最近 20 条，并且以用户消息开头
function forServer(msgs) {
  const out = msgs.slice(-LIM.messages);
  while (out.length && out[0].role !== "user") out.shift();
  return out.map((m) => ({ role: m.role, content: m.content.slice(0, LIM.content) }));
}

/* ---------- 回复的轻量渲染：段落 / 「- 」列表 / 编号列表 / **粗体** / `代码`，全部用 DOM 节点，不走 innerHTML ---------- */
function inline(parent, s) {
  const parts = s.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/);
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) parent.appendChild(el("strong", "", p.slice(2, -2)));
    else if (p.startsWith("`") && p.endsWith("`") && p.length > 2) parent.appendChild(el("code", "", p.slice(1, -1)));
    else parent.appendChild(document.createTextNode(p));
  }
}
export function renderRich(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let para = null, list = null;
  const flush = () => { para = null; list = null; };
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, "");
    if (!l.trim()) { flush(); continue; }
    const ul = l.match(/^\s*[-*•·]\s+(.*)$/), ol = l.match(/^\s*(\d{1,2})[.)、]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag); if (ol && ol[1] !== "1") list.start = Number(ol[1]); frag.appendChild(list); }
      para = null;
      const li = el("li"); inline(li, ul ? ul[1] : ol[2]); list.appendChild(li);
      continue;
    }
    list = null;
    const h = l.match(/^#{1,6}\s+(.*)$/);
    if (h) { const p = el("p"); p.appendChild(el("strong", "", h[1].replace(/\*\*/g, ""))); frag.appendChild(p); para = null; continue; }
    if (para) para.appendChild(el("br")); else { para = el("p"); frag.appendChild(para); }
    inline(para, l);
  }
  return frag;
}

/* ---------- 抽屉（整页一个，首次打开时创建） ---------- */
function build() {
  const panel = el("aside", "gai"); panel.hidden = true;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", TX.title); panel.setAttribute("aria-modal", "false");

  const head = el("div", "gai-head");
  const badge = el("div", "gai-badge"); badge.appendChild(ri("sparkling-2-fill"));
  const titles = el("div", "gai-titles");
  const modelWrap = el("div", "gai-modelwrap");
  const modelBtn = el("button", "gai-model"); modelBtn.type = "button"; modelBtn.setAttribute("aria-haspopup", "menu"); modelBtn.setAttribute("aria-expanded", "false");
  const modelName = el("span", "", TX.modelLoading); modelBtn.append(modelName, ri("arrow-down-s-line"));
  const modelMenu = el("div", "gai-mmenu"); modelMenu.setAttribute("role", "menu"); modelMenu.hidden = true;
  modelWrap.append(modelBtn, modelMenu);
  titles.append(el("div", "gai-title", TX.title), modelWrap);
  const iconBtn = (icon, label) => { const b = el("button", "btn icon sm gai-iconbtn"); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.appendChild(ri(icon)); return b; };
  const clearBtn = iconBtn("chat-new-line", TX.clear);
  const closeBtn = iconBtn("close-line", TX.close);
  head.append(badge, titles, clearBtn, closeBtn);

  const ctx = el("div", "gai-ctx"); const ctxIco = ri("map-pin-2-line"); const ctxText = el("span"); ctx.append(ctxIco, ctxText);
  const log = el("div", "gai-log"); log.setAttribute("aria-live", "polite");
  const foot = el("form", "gai-foot");
  const box = el("div", "gai-box");
  const input = el("textarea", "gai-input"); input.rows = 1; input.placeholder = TX.ph; input.maxLength = 2000; input.setAttribute("aria-label", TX.ph);
  const sendBtn = el("button", "gai-send"); sendBtn.type = "submit";
  box.append(input, sendBtn);
  foot.append(box, el("div", "gai-disclaimer", TX.disclaimer));
  panel.append(head, ctx, log, foot);
  document.body.appendChild(panel);

  let path = null, msgs = [], busy = false, request = null, page = currentPage();

  // 模型切换：和估值 AI 抽屉同一份配置（/api/my/ai/models、PUT /api/my/ai/active）
  function drawModels() {
    if (!models) { modelName.textContent = TX.modelLoading; return; }
    const all = [models.site, ...(models.workers || []), ...(models.siteKey || []), ...(models.custom || [])];
    const cur = all.find((m) => m.id === models.active) || models.site;
    modelName.textContent = TX.model + cur.name;
    modelMenu.replaceChildren();
    const group = (label, items) => {
      if (!items.length) return;
      modelMenu.appendChild(el("div", "gai-mgroup", label));
      for (const m of items) {
        const on = m.id === models.active;
        const b = el("button", on ? "on" : ""); b.type = "button"; b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(on));
        b.append(el("span", "gai-mname", m.name), el("span", "gai-mmodel", m.kind === "site" ? TX.site : m.model));
        b.addEventListener("click", async () => {
          if (m.id === models.active) { closeMenu(); return; }
          modelMenu.querySelectorAll("button").forEach((x) => { x.disabled = true; });
          const r = await fetch("/api/my/ai/active", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: m.id }) }).catch(() => null);
          if (r && r.ok) { models.active = m.id; drawModels(); closeMenu(); modelBtn.focus(); }
          else {
            modelMenu.querySelectorAll("button").forEach((x) => { x.disabled = false; });
            let er = modelMenu.querySelector('[role="alert"]');
            if (!er) { er = el("p", "gai-mgroup gai-merr"); er.setAttribute("role", "alert"); modelMenu.appendChild(er); }
            er.textContent = TX.switchFail;
          }
        });
        modelMenu.appendChild(b);
      }
    };
    group(TX.site, [models.site]);
    group("Workers AI", (models.workers || []).filter((w) => w.model !== (models.site.provider === "workers-ai" ? models.site.model : "")));
    group(TX.free, models.siteKey || []);
    group(TX.mine, models.custom || []);
    let slug = (location.pathname.match(/^\/b\/([^/]+)/) || [])[1];
    if (!slug) { try { slug = sessionStorage.getItem("owner_slug") || ""; } catch { slug = ""; } }
    if (slug) {
      const a = el("a", "gai-manage", (models.custom || []).length ? TX.manage : TX.manageAdd);
      a.href = "/b/" + encodeURIComponent(decodeURIComponent(slug)) + "#ai"; a.target = "_blank"; a.rel = "noopener";
      modelMenu.appendChild(a);
    }
  }
  function closeMenu() { if (modelMenu.hidden) return false; modelMenu.hidden = true; modelBtn.setAttribute("aria-expanded", "false"); return true; }
  modelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!modelMenu.hidden) { closeMenu(); return; }
    drawModels();
    if (!models) { loadCap(true); return; }
    modelMenu.hidden = false; modelBtn.setAttribute("aria-expanded", "true");
    const first = modelMenu.querySelector("button.on") || modelMenu.querySelector("button"); if (first) first.focus();
  });
  document.addEventListener("click", (e) => { if (!modelWrap.contains(e.target)) closeMenu(); });

  function setBusy(b) {
    busy = b;
    sendBtn.replaceChildren(ri(b ? "stop-fill" : "arrow-up-line"));
    sendBtn.setAttribute("aria-label", b ? TX.stop : TX.send); sendBtn.title = b ? TX.stop : TX.send;
    sendBtn.classList.toggle("stop", b);
    syncSend();
    clearBtn.disabled = b;
  }
  function syncSend() { sendBtn.disabled = !busy && !input.value.trim(); }
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  const scrollEnd = () => { log.scrollTop = log.scrollHeight; };

  function renderIntro() {
    const intro = el("div", "gai-intro");
    intro.appendChild(el("p", "", TX.intro));
    const chips = el("div", "gai-quick");
    for (const q of TX.quick[page.kind] || TX.quick.other) {
      const b = el("button", "gai-chip", q); b.type = "button";
      b.addEventListener("click", () => send(q));
      chips.appendChild(b);
    }
    intro.appendChild(chips);
    log.appendChild(intro);
  }
  function bubble(role, text, { error = false } = {}) {
    const intro = log.querySelector(".gai-intro"); if (intro) intro.remove();
    const m = el("div", "gai-msg " + (role === "user" ? "me" : "ai") + (error ? " error" : ""));
    const b = el("div", "gai-bubble");
    if (role === "assistant" && !error) b.appendChild(renderRich(text)); else b.textContent = text;
    m.appendChild(b); log.appendChild(m); scrollEnd();
    return m;
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch { return false; }
  }
  function actions(m, { copy, retry }) {
    const row = el("div", "gai-macts");
    const mk = (icon, label) => { const b = el("button", "gai-mact"); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.appendChild(ri(icon)); return b; };
    if (copy) {
      const b = mk("file-copy-line", TX.copy);
      b.addEventListener("click", async () => {
        const ok = await copyText(copy + "\n\n—— " + TX.disclaimer);
        if (!ok) return;
        b.replaceChildren(ri("check-line")); b.title = TX.copied; b.classList.add("done");
        setTimeout(() => { b.replaceChildren(ri("file-copy-line")); b.title = TX.copy; b.classList.remove("done"); }, 1500);
      });
      row.appendChild(b);
    }
    if (retry) { const b = mk("refresh-line", TX.retry); b.addEventListener("click", retry); row.appendChild(b); }
    m.appendChild(row);
  }
  function renderAll() {
    log.replaceChildren();
    if (!msgs.length) { renderIntro(); return; }
    for (const m of msgs) {
      const node = bubble(m.role, m.content);
      if (m.role === "assistant") actions(node, { copy: m.content });
    }
  }
  function refreshPage() {
    page = currentPage();
    ctxText.textContent = chipText(page);
    ctx.title = page.title || "";
    const p = location.pathname;
    if (p !== path && !busy) { path = p; msgs = loadChat(p); renderAll(); }
    else if (!msgs.length && !busy && !log.querySelector(".gai-msg")) { log.replaceChildren(); renderIntro(); } // 同一路径但页面类型变了：刷新快捷问题
  }

  async function send(raw) {
    const text = String(raw || "").trim().slice(0, LIM.content);
    if (!text || busy) return;
    refreshPage();
    const sendPath = path;
    input.value = ""; autosize();
    const entry = { role: "user", content: text };
    msgs.push(entry);
    const um = bubble("user", text);
    saveChat(sendPath, msgs);
    const pending = bubble("assistant", ""); pending.classList.add("pending");
    const pb = pending.querySelector(".gai-bubble");
    pb.replaceChildren(el("span", "gai-dots"), el("span", "", TX.thinking));
    const controller = new AbortController();
    const req = { controller };
    request = req; setBusy(true);
    // 失败 / 停止：这个问题不留在对话历史里（不混进后续上下文）；气泡保留，带「重试」——去掉这一问一答，用同样的问题重发
    const drop = () => {
      if (sendPath === path) { msgs = msgs.filter((m) => m !== entry); saveChat(path, msgs); return; }
      const l = loadChat(sendPath), last = l[l.length - 1];
      if (last && last.role === "user" && last.content === text) { l.pop(); saveChat(sendPath, l); }
    };
    const retry = (node) => () => { if (busy) return; node.remove(); um.remove(); send(text); };
    const finish = () => { if (request !== req) return; request = null; setBusy(false); refreshPage(); if (ui && ui.isOpen()) input.focus(); };
    req.stop = () => {
      controller.abort();
      drop();
      pending.classList.remove("pending");
      pb.textContent = TX.stopped;
      actions(pending, { retry: retry(pending) });
      finish();
    };
    try {
      const r = await fetch("/api/my/ai/assist", {
        method: "POST", credentials: "same-origin", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang: LANG, messages: forServer(msgs), page }),
      });
      const j = await r.json().catch(() => ({}));
      if (controller.signal.aborted) return;
      pending.remove();
      if (!r.ok || typeof j.reply !== "string" || !j.reply) {
        drop();
        if (r.status === 401) { cap = false; try { sessionStorage.removeItem(CAP_KEY); } catch { /* ignore */ } }
        let msg = TX.err;
        try { const { aiErrorText } = await import("./ai-panel.js"); msg = aiErrorText(r.status, j, LANG); } catch { /* 用默认文案 */ }
        const m = bubble("assistant", msg, { error: true });
        actions(m, { retry: retry(m) });
        return;
      }
      if (sendPath !== path) { saveChat(sendPath, [...loadChat(sendPath), { role: "assistant", content: j.reply }]); return; } // 等回复时换了页：存进原页面的对话，不画到当前页
      msgs.push({ role: "assistant", content: j.reply });
      saveChat(sendPath, msgs);
      const m = bubble("assistant", j.reply);
      actions(m, { copy: j.reply });
    } catch {
      if (controller.signal.aborted) return;
      drop();
      pending.remove();
      const m = bubble("assistant", TX.err, { error: true });
      actions(m, { retry: retry(m) });
    } finally {
      finish();
    }
  }

  foot.addEventListener("submit", (e) => { e.preventDefault(); if (busy) { if (request && request.stop) request.stop(); } else send(input.value); });
  input.addEventListener("input", () => { autosize(); syncSend(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(input.value); }
  });
  clearBtn.addEventListener("click", () => { if (busy) return; msgs = []; saveChat(path, msgs); renderAll(); input.focus(); });
  closeBtn.addEventListener("click", () => close(true));
  // 抽屉里打字时不触发页面自己的快捷键（看板的 / 、↵ 等）；⌘K / Esc 已在 window 捕获阶段处理
  panel.addEventListener("keydown", (e) => { e.stopPropagation(); });

  // 估值 AI 抽屉被打开（body.vc-ai-open）→ 收起这个；SPA 内换页（body 的 vd-mode 等 class 变化）→ 刷新上下文
  new MutationObserver(() => {
    if (!opened) return;
    if (document.body.classList.contains("vc-ai-open")) { close(false); return; }
    refreshPage();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("popstate", () => { if (opened) refreshPage(); });

  setBusy(false);
  let hideTimer = 0, opened = false;
  return {
    panel, drawModels, closeMenu,
    isOpen: () => opened,
    open({ restore = false } = {}) {
      clearTimeout(hideTimer); opened = true;
      refreshPage(); drawModels();
      panel.hidden = false; root.classList.add("gai-open"); remember(true);
      if (restore) { panel.classList.add("instant", "on"); void panel.offsetWidth; setTimeout(() => panel.classList.remove("instant"), 50); scrollEnd(); }
      else { void panel.offsetWidth; panel.classList.add("on"); } // 先排一次版再加 .on，滑入动画才会生效（不依赖 rAF，后台标签页也能开）
      for (const b of buttons) b.setAttribute("aria-expanded", "true");
      if (!restore) setTimeout(() => { if (!panel.hidden) { input.focus(); scrollEnd(); } }, 30);
    },
    close() {
      opened = false; closeMenu();
      panel.classList.remove("on"); root.classList.remove("gai-open"); remember(false);
      for (const b of buttons) b.setAttribute("aria-expanded", "false");
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;
      hideTimer = setTimeout(() => { if (!opened) panel.hidden = true; }, reduce ? 0 : 240);
    },
  };
}
