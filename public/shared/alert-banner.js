// 共用视觉组件（/portfolio 与 /macro 统一风格，同一件事处处一样）：
// 1. renderAlertChart       — 近 5 年月度走势 + 阈值虚线 + 触发区浅黄阴影 + 0–100% 历史分位条
// 2. renderActionStrip      — 克制、可展开/收回的首屏待办行动条（不抢首屏重心，按下去有回应，再按能收回）
// 3. renderAllocationBar    — 100% 彩色堆叠分布条（用于配置弹窗实时反馈 & 再平衡 Before→After 对比）
// 4. openQuickAlertModal    — Chart-First 就地设提醒浮层（在 /macro 点铃铛当场拉滑块保存，不打断浏览）
// 5. wireSafeDelete         — 二次点击确认防误碰按钮（第一次点变「再点确认」，3 秒自动复位，零原生 confirm）

import { alertMetricMeta, extractAlertSeries, evaluateSignalAlerts, metricQuickPresets } from "./rebalance.js";

const BAR_COLORS = ["#2a2a29", "#f6cf4a", "#3a73ee", "#2ea35d", "#f08c2e", "#8f8c84", "#7a5c3a"];

let cssDone = false;
export function ensureAlertBannerStyles() {
  if (cssDone || typeof document === "undefined") return;
  cssDone = true;
  const st = document.createElement("style");
  st.textContent = `
/* 统一待办行动条（单行紧凑，点开看详情和图，再点收回） */
.vp-strip{margin:0 0 16px;border-radius:var(--r-xl);background:rgba(255,255,255,.72);border:1px solid rgba(246,207,74,.65);box-shadow:var(--shadow);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);overflow:hidden}
.vp-strip.alert{background:linear-gradient(90deg,rgba(246,207,74,.24),rgba(255,255,255,.76) 45%)}
.vp-strip-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;cursor:pointer;user-select:none}
.vp-strip-bar:hover{background:rgba(246,207,74,.08)}
.vp-strip-main{display:flex;align-items:center;gap:10px;min-width:0;flex:1;flex-wrap:wrap}
.vp-strip-dot{width:28px;height:28px;border-radius:50%;background:var(--sun);color:var(--sun-ink);display:inline-flex;align-items:center;justify-content:center;font-size:15px;flex:none}
.vp-strip-text{font-size:13.5px;color:var(--ink);line-height:1.45;min-width:0}
.vp-strip-text b{font-weight:500}
.vp-strip-meta{font-size:12.5px;color:var(--ink-soft)}
.vp-strip-acts{display:flex;align-items:center;gap:6px;flex:none}
.vp-strip-tog{display:inline-flex;align-items:center;gap:3px;height:30px;padding:0 10px;border:0;border-radius:var(--r-pill);background:var(--track);color:var(--ink-soft);cursor:pointer;font-family:var(--font);font-size:12.5px}
.vp-strip-tog:hover{background:var(--track-edge);color:var(--ink)}
.vp-strip-body{padding:0 16px 14px;display:flex;flex-direction:column;gap:10px;border-top:1px dashed rgba(59,48,0,.15)}
.vp-strip-body[hidden]{display:none}
.vp-abanner-row{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding-top:10px}
.vp-abanner-row + .vp-abanner-row{border-top:1px dashed rgba(59,48,0,.14)}
.vp-abanner-left{flex:1;min-width:220px;display:flex;flex-direction:column;gap:7px;font-size:13.5px;line-height:1.55;color:var(--ink-soft)}
.vp-abanner-left b{color:var(--ink);font-weight:500}
.vp-abanner-btnrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vp-abanner-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:50%;background:transparent;color:var(--ink-mute);cursor:pointer;font-size:15px}
.vp-abanner-close:hover{background:var(--track);color:var(--ink)}

/* 走势小图 + 阈值虚线 + 分位条 */
.pf-achart{display:flex;flex-direction:column;gap:5px;width:248px;max-width:100%;padding:8px 10px 7px;border-radius:var(--r-md);background:rgba(255,255,255,.85);box-shadow:inset 0 0 0 1px rgba(29,29,27,.08);flex:none}
.pf-achart.wide{width:100%;margin-top:2px;background:rgba(255,255,255,.72)}
.pf-achart.tall .pf-achart-box{height:84px}
.pf-achart-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;color:var(--ink-mute);font-variant-numeric:tabular-nums}
.pf-achart-top b{color:var(--ink);font-weight:500}
.pf-achart-top .th{color:#a4561a;font-weight:500}
.pf-achart-box{position:relative;height:52px}
.pf-achart-svg{width:100%;height:100%;display:block;overflow:visible}
.pf-achart-zone{fill:rgba(246,207,74,.28)}
.pf-achart-area{fill:rgba(29,29,27,.06)}
.pf-achart-line{fill:none;stroke:var(--ink);stroke-width:1.75;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.pf-achart-th{stroke:#c66919;stroke-width:1.35;stroke-dasharray:4 3;vector-effect:non-scaling-stroke}
.pf-achart-dot{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 2px #fff;pointer-events:none}
.pf-achart-dot.hit{background:var(--sun);box-shadow:0 0 0 2px var(--ink)}
.pf-achart-pct{position:relative;height:8px;border-radius:var(--r-pill);background:rgba(29,29,27,.08);margin-top:2px}
.pf-achart-pct-z{position:absolute;top:0;bottom:0;border-radius:var(--r-pill);background:rgba(246,207,74,.65)}
.pf-achart-pct-d{position:absolute;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 2px #fff}
.pf-achart-pct-d.hit{background:#c66919}
.pf-achart-foot{display:flex;justify-content:space-between;font-size:10.5px;color:var(--ink-mute);font-variant-numeric:tabular-nums}

/* 100% 彩色堆叠比例条（配置弹窗 & 再平衡 Before→After 共用） */
.vp-abar{display:flex;flex-direction:column;gap:6px}
.vp-abar-row{display:flex;align-items:center;gap:10px}
.vp-abar-lbl{font-size:12px;color:var(--ink-mute);width:54px;flex:none}
.vp-abar-track{flex:1;height:12px;border-radius:var(--r-pill);background:var(--track);display:flex;gap:2px;overflow:hidden;padding:1px}
.vp-abar-track.over{box-shadow:0 0 0 1.5px var(--red)}
.vp-abar-seg{height:100%;border-radius:var(--r-pill);transition:width .18s ease}
.vp-abar-rest{height:100%;border-radius:var(--r-pill);background-image:repeating-linear-gradient(-45deg,rgba(29,29,27,.08) 0 4px,transparent 4px 8px)}
.vp-abar-leg{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12px;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.vp-abar-leg span{display:inline-flex;align-items:center;gap:5px}
.vp-abar-leg i{width:8px;height:8px;border-radius:50%;flex:none}
.vp-abar-leg .bad{color:var(--red);font-weight:500}

/* 就地设提醒浮层（Chart-First Quick Alert Modal） */
.vp-qov{position:fixed;inset:0;z-index:95;background:rgba(40,36,25,.32);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;padding:18px}
.vp-qov[hidden]{display:none}
.vp-qmod{margin:auto;width:min(520px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fbfaf6;border-radius:var(--r-xl);box-shadow:0 40px 100px -30px rgba(40,35,20,.5);padding:22px 22px 20px;display:flex;flex-direction:column;gap:12px}
.vp-qtop{display:flex;align-items:center;justify-content:space-between;gap:10px}
.vp-qtitle{font-size:19px;font-weight:500}
.vp-qchips{display:flex;flex-wrap:wrap;gap:6px}
.vp-qchip{height:29px;padding:0 12px;border:0;border-radius:var(--r-pill);background:rgba(246,207,74,.22);color:var(--sun-ink);font-family:var(--font);font-size:12.5px;cursor:pointer}
.vp-qchip:hover{background:rgba(246,207,74,.38)}
.vp-qchip.on{background:var(--dark);color:#fff}
.vp-qslider{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--r-md);background:rgba(29,29,27,.035)}
.vp-qslider input[type="range"]{flex:1;accent-color:var(--dark);cursor:pointer}
.vp-qslider input[type="number"]{width:76px;height:34px;padding:0 9px;border:0;border-radius:var(--r-sm);background:#fff;box-shadow:inset 0 0 0 1px var(--divider);font-family:var(--font);font-size:13.5px;font-variant-numeric:tabular-nums}
.vp-qslider select{height:34px;padding:0 8px;border:0;border-radius:var(--r-sm);background:#fff;box-shadow:inset 0 0 0 1px var(--divider);font-family:var(--font);font-size:12.5px}
.vp-qinput{width:100%;height:38px;padding:0 12px;border:0;border-radius:var(--r-sm);background:#fff;box-shadow:inset 0 0 0 1px var(--divider);font-family:var(--font);font-size:13.5px;color:var(--ink)}
.vp-qinput:focus{outline:none;box-shadow:inset 0 0 0 1px var(--ring-border),0 0 0 3px var(--ring)}
.vp-qfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;padding-top:12px;border-top:1px dashed var(--border)}
.vp-qfoot-r{display:flex;gap:8px;margin-left:auto}
.vp-qerr{font-size:12.5px;color:var(--red);min-height:16px}
.vp-safe-del.armed{background:rgba(198,65,65,.14) !important;color:var(--red) !important;border-radius:var(--r-pill) !important;padding:0 10px !important;font-size:12px !important;width:auto !important}
@media (max-width:600px){ .pf-achart{width:100%} .vp-strip-bar{flex-wrap:wrap} }
`;
  document.head.appendChild(st);
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ri = (name) => { const i = document.createElement("i"); i.className = "ri-" + name; i.setAttribute("aria-hidden", "true"); return i; };

// 防误碰的二次点击删除（按一次变「再点确认」，3 秒自动复位，不弹原生 confirm）
export function wireSafeDelete(btn, onConfirm, lang = "zh") {
  ensureAlertBannerStyles();
  const zh = lang !== "en";
  let timer = 0, armed = false;
  const orig = [...btn.childNodes].map((n) => n.cloneNode(true));
  const reset = () => {
    armed = false;
    clearTimeout(timer);
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

export function formatAlertCond(a, lang = "zh") {
  const zh = lang !== "en", T = (x, y) => (zh ? x : y);
  const opTxt = a.op === "gte" ? "≥" : "≤";
  if (a.mode === "pct") return T(`历史 ${a.threshold}% 分位${a.op === "gte" ? "以上" : "以下"}`, `${opTxt} ${a.threshold}th pct`);
  const unit = (a.meta && a.meta.unit) || "";
  return `${opTxt} ${a.threshold}${unit}`;
}

export function formatAlertReading(a, lang = "zh") {
  const zh = lang !== "en", T = (x, y) => (zh ? x : y);
  if (!a.available) return T("暂缺数据", "Unavailable");
  const u = a.reading.unit || "";
  if (a.mode === "pct") {
    const valPart = a.meta && !a.meta.level && Number.isFinite(a.reading.value) ? `（${a.reading.value}${u}）` : "";
    return T(`历史 ${a.actual}% 分位${valPart}`, `${a.actual}th pct` + (valPart ? ` (${a.reading.value}${u})` : ""));
  }
  const pctPart = Number.isFinite(a.reading.pct) ? T(`（历史 ${a.reading.pct}% 分位）`, ` (${a.reading.pct}th pct)`) : "";
  return `${a.actual}${u}${pctPart}`;
}

// 100% 彩色堆叠条：items = [{ label, pct, color? }]
export function renderAllocationBar(items = [], { title = "", showLegend = true, lang = "zh" } = {}) {
  ensureAlertBannerStyles();
  const zh = lang !== "en", T = (x, y) => (zh ? x : y);
  const wrap = el("div", "vp-abar");
  const row = el("div", "vp-abar-row");
  if (title) row.appendChild(el("span", "vp-abar-lbl", title));
  const list = items.filter((x) => Number.isFinite(x.pct) && x.pct > 0);
  const sum = list.reduce((s, x) => s + x.pct, 0);
  const over = sum > 100.05;
  const scale = over ? sum : 100;
  const track = el("div", "vp-abar-track" + (over ? " over" : ""));
  list.forEach((x, i) => {
    const seg = el("span", "vp-abar-seg");
    seg.style.width = (x.pct / scale * 100).toFixed(2) + "%";
    seg.style.background = x.color || BAR_COLORS[i % BAR_COLORS.length];
    seg.title = `${x.label} ${x.pct.toFixed(1)}%`;
    track.appendChild(seg);
  });
  if (!over && sum < 99.95) {
    const rest = el("span", "vp-abar-rest");
    rest.style.width = (100 - sum).toFixed(2) + "%";
    rest.title = T(`未分配 ${(100 - sum).toFixed(1)}%`, `${(100 - sum).toFixed(1)}% unallocated`);
    track.appendChild(rest);
  }
  row.appendChild(track);
  wrap.appendChild(row);
  if (showLegend) {
    const leg = el("div", "vp-abar-leg");
    list.forEach((x, i) => {
      const sp = el("span"); const dot = el("i"); dot.style.background = x.color || BAR_COLORS[i % BAR_COLORS.length];
      sp.append(dot, document.createTextNode(`${x.label} ${x.pct.toFixed(1)}%`));
      leg.appendChild(sp);
    });
    if (over) leg.appendChild(el("span", "bad", T(`已超出 ${(sum - 100).toFixed(1)}%`, `Over by ${(sum - 100).toFixed(1)}%`)));
    else if (sum > 0 && sum < 99.95) leg.appendChild(el("span", "", T(`未分配 ${(100 - sum).toFixed(1)}%`, `${(100 - sum).toFixed(1)}% left`)));
    wrap.appendChild(leg);
  }
  return wrap;
}

// 指标提醒走势小图：近 5 年月度折线 + 触发区浅黄阴影 + 阈值虚线 + 当前点（+ 历史分位条）
export function renderAlertChart(a, macroData, { wide = false, tall = false, lang = "zh" } = {}) {
  ensureAlertBannerStyles();
  const zh = lang !== "en", T = (x, y) => (zh ? x : y);
  const ser = extractAlertSeries(macroData, a.metric, a.mode, Number(a.threshold), 60);
  const showPctBar = a.mode === "pct" && Number.isFinite(a.reading?.pct);
  if (!ser && !showPctBar) return null;

  const card = el("div", "pf-achart" + (wide ? " wide" : "") + (tall ? " tall" : ""));
  const u = (ser && ser.unit) || (a.meta && a.meta.unit) || "";
  if (ser) {
    const top = el("div", "pf-achart-top");
    const thTxt = Number.isFinite(ser.thresholdVal)
      ? T(`触发线 ${a.op === "gte" ? "≥" : "≤"} ${ser.thresholdVal.toFixed(ser.unit === "x" ? 1 : 2)}${u}`, `${a.op === "gte" ? "≥" : "≤"} ${ser.thresholdVal.toFixed(ser.unit === "x" ? 1 : 2)}${u}`)
      : "";
    top.append(el("span", "th", thTxt), el("span", "", T("当前 ", "Now ") + `${ser.current}${u}`));
    card.appendChild(top);

    const W = 240, H = tall ? 84 : 52, PT = 6, PB = 6;
    const pad = (ser.max - ser.min) * 0.14 || Math.abs(ser.max) * 0.08 || 0.5;
    const lo = ser.min - pad, hi = ser.max + pad;
    const pts = ser.points;
    const X = (i) => (i / Math.max(1, pts.length - 1)) * W;
    const Y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
    const NS = "http://www.w3.org/2000/svg";
    const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    const svg = mk("svg", { viewBox: `0 0 ${W} ${H}`, class: "pf-achart-svg", preserveAspectRatio: "none" });

    if (Number.isFinite(ser.thresholdVal)) {
      const ty = Math.max(PT, Math.min(H - PB, Y(ser.thresholdVal)));
      if (a.op === "lte") svg.appendChild(mk("rect", { x: 0, y: ty, width: W, height: Math.max(0, H - ty), class: "pf-achart-zone" }));
      else svg.appendChild(mk("rect", { x: 0, y: 0, width: W, height: Math.max(0, ty), class: "pf-achart-zone" }));
    }
    const d = pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
    svg.appendChild(mk("path", { d: `${d}L${W},${H}L0,${H}Z`, class: "pf-achart-area" }));
    svg.appendChild(mk("path", { d, class: "pf-achart-line" }));
    if (Number.isFinite(ser.thresholdVal)) {
      const ty = Math.max(PT, Math.min(H - PB, Y(ser.thresholdVal)));
      svg.appendChild(mk("line", { x1: 0, x2: W, y1: ty.toFixed(1), y2: ty.toFixed(1), class: "pf-achart-th" }));
    }
    const box = el("div", "pf-achart-box");
    const dot = el("span", "pf-achart-dot" + (a.triggered ? " hit" : ""));
    dot.style.left = "100%";
    dot.style.top = (Y(ser.current) / H * 100).toFixed(1) + "%";
    box.append(svg, dot);
    card.appendChild(box);

    const foot = el("div", "pf-achart-foot");
    const rangeLbl = ser.fromDate && ser.toDate ? `${ser.fromDate.slice(0, 7)} – ${ser.toDate.slice(0, 7)}` : T(`近 ${pts.length} 个月`, `Last ${pts.length}m`);
    foot.append(el("span", "", rangeLbl), el("span", "", `${T("区间", "Range")} ${Math.min(...pts.map((p) => p[1])).toFixed(1)}–${Math.max(...pts.map((p) => p[1])).toFixed(1)}${u}`));
    card.appendChild(foot);
  }
  if (showPctBar) {
    const bar = el("div", "pf-achart-pct");
    const z = el("span", "pf-achart-pct-z");
    const th = Math.max(0, Math.min(100, Number(a.threshold) || 0));
    if (a.op === "gte") { z.style.left = th + "%"; z.style.width = (100 - th) + "%"; }
    else { z.style.left = "0%"; z.style.width = th + "%"; }
    const dot = el("span", "pf-achart-pct-d" + (a.triggered ? " hit" : ""));
    dot.style.left = Math.max(0, Math.min(100, a.reading.pct)) + "%";
    bar.append(z, dot);
    const pf = el("div", "pf-achart-foot");
    pf.append(el("span", "", T("历史 0%", "0%")), el("span", "", T(`当前 ${a.reading.pct}% 分位`, `Now ${a.reading.pct}th pct`)), el("span", "", "100%"));
    card.append(bar, pf);
  }
  return card;
}

// 克制的首屏待办行动条（单行起步，点击展开走势图详情，再点收回；可本次会话关闭）
export function renderActionStrip({
  triggered = [],
  offCount = 0,
  scheduleOverdue = false,
  scheduleLabel = "",
  macroData = null,
  lang = "zh",
  storageKey = "vp_strip_dismiss",
  defaultExpanded = false,
  onAction,
  onRebalance,
  onManage,
} = {}) {
  const hasAnything = triggered.length > 0 || offCount > 0 || scheduleOverdue;
  if (!hasAnything) return null;
  ensureAlertBannerStyles();
  const zh = lang !== "en", T = (x, y) => (zh ? x : y);
  const sig = [triggered.map((a) => `${a.id}:${a.actual}`).sort().join(","), offCount, scheduleOverdue ? 1 : 0].join("|");
  try { if (sessionStorage.getItem(storageKey) === sig) return null; } catch {}

  const strip = el("section", "vp-strip" + (triggered.length ? " alert" : ""));
  const bar = el("div", "vp-strip-bar");
  const main = el("div", "vp-strip-main");
  const ico = el("span", "vp-strip-dot");
  ico.appendChild(ri(triggered.length ? "notification-3-fill" : scheduleOverdue ? "calendar-check-line" : "scales-3-line"));
  main.appendChild(ico);

  const summaryParts = [];
  if (triggered.length) {
    const first = triggered[0];
    const mName = first.meta ? (zh ? first.meta.zh : first.meta.en) : first.metric;
    summaryParts.push(T(`${mName} ${formatAlertReading(first, lang)}（已触及提醒）`, `${mName} ${formatAlertReading(first, lang)} (alert)`));
    if (triggered.length > 1) summaryParts.push(T(`另有 ${triggered.length - 1} 条指标提醒`, `+${triggered.length - 1} more alert(s)`));
  }
  if (offCount > 0) summaryParts.push(T(`${offCount} 项仓位偏离目标`, `${offCount} off target`));
  if (scheduleOverdue) summaryParts.push(scheduleLabel || T("定期复盘已到期", "Periodic review due"));

  const txt = el("div", "vp-strip-text");
  txt.append(el("b", "", summaryParts[0]));
  if (summaryParts.length > 1) txt.append(el("span", "vp-strip-meta", " · " + summaryParts.slice(1).join(" · ")));
  main.appendChild(txt);

  const acts = el("div", "vp-strip-acts");
  let expanded = defaultExpanded && triggered.length > 0;
  let body = null;
  let tog = null;

  if (triggered.length) {
    tog = el("button", "vp-strip-tog"); tog.type = "button";
    const syncTog = () => {
      tog.replaceChildren(document.createTextNode(expanded ? T("收起", "Hide") : T("看图与详情", "Details")), ri(expanded ? "arrow-up-s-line" : "arrow-down-s-line"));
      if (body) body.hidden = !expanded;
    };
    tog.addEventListener("click", (e) => { e.stopPropagation(); expanded = !expanded; syncTog(); });
    acts.appendChild(tog);
    bar.addEventListener("click", () => { expanded = !expanded; syncTog(); });
  } else if (onRebalance) {
    bar.addEventListener("click", () => onRebalance());
  }

  if (onRebalance) {
    const go = el("button", "btn sm primary", T("去再平衡 →", "Rebalance →")); go.type = "button";
    go.addEventListener("click", (e) => { e.stopPropagation(); onRebalance(); });
    acts.appendChild(go);
  }
  const close = el("button", "vp-abanner-close"); close.type = "button";
  close.setAttribute("aria-label", T("本次先收起", "Dismiss for this session"));
  close.title = close.getAttribute("aria-label");
  close.appendChild(ri("close-line"));
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    try { sessionStorage.setItem(storageKey, sig); } catch {}
    strip.remove();
  });
  acts.appendChild(close);
  bar.append(main, acts);
  strip.appendChild(bar);

  if (triggered.length) {
    body = el("div", "vp-strip-body");
    body.hidden = !expanded;
    for (const a of triggered) {
      const row = el("div", "vp-abanner-row");
      const left = el("div", "vp-abanner-left");
      const mName = a.meta ? (zh ? a.meta.zh : a.meta.en) : a.metric;
      const p = el("div");
      p.append(el("b", "", mName), document.createTextNode(` · ${formatAlertReading(a, lang)}（${formatAlertCond(a, lang)}）${a.note ? " — " + a.note : ""}`));
      left.appendChild(p);
      const brow = el("div", "vp-abanner-btnrow");
      if (onAction) {
        const label = a.suggestProfile
          ? T(`按「${a.suggestProfile.name}」预览再平衡 →`, `Preview "${a.suggestProfile.name}" →`)
          : T("打开再平衡工作台 →", "Open Rebalance →");
        const btn = el("button", "btn sm primary", label); btn.type = "button";
        btn.addEventListener("click", () => onAction(a));
        brow.appendChild(btn);
      }
      if (onManage) {
        const mg = el("button", "btn sm ghost", T("调整提醒", "Edit alerts")); mg.type = "button";
        mg.addEventListener("click", onManage);
        brow.appendChild(mg);
      }
      if (brow.childNodes.length) left.appendChild(brow);
      row.appendChild(left);
      const chart = renderAlertChart(a, macroData, { lang });
      if (chart) row.appendChild(chart);
      body.appendChild(row);
    }
    strip.appendChild(body);
    if (tog) tog.replaceChildren(document.createTextNode(expanded ? T("收起", "Hide") : T("看图与详情", "Details")), ri(expanded ? "arrow-up-s-line" : "arrow-down-s-line"));
  }
  return strip;
}

// 兼容旧名称导出
export function renderAlertBanner(opts) {
  return renderActionStrip({ ...opts, defaultExpanded: true });
}

// ---------- Chart-First 就地设提醒浮层（在 /macro 点铃铛直接拉线保存，不打断浏览） ----------
export function openQuickAlertModal({ metricKey, macroData, plan, lang = "zh", onSaved } = {}) {
  ensureAlertBannerStyles();
  const zh = lang !== "en", T = (a, b) => (zh ? a : b);
  const meta = alertMetricMeta(metricKey);
  if (!meta) return;

  const existingList = Array.isArray(plan?.signalAlerts) ? plan.signalAlerts : [];
  const existing = existingList.find((a) => a.metric === metricKey) || null;
  const presets = metricQuickPresets(metricKey, lang);
  const profiles = Array.isArray(plan?.profiles) ? plan.profiles : [];
  const baseSer = extractAlertSeries(macroData, metricKey, meta.modes[0], null, 60);

  const draft = existing
    ? { ...existing }
    : {
      id: "a_" + Math.random().toString(36).slice(2, 8),
      enabled: true,
      metric: metricKey,
      mode: presets[0]?.mode || meta.modes[0],
      op: presets[0]?.op || (meta.modes[0] === "pct" ? "gte" : "lte"),
      threshold: presets[0]?.threshold ?? (meta.modes[0] === "pct" ? 90 : (baseSer ? Math.round(baseSer.current * 10) / 10 : 2.0)),
      note: presets[0]?.note || "",
      suggestProfileId: "",
    };

  const ov = el("div", "vp-qov");
  const mod = el("div", "vp-qmod"); mod.setAttribute("role", "dialog"); mod.setAttribute("aria-modal", "true");
  const close = () => { document.removeEventListener("keydown", onEsc); ov.remove(); };
  const onEsc = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onEsc);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });

  const top = el("div", "vp-qtop");
  const title = el("span", "vp-qtitle", (zh ? meta.zh : meta.en) + T(" · 提醒", " · Alert"));
  const xBtn = el("button", "btn icon sm modal-close"); xBtn.type = "button"; xBtn.appendChild(ri("close-line"));
  xBtn.addEventListener("click", close);
  top.append(title, xBtn);

  const chartHost = el("div");
  const statusLine = el("div", "pf-rule-live");

  const chips = el("div", "vp-qchips");
  const renderChips = () => {
    chips.innerHTML = "";
    for (const p of presets) {
      const on = draft.mode === p.mode && draft.op === p.op && Number(draft.threshold) === Number(p.threshold);
      const b = el("button", "vp-qchip" + (on ? " on" : ""), p.label); b.type = "button";
      b.addEventListener("click", () => {
        draft.mode = p.mode; draft.op = p.op; draft.threshold = p.threshold;
        if (!draft.note) draft.note = p.note;
        syncControls();
      });
      chips.appendChild(b);
    }
  };

  // 条件 + 滑块 + 精确数字（拖动滑块，上面的图实时跟着动！）
  const sliderBox = el("div", "vp-qslider");
  const condSel = el("select");
  if (meta.modes.includes("pct")) {
    condSel.append(Object.assign(el("option", "", T("历史分位 ≥", "Pct ≥")), { value: "pct:gte" }), Object.assign(el("option", "", T("历史分位 ≤", "Pct ≤")), { value: "pct:lte" }));
  }
  if (meta.modes.includes("value")) {
    condSel.append(Object.assign(el("option", "", T("当前值 ≥", "Value ≥")), { value: "value:gte" }), Object.assign(el("option", "", T("当前值 ≤", "Value ≤")), { value: "value:lte" }));
  }
  const rangeIn = el("input"); rangeIn.type = "range";
  const numIn = el("input"); numIn.type = "number"; numIn.inputMode = "decimal";
  const unitSpan = el("span", "");
  sliderBox.append(condSel, rangeIn, numIn, unitSpan);

  const noteIn = el("input", "vp-qinput"); noteIn.type = "text"; noteIn.maxLength = 120;
  noteIn.placeholder = T("触发时提醒自己做什么（可选）", "Note to show when triggered (optional)");
  noteIn.value = draft.note || "";
  noteIn.addEventListener("input", () => { draft.note = noteIn.value; });

  let profSel = null;
  if (profiles.length) {
    profSel = el("select", "vp-qinput");
    profSel.appendChild(Object.assign(el("option", "", T("触发时不关联特定配置方案", "Do not suggest a specific profile")), { value: "" }));
    for (const p of profiles) {
      const o = el("option", "", T(`触发时推荐切到「${p.name}」`, `Suggest switching to "${p.name}"`)); o.value = p.id;
      if (draft.suggestProfileId === p.id) o.selected = true;
      profSel.appendChild(o);
    }
    profSel.addEventListener("change", () => { draft.suggestProfileId = profSel.value || ""; });
  }

  const errEl = el("div", "vp-qerr");
  const foot = el("div", "vp-qfoot");
  const footR = el("div", "vp-qfoot-r");
  const cancelBtn = el("button", "btn ghost sm", T("取消", "Cancel")); cancelBtn.type = "button"; cancelBtn.addEventListener("click", close);
  const saveBtn = el("button", "btn primary sm", T("保存提醒", "Save alert")); saveBtn.type = "button";

  async function persist(nextAlerts) {
    errEl.textContent = "";
    saveBtn.disabled = true;
    const basePlan = plan || { targets: {}, cash: null, band: 5, rel: 25 };
    const payload = { ...basePlan, signalAlerts: nextAlerts };
    try {
      const r = await fetch("/api/my/portfolio/plan", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { errEl.textContent = j.error || T("保存失败", "Save failed"); return; }
      if (onSaved) onSaved(j.plan);
      close();
    } catch { errEl.textContent = T("网络出错，请重试", "Network error"); }
    finally { saveBtn.disabled = false; }
  }

  if (existing) {
    const delBtn = el("button", "btn ghost sm vp-safe-del", T("删除提醒", "Delete")); delBtn.type = "button";
    wireSafeDelete(delBtn, () => persist(existingList.filter((a) => a.id !== existing.id)), lang);
    foot.appendChild(delBtn);
  }
  saveBtn.addEventListener("click", () => {
    const clean = {
      id: draft.id,
      enabled: true,
      metric: draft.metric,
      mode: draft.mode,
      op: draft.op,
      threshold: Number(draft.threshold),
      ...(draft.note && draft.note.trim() ? { note: draft.note.trim() } : {}),
      ...(draft.suggestProfileId ? { suggestProfileId: draft.suggestProfileId } : {}),
    };
    const next = existing
      ? existingList.map((a) => (a.id === existing.id ? clean : a))
      : [...existingList, clean];
    persist(next);
  });
  footR.append(cancelBtn, saveBtn);
  foot.appendChild(footR);

  function syncSliderRange() {
    if (draft.mode === "pct") {
      rangeIn.min = "0"; rangeIn.max = "100"; rangeIn.step = "1";
      numIn.step = "1"; unitSpan.textContent = "%";
    } else {
      const lo = baseSer ? Math.floor((baseSer.min - Math.abs(baseSer.max - baseSer.min) * 0.25) * 10) / 10 : 0;
      const hi = baseSer ? Math.ceil((baseSer.max + Math.abs(baseSer.max - baseSer.min) * 0.25) * 10) / 10 : 10;
      rangeIn.min = String(lo); rangeIn.max = String(hi > lo ? hi : lo + 5); rangeIn.step = "0.1";
      numIn.step = "0.1"; unitSpan.textContent = meta.unit || "";
    }
    rangeIn.value = String(draft.threshold);
    numIn.value = String(draft.threshold);
    condSel.value = `${draft.mode}:${draft.op}`;
  }

  function refreshPreview() {
    renderChips();
    const evaled = evaluateSignalAlerts([draft], macroData, profiles).items[0];
    const chart = renderAlertChart(evaled, macroData, { wide: true, tall: true, lang });
    chartHost.replaceChildren(...(chart ? [chart] : []));
    statusLine.className = "pf-rule-live" + (evaled.triggered ? " hit" : "");
    statusLine.replaceChildren(
      ri(evaled.triggered ? "notification-3-fill" : "information-line"),
      document.createTextNode(T("当前：", "Now: ") + formatAlertReading(evaled, lang) + " · " + (evaled.triggered ? T("按此线当前会立即触发", "Would trigger right now") : evaled.available ? T("当前未触发", "Not triggered yet") : T("暂无数据", "No data")))
    );
  }
  function syncControls() { syncSliderRange(); noteIn.value = draft.note || ""; refreshPreview(); }

  condSel.addEventListener("change", () => {
    const [m, op] = condSel.value.split(":");
    draft.mode = m; draft.op = op;
    if (m === "pct" && (draft.threshold < 0 || draft.threshold > 100)) draft.threshold = op === "gte" ? 90 : 10;
    if (m === "value" && baseSer) draft.threshold = Math.round(baseSer.current * 10) / 10;
    syncSliderRange(); refreshPreview();
  });
  rangeIn.addEventListener("input", () => { draft.threshold = Number(rangeIn.value); numIn.value = rangeIn.value; refreshPreview(); });
  numIn.addEventListener("input", () => { const v = Number(numIn.value); if (Number.isFinite(v)) { draft.threshold = v; rangeIn.value = String(v); refreshPreview(); } });

  mod.append(top, chartHost, statusLine, chips, sliderBox, noteIn, ...(profSel ? [profSel] : []), errEl, foot);
  ov.appendChild(mod);
  document.body.appendChild(ov);
  syncControls();
}
