// 反馈入口（全站共用）：顶栏语言按钮左边一个圆形图标按钮，只对已登录用户显示；点开弹窗填写类型 / 标题 / 描述。
// 提交：Worker 配了 GITHUB_TOKEN → POST /api/my/feedback 直接建 GitHub issue；
//       没配 → 打开 GitHub「新建 issue」页并预填内容（需要用户自己的 GitHub 账号）。
// 用法：mountFeedback(容器) → 按钮插在容器里的 .lang-menu 之前。样式在 /shared/styles.css 的 .fb-*。
import { LANG } from "./i18n.js";
import { TYPES, LIMITS, issueUrl, cleanMeta } from "./feedback-core.js";

const zh = LANG === "zh";
const TX = zh ? {
  btn: "反馈", title: "反馈", types: { bug: "问题", idea: "建议", other: "其他" },
  f_title: "标题", ph_title: "一句话说清楚", f_desc: "描述", ph_desc: "发生了什么？期望是什么样？（选填）",
  meta: "附上页面信息", meta_hint: "路径、语言、窗口尺寸、浏览器版本，不含账户和金额",
  pub: "反馈会公开发布在 GitHub 上，请不要填写账户、金额等个人信息。",
  pub_gh: "将打开 GitHub 的新建 issue 页面（需登录 GitHub），内容已预填好。",
  cancel: "取消", send: "提交", send_gh: "去 GitHub 提交", sending: "提交中…",
  ok: "已提交，谢谢反馈！", ok_sub: "我们会在 GitHub 上跟进。", view: "查看 issue", done: "完成",
  e_title: `标题至少 ${LIMITS.titleMin} 个字`, e_limit: "今天的反馈次数已用完，明天再来吧。",
  e_fail: "没能提交到 GitHub，可以改用 GitHub 页面提交。", e_net: "网络出错，请稍后再试。", e_login: "登录已过期，请重新登录。",
} : {
  btn: "Feedback", title: "Send feedback", types: { bug: "Bug", idea: "Idea", other: "Other" },
  f_title: "Title", ph_title: "Sum it up in one line", f_desc: "Description", ph_desc: "What happened, and what did you expect? (optional)",
  meta: "Include page info", meta_hint: "Path, language, window size and browser — no account data or amounts",
  pub: "Feedback is posted publicly on GitHub — please leave out account details, amounts and other personal data.",
  pub_gh: "This opens GitHub's new-issue page (sign in to GitHub) with everything prefilled.",
  cancel: "Cancel", send: "Submit", send_gh: "Continue on GitHub", sending: "Submitting…",
  ok: "Sent — thank you!", ok_sub: "We'll follow up on GitHub.", view: "View issue", done: "Done",
  e_title: `The title needs at least ${LIMITS.titleMin} characters`, e_limit: "You've reached today's feedback limit — try again tomorrow.",
  e_fail: "Couldn't file it on GitHub — you can submit on GitHub's page instead.", e_net: "Network error — please try again.", e_login: "Your session expired — please sign in again.",
};

const CAP_KEY = "fb_cap"; // sessionStorage：{ server, repo }，有就首帧显示按钮（退出登录会清空会话存储）
const buttons = new Set();
let cap = null, capP = null;
try { cap = JSON.parse(sessionStorage.getItem(CAP_KEY) || "null"); } catch { cap = null; }

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function ri(name) { const i = el("i", "ri-" + name); i.setAttribute("aria-hidden", "true"); return i; }
function syncButtons() { for (const b of buttons) { if (!b.isConnected) buttons.delete(b); else b.classList.toggle("hidden", !cap); } }

// 能力探测兼登录检查：401 = 没登录 → 不显示入口
function loadCap() {
  if (!capP) capP = fetch("/api/my/feedback", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { cap = j && typeof j.repo === "string" ? { server: !!j.server, repo: j.repo } : null; })
    .catch(() => { /* 网络失败：保留会话里的旧值 */ })
    .then(() => {
      try { cap ? sessionStorage.setItem(CAP_KEY, JSON.stringify(cap)) : sessionStorage.removeItem(CAP_KEY); } catch { /* ignore */ }
      syncButtons();
      return cap;
    });
  return capP;
}

export function mountFeedback(host) {
  const btn = el("button", "btn icon fb-btn" + (cap ? "" : " hidden"));
  btn.type = "button"; btn.title = TX.btn; btn.setAttribute("aria-label", TX.btn); btn.setAttribute("aria-haspopup", "dialog");
  btn.appendChild(ri("feedback-line"));
  btn.addEventListener("click", openModal);
  buttons.add(btn);
  // navboot.js 首帧可能已放过静态占位：原地替换；否则放在语言按钮前
  const stub = host.querySelector(".fb-btn[data-static]");
  if (stub) stub.replaceWith(btn);
  else host.insertBefore(btn, host.querySelector(":scope > .lang-menu"));
  loadCap();
  return btn;
}

