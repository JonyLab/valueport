// 全站共用轻量交互反馈（替代浏览器原生 alert / confirm）：
// - showToast(msg, { tone, duration }) — 底部浮现的暖调胶囊提示，不打断操作
// - confirmDialog({ message, confirmText, cancelText, danger }) — 暖调二次确认弹窗（支持 Esc / 点遮罩取消）
// - armSafeClick(btn, onConfirm, lang) — 行内二次点击防误碰（3 秒自动复位）

let styled = false;
function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = `
.vp-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;max-width:calc(100vw - 32px);transition:left .24s cubic-bezier(.22,1,.36,1)}
.vp-toast{pointer-events:auto;display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;background:var(--dark,#2a2a29);color:#f7f5ef;font-family:var(--font,inherit);font-size:13.5px;line-height:1.45;box-shadow:0 16px 40px -14px rgba(30,25,10,.45),0 0 0 1px rgba(255,255,255,.08);cursor:pointer;animation:vpToastIn .18s cubic-bezier(.22,1,.36,1) both;transition:opacity .16s ease,transform .16s ease}
.vp-toast.leaving{opacity:0;transform:translateY(6px) scale(.97);pointer-events:none}
.vp-toast.ok{background:#1f6f46}
.vp-toast.warn{background:#9c5316}
.vp-toast.bad{background:#a83333}
.vp-toast i{font-size:15px;flex:none}
.vp-toast-act{margin-left:6px;padding:3px 10px;border:0;border-radius:999px;background:rgba(255,255,255,.18);color:#fff;font-family:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:background .14s ease}
.vp-toast-act:hover{background:rgba(255,255,255,.3)}
.vp-toast-act:focus-visible{outline:none;box-shadow:0 0 0 2px var(--sun,#f6cf4a)}
@keyframes vpToastIn{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.vp-toast,.vp-toasts{animation:none;transition:none}}
.vp-cf-ov{position:fixed;inset:0;z-index:190;background:rgba(40,36,25,.32);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;padding:20px}
.vp-cf-box{margin:auto;width:min(420px,100%);background:#fbfaf6;border-radius:var(--r-xl,28px);box-shadow:0 40px 100px -30px rgba(40,35,20,.5);padding:22px 24px 20px;display:flex;flex-direction:column;gap:14px}
.vp-cf-msg{font-size:14.5px;line-height:1.65;color:var(--ink,#1d1d1b);white-space:pre-line}
.vp-cf-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.vp-cf-danger{background:var(--red,#c64141) !important;color:#fff !important;border-color:transparent !important}
.vp-cf-danger:hover{background:#ad3535 !important}
.vp-arm{transition:background .15s ease,color .15s ease,padding .15s ease}
.vp-arm.armed{background:rgba(198,65,65,.14) !important;color:var(--red,#c64141) !important;border-radius:999px !important;padding:0 10px !important;font-size:12px !important;width:auto !important}
`;
  document.head.appendChild(s);
}

export function showToast(message, { tone = "info", duration, action } = {}) {
  if (typeof document === "undefined" || !message) return;
  ensureStyles();
  let host = document.getElementById("vpToastHost");
  if (!host) { host = document.createElement("div"); host.id = "vpToastHost"; host.className = "vp-toasts"; host.setAttribute("aria-live", "polite"); document.body.appendChild(host); }
  // 最多同时保留 3 条，避免连续点击堆满屏幕
  while (host.children.length >= 3) host.firstElementChild.remove();
  const t = document.createElement("div");
  t.className = "vp-toast" + (tone && tone !== "info" ? " " + tone : "");
  t.setAttribute("role", "status");
  const icon = tone === "ok" ? "check-line" : tone === "warn" ? "error-warning-line" : tone === "bad" ? "close-circle-line" : "information-line";
  const i = document.createElement("i"); i.className = "ri-" + icon; i.setAttribute("aria-hidden", "true");
  t.append(i, document.createTextNode(String(message)));
  let timer = 0, closed = false;
  const reduce = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion:reduce)").matches;
  const rm = () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    if (reduce) { t.remove(); return; }
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 170);
  };
  if (action && action.label && typeof action.onClick === "function") {
    const ab = document.createElement("button"); ab.type = "button"; ab.className = "vp-toast-act"; ab.textContent = String(action.label);
    ab.addEventListener("click", (e) => { e.stopPropagation(); rm(); action.onClick(); });
    t.appendChild(ab);
  }
  t.addEventListener("click", rm);
  host.appendChild(t);
  const ms = duration !== undefined ? duration : (action ? 6000 : 3600);
  const arm = () => { if (ms > 0 && !closed) { clearTimeout(timer); timer = setTimeout(rm, ms); } };
  t.addEventListener("mouseenter", () => clearTimeout(timer));
  t.addEventListener("mouseleave", arm);
  arm();
}

export function confirmDialog({ message, confirmText, cancelText, danger = true, lang = "zh" } = {}) {
  if (typeof document === "undefined") return Promise.resolve(false);
  ensureStyles();
  const zh = lang !== "en";
  const prevFocus = document.activeElement;
  return new Promise((resolve) => {
    const ov = document.createElement("div"); ov.className = "vp-cf-ov";
    const box = document.createElement("div"); box.className = "vp-cf-box";
    box.setAttribute("role", "alertdialog"); box.setAttribute("aria-modal", "true");
    const msg = document.createElement("div"); msg.className = "vp-cf-msg"; msg.textContent = String(message || "");
    const foot = document.createElement("div"); foot.className = "vp-cf-foot";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn ghost sm"; cancel.textContent = cancelText || (zh ? "取消" : "Cancel");
    const ok = document.createElement("button"); ok.type = "button"; ok.className = "btn sm " + (danger ? "vp-cf-danger" : "primary"); ok.textContent = confirmText || (zh ? "确认" : "Confirm");
    const done = (v) => {
      document.removeEventListener("keydown", onKey, true);
      ov.remove();
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") prevFocus.focus();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); done(false); } };
    document.addEventListener("keydown", onKey, true);
    let downOnOv = false;
    ov.addEventListener("mousedown", (e) => { downOnOv = e.target === ov; });
    ov.addEventListener("click", (e) => { if (downOnOv && e.target === ov) done(false); downOnOv = false; });
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    foot.append(cancel, ok);
    box.append(msg, foot);
    ov.appendChild(box);
    document.body.appendChild(ov);
    cancel.focus();
  });
}

export function armSafeClick(btn, onConfirm, lang = "zh") {
  ensureStyles();
  const zh = lang !== "en";
  btn.classList.add("vp-arm");
  let timer = 0, armed = false;
  const orig = [...btn.childNodes].map((n) => n.cloneNode(true));
  const reset = () => {
    armed = false; clearTimeout(timer);
    btn.classList.remove("armed");
    btn.replaceChildren(...orig.map((n) => n.cloneNode(true)));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      btn.classList.add("armed");
      btn.textContent = zh ? "再点确认" : "Confirm";
      timer = setTimeout(reset, 3000);
      return;
    }
    reset();
    onConfirm();
  });
}