/* ---------- 弹窗（整页一个，首次打开时创建） ---------- */
let ui = null, lastFocus = null;
function pageInfo() {
  return cleanMeta({ path: location.pathname, lang: LANG, viewport: `${innerWidth}x${innerHeight}`, ua: navigator.userAgent });
}
function build() {
  const ov = el("div", "fb-overlay hidden");
  const m = el("div", "fb-modal"); m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true"); m.setAttribute("aria-labelledby", "fbTitle");
  const top = el("div", "fb-top"); const h = el("span", "fb-title", TX.title); h.id = "fbTitle";
  const x = el("button", "btn icon sm fb-close"); x.type = "button"; x.setAttribute("aria-label", TX.cancel); x.appendChild(ri("close-line"));
  top.append(h, x);

  const form = el("div", "fb-form");
  const types = el("div", "chips fb-types"); types.setAttribute("role", "radiogroup");
  const chips = {};
  for (const k of TYPES) {
    const c = el("button", "chip", TX.types[k]); c.type = "button"; c.setAttribute("role", "radio");
    c.addEventListener("click", () => setType(k));
    chips[k] = c; types.appendChild(c);
  }
  const fTitle = el("label", "field"); fTitle.append(el("span", "f-lab", TX.f_title));
  const title = el("input", "plain"); title.maxLength = LIMITS.title; title.placeholder = TX.ph_title; title.autocomplete = "off"; fTitle.appendChild(title);
  const fDesc = el("label", "field"); fDesc.append(el("span", "f-lab", TX.f_desc));
  const desc = el("textarea"); desc.maxLength = LIMITS.description; desc.rows = 5; desc.placeholder = TX.ph_desc; fDesc.appendChild(desc);
  const metaRow = el("label", "fb-check");
  const metaBox = el("input"); metaBox.type = "checkbox"; metaBox.checked = true;
  const metaText = el("span"); metaText.append(el("span", "", TX.meta), el("span", "fb-hint", TX.meta_hint));
  metaRow.append(metaBox, metaText);
  const note = el("div", "fb-note"); const noteText = el("span");
  note.append(ri("information-line"), noteText);
  const err = el("div", "fb-err"); err.setAttribute("role", "alert");
  form.append(types, fTitle, fDesc, metaRow, note, err);

  const done = el("div", "fb-done hidden");
  const doneIco = el("div", "fb-done-ico"); doneIco.appendChild(ri("check-line"));
  const link = el("a", "btn sm fb-link"); link.target = "_blank"; link.rel = "noopener";
  done.append(doneIco, el("div", "fb-done-title", TX.ok), el("div", "fb-hint", TX.ok_sub), link);

  const foot = el("div", "fb-foot");
  const cancel = el("button", "btn ghost", TX.cancel); cancel.type = "button";
  const send = el("button", "btn primary"); send.type = "button";
  foot.append(cancel, send);
  m.append(top, form, done, foot);
  ov.appendChild(m);
  document.body.appendChild(ov);

  let type = "bug", busy = false, sent = false;
  function setType(k) { type = k; for (const [kk, c] of Object.entries(chips)) { c.classList.toggle("on", kk === k); c.setAttribute("aria-checked", kk === k ? "true" : "false"); } }
  function mode() { return cap && cap.server ? "server" : "github"; }
  function paint() {
    noteText.textContent = mode() === "server" ? TX.pub : TX.pub_gh + " " + TX.pub;
    send.replaceChildren(document.createTextNode(busy ? TX.sending : mode() === "server" ? TX.send : TX.send_gh));
    if (!busy && mode() === "github") send.appendChild(ri("external-link-line"));
    send.disabled = busy;
  }
  function showErr(msg) { err.textContent = msg || ""; err.style.display = msg ? "block" : "none"; }
  function fields() {
    return { type, title: title.value.replace(/\s+/g, " ").trim(), description: desc.value.trim(), meta: metaBox.checked ? pageInfo() : null };
  }
  async function submit() {
    if (busy) return;
    if (sent) return close();
    const fb = fields();
    if (fb.title.length < LIMITS.titleMin) { showErr(TX.e_title); title.focus(); return; }
    showErr("");
    // 去 GitHub 页面：直接在这次点击里打开新标签（不经过 await，避免被拦截弹窗）
    if (mode() === "github") { window.open(issueUrl(cap && cap.repo, fb), "_blank", "noopener"); close(); return; }
    busy = true; paint();
    try {
      const r = await fetch("/api/my/feedback", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(fb) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        sent = true;
        link.replaceChildren(document.createTextNode(j.number ? `${TX.view} #${j.number}` : TX.view), ri("external-link-line"));
        link.href = j.url;
        form.classList.add("hidden"); done.classList.remove("hidden"); cancel.classList.add("hidden");
        busy = false; send.replaceChildren(document.createTextNode(TX.done)); send.disabled = false;
        return;
      }
      if (r.status === 501 || r.status === 502) { cap = { server: false, repo: j.repo || (cap && cap.repo) }; showErr(r.status === 502 ? TX.e_fail : ""); }
      else if (r.status === 429) showErr(TX.e_limit);
      else if (r.status === 401) showErr(TX.e_login);
      else showErr(j.error || TX.e_net);
    } catch { showErr(TX.e_net); }
    busy = false; paint();
  }
  function open() {
    sent = false; busy = false; title.value = ""; desc.value = ""; metaBox.checked = true; setType("bug"); showErr("");
    form.classList.remove("hidden"); done.classList.add("hidden"); cancel.classList.remove("hidden");
    paint(); ov.classList.remove("hidden");
    setTimeout(() => title.focus(), 0);
  }
  function close() { ov.classList.add("hidden"); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  x.addEventListener("click", close); cancel.addEventListener("click", close); send.addEventListener("click", submit);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 弹窗里打字时不触发页面自己的快捷键（看板的 esc / ↵ 等）
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.target === title)) { e.preventDefault(); submit(); }
  });
  return { open, paint };
}
async function openModal(e) {
  lastFocus = e && e.currentTarget;
  if (!ui) ui = build();
  ui.open();
  await loadCap(); ui.paint(); // 首次打开时可能还没拿到能力探测结果，拿到后刷新按钮文案
}
