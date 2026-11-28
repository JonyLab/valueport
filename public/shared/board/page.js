import { mountJevSettings } from "/shared/jev-settings.js";
import { reviewNeedsUpdate, reviewMode, scopeReviewFields, buildReviewEvidence } from "/shared/valuation/review.js";
import { reviewElement } from "/shared/valuation/review-ui.js";
import { Gauge } from "/shared/gauge.js";
import { Bar } from "/shared/bar.js";
import { verdictOf, structValid, hasFairRange, applyZoneColors, computeAnchors, priceToPhi, ZONES, marketLabel } from "/shared/core.js";
import { MKT_LABEL } from "/shared/market.js";
import { t, applyI18n, LANG } from "/shared/i18n.js";
import { mountLangMenu } from "/shared/langmenu.js";
import { mountFeedback } from "/shared/feedback.js";
import { mountGlobalAi, watchlistPage } from "/shared/global-ai.js";
import { mountValuationCalc } from "/shared/valuation-ui.js";
import { cleanThesis, thesisEntries, THESIS_SCENARIOS } from "/shared/valuation/thesis.js";
import { persistValuation, usableValuationRange } from "/shared/valuation/save.js";
import { MODELS, modeFields } from "/shared/valuation/index.js";
import { verifiedFacts, latestMetrics, marketViews, masterLenses, businessFacts, isFinancialCompany } from "/shared/valuation/facts.js";
import { aiErrorText } from "/shared/ai-common.js";
import { METRICS, metricSeries } from "/shared/metric-spark.js";
import { holdingFor, driftText } from "/shared/holding.js";
import { showToast, confirmDialog } from "/shared/ui-toast.js";
import { ri, setNum, mountStockLogo } from "/shared/dom.js";
import { LOCAL_KEYS, SESSION_KEYS, boardCacheKey, pfCacheKey } from "/shared/storage-keys.js";
import { fmtBig, fmtPx, niceStep, fdSeries, fdMoney, fdLast, fdDerive, fdBarLine, fdBars, fdLineChart, fdSpark, fdRange, fdChartWrap, aiSparkEl as _aiSparkEl, financialsTable } from "/shared/board/charts.js";
import { mountAiSettings } from "/shared/board/ai-settings.js";

applyI18n(); // 静态文案先按当前语言渲染
// 标的 logo：先放首字母占位，/api/logo 图片加载成功再替换；失败（404 / 网络）保留首字母
function mountLogo(el, item) {
  mountStockLogo(el, item.cfg.symbol, displayName(item) || item.cfg.ticker);
}
const VMSGS = {
  px: (p) => t("v_px", typeof p === "number" ? p.toFixed(2) : p), pxNone: t("v_px_none"), noSymbol: t("v_no_symbol"),
  waiting: t("v_waiting"), under: (pct) => t("v_under", pct), over: (pct) => t("v_over", pct), fair: t("v_fair"),
};
// 语言切换（全站共用组件）：看板顶栏一个；详情页、估值工作台隐藏顶栏，各自在页头再挂一个
mountLangMenu(document.getElementById("topActions")).id = "langMenu";
mountFeedback(document.getElementById("topActions")); // 反馈入口（只对已登录用户显示）
mountGlobalAi(document.getElementById("topActions"), { getPage: watchlistPage, extraHosts: ".vd-backrow-right, .ve-head-right" }); // 全站 AI 助手（⌘K；详情页、估值编辑页隐藏顶栏，按钮自动补到它们自己的右上角）

const REDUCE = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const ZONE_KEYS = ZONES.map((z) => z.key);
const SLUG_RE = /^[a-z0-9-]{3,32}$/;

const chartsEl = document.getElementById("charts");
const updatedEl = document.getElementById("updated");
const items = []; // {id, cfg, gauge, chartEl, verdictEl, live, gotQuote}
let boardSlug = "";
let owner = false;
let valEditReturn = null; // 估值编辑器视图打开时存当前 item；否则 null
let valEditApi = null, valEditLeaving = false; // 工作台接口（isDirty / save）；正在主动离开时不再拦
let addCardEl = null;

// 默认文案（自定义清空时恢复；随当前语言）
const DEFAULT_TEXT = { eyebrow: t("def_eyebrow"), title: t("def_title"), subtitle: t("def_sub") };

function applyColors(s) {
  const m = {};
  for (const k of ZONE_KEYS) if (s["color_" + k]) m[k] = s["color_" + k];
  applyZoneColors(m);
}
let greetName = ""; // 主人本人访问时，小标题留空则显示「欢迎回来，<用户名>」
function applySettings(s) {
  const eyebrow = s.eyebrow || (greetName ? t("ov_greet", greetName) : DEFAULT_TEXT.eyebrow);
  const eyebrowEl = document.getElementById("eyebrow");
  eyebrowEl.textContent = eyebrow; eyebrowEl.style.display = eyebrow ? "" : "none";
  const title = s.title || DEFAULT_TEXT.title;
  document.getElementById("title").textContent = title;
  document.title = title;
  const sub = s.subtitle || DEFAULT_TEXT.subtitle;
  const subEl = document.getElementById("sub");
  subEl.textContent = sub; subEl.style.display = sub ? "" : "none";
}

/* ---------- 图表渲染 ---------- */
function renderVerdict(item) {
  if (item._pxRaf) { cancelAnimationFrame(item._pxRaf); item._pxRaf = null; }
  const v = verdictOf(item.cfg, VMSGS);
  const el = item.verdictEl;
  el.className = "verdict " + v.cls;
  el.innerHTML = "";
  const px = document.createElement("span");
  px.className = "px";
  setNum(px, v.px);
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  const isStrike = extremeOf(item.cfg) === "strike";
  item.chartEl.classList.toggle("is-strike", isStrike);
  item.chartEl.style.setProperty("--strike-color", ZONES[0].hex);
  lbl.textContent = isStrike ? `${t("zone_deep")} · ${v.text}` : v.text === "—" ? t("ov_none") : v.text;
  if (isStrike) lbl.prepend(ri("focus-3-line"));
  el.appendChild(px);
  el.appendChild(lbl);
  renderOverview(); // 任一卡片判定变化（报价/区间/编辑）都同步概览
}
// 入场动画：现价数字与钟摆 swingIn 同步入场、同时收尾（呼应 motion.dev number-trend）
// 用与 gauge.swingIn 完全相同的阻尼包络（λ=0.9）和停止阈值（env≤0.012），保证两者同时停
function animatePriceIn(item) {
  const px = item.verdictEl.querySelector(".px");
  const to = item.cfg.price;
  if (!px || !(to > 0)) return;
  if (REDUCE) { setNum(px, VMSGS.px(to)); return; }
  const lambda = 8.85, cutoff = 0.012, t0 = performance.now(); // λ=8.85 → 收敛约 0.5s(ln(1/cutoff)/λ)
  setNum(px, VMSGS.px(0));
  const step = (now) => {
    const env = Math.exp(-lambda * (now - t0) / 1000); // 1→0，随钟摆摆幅一起衰减
    // 归一化：env 降到 cutoff 时正好到达目标，避免收尾跳一下
    setNum(px, VMSGS.px(to * (1 - env) / (1 - cutoff)));
    if (env > cutoff) item._pxRaf = requestAnimationFrame(step);
    else { setNum(px, VMSGS.px(to)); item._pxRaf = null; }
  };
  item._pxRaf = requestAnimationFrame(step);
}
// 当前语言下该显示的标的名：英文用 Longbridge name_en，缺则回退已存名/代码
// 英文名精简：去掉公司后缀（Inc. / Corporation / Ltd …）。全大写名（港股如 TENCENT、CNOOC）保持原样——无法区分缩写与普通词
const EN_SUFFIX_RE = /[,\s]+(inc\.?|incorporated|corp\.?|corporation|co\.?,?\s*ltd\.?|company|ltd\.?|limited|plc|holdings?|group|n\.v\.|s\.a\.|ag|se)$/i;
function shortEnName(n) {
  let s = (n || "").trim(), prev;
  do { prev = s; s = s.replace(EN_SUFFIX_RE, "").trim(); } while (s && s !== prev);
  if (!s) s = (n || "").trim();
  return s;
}
function displayName(item) {
  const c = item.cfg;
  if (LANG === "en") return (item.nameEn && shortEnName(item.nameEn)) || c.name || c.ticker || "";
  return c.name || item.nameCn || c.ticker || "";
}
// 拉取一批标的的中英文名（Longbridge），写回各 item 并刷新中枢名称
async function loadNames(syms) {
  syms = [...new Set((syms || []).filter(Boolean))];
  if (!syms.length) return;
  try {
    const res = await fetch("/api/names?v=6&symbols=" + encodeURIComponent(syms.join(",")));
    const { names } = await res.json();
    if (!names) return;
    for (const item of items) {
      const n = names[item.cfg.symbol];
      if (!n) continue;
      item.nameCn = n.cn || ""; item.nameEn = n.en || "";
      item.statics = n; // {cn,en,exchange,currency,totalShares,epsTtm,bps,dividendYield}
      renderItemHead(item);
    }
    if (currentDetailCode()) route(); // 详情页深链：静态信息到达后刷新基本面
  } catch { /* 拿不到就保持已存名 */ }
}
// 左侧信息区的名称行（名称随语言、代码用 ticker）
function renderItemHead(item) {
  if (item.nameEl) item.nameEl.textContent = displayName(item);
  if (item.logoEl && item._logoSym !== item.cfg.symbol) { item._logoSym = item.cfg.symbol; mountLogo(item.logoEl, item); } // 换了标的才重取图片
  if (item.codeEl) { const mk = marketLabel(item.cfg.symbol, LANG); item.codeEl.textContent = (item.cfg.ticker || "").toUpperCase() + (mk ? " · " + mk : ""); } // 代码 · 市场
}
function addChart(cfg) {
  const wrap = document.createElement("div");
  wrap.className = "chart-item";
  // 左：信息区（名称/代码 + 股价/判定）
  const info = document.createElement("div");
  info.className = "chart-info";
  const idRow = document.createElement("div");
  idRow.className = "ci-id";
  const logoEl = document.createElement("span"); logoEl.className = "ci-logo"; logoEl.setAttribute("aria-hidden", "true");
  const nameEl = document.createElement("span"); nameEl.className = "ci-name";
  const codeEl = document.createElement("span"); codeEl.className = "ci-code";
  const idText = document.createElement("span"); idText.className = "ci-idtext";
  idText.append(nameEl, codeEl);
  idRow.append(logoEl, idText);
  const verdict = document.createElement("p");
  verdict.className = "verdict v-fair";
  info.append(idRow, verdict);
  // 右：横向条形图（钟摆展平）
  const gwrap = document.createElement("div");
  gwrap.className = "chart-bar";
  const gauge = new Bar(gwrap);
  wrap.append(info, gwrap);
  const item = { id: cfg.id || null, cfg: { ...cfg }, gauge, chartEl: wrap, verdictEl: verdict, nameEl, codeEl, logoEl, live: false, gotQuote: false };
  // 进详情（仅主人；访客只看列表）
  const openDetail = () => {
    const code = (item.cfg.ticker || "").toUpperCase();
    if (!code) return;
    history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug) + "/" + encodeURIComponent(code));
    showDetail(item);
  };
  if (owner) {
    wrap.style.cursor = "pointer";
    wrap.addEventListener("click", (e) => { if (e.target.closest(".card-actions")) return; openDetail(); });
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const more = document.createElement("details"); more.className = "card-more";
    const moreButton = document.createElement("summary"); moreButton.className = "btn icon sm";
    moreButton.setAttribute("aria-label", LANG === "zh" ? "更多操作" : "More actions");
    moreButton.title = LANG === "zh" ? "更多操作" : "More actions";
    moreButton.appendChild(ri("more-line"));
    const menu = document.createElement("div"); menu.className = "card-menu";
    const edit = document.createElement("button"); edit.type = "button";
    edit.append(ri("edit-line"), document.createTextNode(t("b_edit")));
    edit.addEventListener("click", () => {
      more.open = false;
      openItemModal(item, false);
      const first = modalForm.querySelector("input"); if (first) first.focus();
    });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger";
    remove.append(ri("delete-bin-line"), document.createTextNode(LANG === "zh" ? "移除自选" : "Remove from watchlist"));
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try { await requestRemoveItem(item); }
      finally { remove.disabled = false; more.open = false; if (moreButton.isConnected) moreButton.focus(); }
    });
    menu.append(edit, remove); more.append(moreButton, menu);
    more.addEventListener("toggle", () => {
      if (more.open) document.querySelectorAll(".card-more[open]").forEach((el) => { if (el !== more) el.open = false; });
    });
    more.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && more.open) { e.stopPropagation(); more.open = false; moreButton.focus(); }
    });
    const detail = document.createElement("button");
    detail.className = "btn icon sm";
    detail.title = t("b_detail"); detail.setAttribute("aria-label", t("b_detail"));
    detail.innerHTML = '<i class="ri-arrow-right-up-line" aria-hidden="true"></i>';
    detail.addEventListener("click", openDetail);
    actions.append(more, detail);
    wrap.appendChild(actions);
  }
  if (addCardEl) chartsEl.insertBefore(wrap, addCardEl); else chartsEl.appendChild(wrap);
  items.push(item);
  gauge.set(item.cfg, false);
  renderVerdict(item);
  renderItemHead(item);
  return item;
}
function removeChart(item) {
  const idx = items.indexOf(item);
  if (idx >= 0) { item.gauge.destroy(); item.chartEl.remove(); items.splice(idx, 1); }
  renderOverview();
}
document.addEventListener("click", (e) => {
  document.querySelectorAll(".card-more[open]").forEach((el) => { if (!el.contains(e.target)) el.open = false; });
});
// 概览区：统计数字（标的 / 击球区 / 泡沫区）
// 两端区间：击球区 = 现价 < 低点×(1−安全边际)；泡沫区 = 现价 ≥ 高点×(1+泡沫阈值)（边界与卡片五段条的落段一致）
function extremeOf(c) {
  if (!structValid(c) || !(c.price > 0)) return null;
  const a = computeAnchors(c);
  return c.price < a[1] ? "strike" : c.price >= a[4] ? "bubble" : null;
}
function renderOverview() {
  const real = items.filter((i) => i.cfg.symbol);
  let strike = 0, bubble = 0;
  real.forEach((i) => {
    const x = extremeOf(i.cfg);
    if (x === "strike") strike++; else if (x === "bubble") bubble++;
  });
  document.getElementById("statTotal").textContent = real.length;
  document.getElementById("statStrike").textContent = strike;
  document.getElementById("statBubble").textContent = bubble;
  document.getElementById("icoStrike").style.background = ZONES[0].hex;
  document.getElementById("icoBubble").style.background = ZONES[ZONES.length - 1].hex;
  renderStrikeBanner(real.filter((i) => extremeOf(i.cfg) === "strike"));
  renderReviewBanner();
}

// ── 该复核的估值 ──
// 只看选中的那张估值卡（它决定了合理区间）：updatedAt 超过 REVIEW_DAYS 天，或估值之后又出了财报（季报 / 半年报 / 年报：最新一期的期末晚于估值日期，财报一定是期末之后才发布）
const REVIEW_DAYS = 180;
const selectedCard = (c) => (Array.isArray(c.valuations) ? c.valuations.find((v) => v.id === c.selectedValuationId) : null) || null;
// 最新一期财报的期末（ISO 日期）按标的缓存一天，避免每次打开都拉财报
const FP_KEY = (sym) => "rv_fp2_" + sym; // v2：季报起算（v1 只看年报）
function cachedFp(sym) {
  try { const j = JSON.parse(localStorage.getItem(FP_KEY(sym)) || "null"); return j && Date.now() - j.at < 86400000 ? j : null; } catch { return null; }
}
function latestAnnualEnd(financials) { // 年报 / 季报都适用：取最新一期的期末与期名
  const acct = financials && financials.IS && financials.IS[0];
  const v = acct && acct.values && acct.values[0]; // 最新期在前
  if (!v) return null;
  const t = Number(v.fpEnd);
  const iso = Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString().slice(0, 10) : null;
  return iso ? { end: iso, label: v.period || (v.year ? "FY" + v.year : "") } : null;
}
// 最近一次「看过」这张卡的时间：编辑保存、AI 复核、手动「标记已复核」三者取最新 → { at: ISO, how: "edit"|"ai"|"mark" }
function lastChecked(card) {
  const c = [[card.updatedAt, "edit"], [!reviewNeedsUpdate(card) && card.review && card.review.at, "ai"], [card.reviewedAt, "mark"]]
    .filter(([t]) => typeof t === "string" && Number.isFinite(Date.parse(t))).sort((a, b) => Date.parse(b[0]) - Date.parse(a[0]));
  return c.length ? { at: c[0][0], how: c[0][1] } : null;
}
function reviewReasonsFor(card, symbol) {
  const lc = card && lastChecked(card); if (!lc) return null;
  const at = Date.parse(lc.at), zh = LANG === "zh", out = [];
  if (reviewNeedsUpdate(card)) out.push(zh ? "复核口径或假设已更新" : "Review method or assumptions changed");
  const months = Math.floor((Date.now() - at) / (30.44 * 86400000));
  if (Date.now() - at > REVIEW_DAYS * 86400000) out.push(zh ? `${months} 个月未复核` : `not reviewed for ${months} months`);
  const fp = cachedFp(symbol);
  if (fp && fp.end && fp.end > lc.at.slice(0, 10)) out.push(zh ? `有新财报 ${fp.label}` : `new report ${fp.label}`);
  return out.length ? out : null;
}
function reviewReasons(item) { return reviewReasonsFor(selectedCard(item.cfg), item.cfg.symbol); }
let reviewFetching = false;
// 后台逐个补齐「最新一期财报期末」：先看季报，没有季报（只出半年报 / 没数据）再看年报；只给主人、只看已估值的；长桥财报接口限频，一个一个来
async function fillReportDates() {
  if (!owner || reviewFetching) return;
  const todo = items.filter((i) => i.cfg.symbol && selectedCard(i.cfg) && !cachedFp(i.cfg.symbol));
  if (!todo.length) return;
  reviewFetching = true;
  try {
    for (const it of todo) {
      const q = await loadFinancials(it, "quarter").catch(() => null);
      let fp = latestAnnualEnd(q && q.financials);
      if (!fp) { const a = await loadFinancials(it, "annual").catch(() => null); fp = latestAnnualEnd(a && a.financials); }
      try { localStorage.setItem(FP_KEY(it.cfg.symbol), JSON.stringify({ at: Date.now(), ...(fp || {}) })); } catch { /* 存不了就下次再拉 */ }
      renderReviewBanner();
    }
  } finally { reviewFetching = false; }
}
function renderReviewBanner() {
  const el = document.getElementById("reviewBanner"); if (!el) return;
  if (!owner) { el.classList.add("hidden"); return; }
  const zh = LANG === "zh";
  const list = items.filter((i) => i.cfg.symbol).map((i) => [i, reviewReasons(i)]).filter(([, r]) => r);
  const key = "review_banner_off_" + boardSlug, sig = list.map(([i, r]) => i.cfg.symbol + ":" + r.join("|")).sort().join(",");
  let off = ""; try { off = sessionStorage.getItem(key) || ""; } catch { off = ""; }
  if (!list.length || off === sig) { el.classList.add("hidden"); el.replaceChildren(); return; }
  const ico = document.createElement("span"); ico.className = "sb-ico"; ico.appendChild(ri("refresh-line"));
  const body = document.createElement("div"); body.className = "sb-body";
  const head = document.createElement("div"); head.className = "sb-head";
  head.textContent = zh ? `${list.length} 个估值该复核了` : `${list.length} valuation${list.length > 1 ? "s" : ""} to review`;
  const names = document.createElement("div"); names.className = "sb-names";
  for (const [it, reasons] of list) {
    const b = document.createElement("button"); b.type = "button"; b.className = "sb-name";
    b.textContent = displayName(it) + " · " + reasons.join(zh ? "，" : ", ");
    b.addEventListener("click", () => {
      const code = (it.cfg.ticker || "").toUpperCase(); if (!code) return;
      history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug) + "/" + encodeURIComponent(code));
      showDetail(it, "val");
    });
    names.appendChild(b);
  }
  const say = document.createElement("div"); say.className = "sb-say";
  say.textContent = zh ? "看看假设还成不成立，可以用 AI 复核" : "Check the assumptions still hold — try the AI review";
  body.append(head, names, say);
  const x = document.createElement("button"); x.type = "button"; x.className = "sb-close"; x.setAttribute("aria-label", zh ? "关闭提示" : "Dismiss");
  x.appendChild(ri("close-line"));
  x.addEventListener("click", () => { try { sessionStorage.setItem(key, sig); } catch { /* 只关这一次 */ } el.classList.add("hidden"); });
  el.replaceChildren(ico, body, x);
  el.classList.remove("hidden");
}
// 击球区提示：列出现价低于「低点 ×(1 − 安全边际)」的标的；关掉后按这组标的记在本次会话，组合变了再出现
function renderStrikeBanner(list) {
  const el = document.getElementById("strikeBanner"); if (!el) return;
  const zh = LANG === "zh";
  const key = "strike_banner_off_" + boardSlug, sig = list.map((i) => i.cfg.symbol).sort().join(",");
  let off = ""; try { off = sessionStorage.getItem(key) || ""; } catch { off = ""; }
  if (!list.length || off === sig) { el.classList.add("hidden"); el.replaceChildren(); return; }
  const ico = document.createElement("span"); ico.className = "sb-ico"; ico.style.background = ZONES[0].hex; ico.appendChild(ri("focus-3-line"));
  const body = document.createElement("div"); body.className = "sb-body";
  const head = document.createElement("div"); head.className = "sb-head";
  head.textContent = zh ? `${list.length} 只标的进入击球区` : `${list.length} ${list.length > 1 ? "names are" : "name is"} in the strike zone`;
  const names = document.createElement("div"); names.className = "sb-names";
  for (const it of list) {
    const b = document.createElement("button"); b.type = "button"; b.className = "sb-name";
    const pct = it.cfg.price > 0 ? Math.round((1 - it.cfg.price / computeAnchors(it.cfg)[1]) * 100) : NaN;
    b.textContent = displayName(it) + (Number.isFinite(pct) ? (zh ? ` · 低于击球线 ${pct}%` : ` · ${pct}% below the line`) : "");
    b.addEventListener("click", () => {
      const code = (it.cfg.ticker || "").toUpperCase(); if (!code) return;
      history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug) + "/" + encodeURIComponent(code));
      showDetail(it);
    });
    names.appendChild(b);
  }
  const say = document.createElement("div"); say.className = "sb-say";
  say.textContent = zh ? "不是买入信号，先复核估值假设" : "Not a buy signal — re-check your assumptions first";
  body.append(head, names, say);
  const x = document.createElement("button"); x.type = "button"; x.className = "sb-close"; x.setAttribute("aria-label", zh ? "关闭提示" : "Dismiss");
  x.appendChild(ri("close-line"));
  x.addEventListener("click", () => { try { sessionStorage.setItem(key, sig); } catch { /* 存不了就只关这一次 */ } el.classList.add("hidden"); });
  el.replaceChildren(ico, body, x);
  el.classList.remove("hidden");
}

/* ---------- 行情 ---------- */
async function fetchQuotes() {
  const symbols = [...new Set(items.map((i) => i.cfg.symbol).filter(Boolean))];
  if (!symbols.length) return;
  let data;
  try {
    const res = await fetch("/api/quotes?symbols=" + encodeURIComponent(symbols.join(",")));
    data = await res.json();
  } catch { return; }
  const quotes = data.quotes || {};
  const prevClose = data.prevClose || {};
  let ok = 0;
  items.forEach((item) => {
    const p = quotes[item.cfg.symbol];
    if (!(p > 0)) return;
    ok++;
    item.cfg = { ...item.cfg, price: p };
    if (prevClose[item.cfg.symbol] > 0) item.prevClose = prevClose[item.cfg.symbol];
    item.live = true;
    const first = !item.gotQuote;
    item.gotQuote = true;
    item.gauge.set(item.cfg, true);   // 列表用 Bar：自带占位/标记动画
    renderVerdict(item);
    if (structValid(item.cfg)) {       // 入场摆动/数字动画仅在有区间（钟摆）时
      if (first && typeof item.gauge.swingIn === "function") item.gauge.swingIn();
      if (first) animatePriceIn(item);
    }
  });
  if (ok > 0) {
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const src = data.source === "longbridge" ? t("src_longbridge") : t("src_tencent");
    updatedEl.textContent = t("b_updated", `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`, src);
  }
}

/* ---------- 启动 ---------- */
// 看板缓存（本次会话）：有缓存就直接画缓存，不出骨架；新数据到了只在有变化时重画，否则只更新报价
const BOARD_CACHE = () => boardCacheKey(boardSlug);
let ownerInited = false;
function applyBoard(me, data, prices) {
  owner = !!(me && me.board && me.board.slug === boardSlug);
  if (owner) sessionStorage.setItem(SESSION_KEYS.ownerSlug, boardSlug);
  else {
    if (sessionStorage.getItem(SESSION_KEYS.ownerSlug) === boardSlug) sessionStorage.removeItem(SESSION_KEYS.ownerSlug);
    for (const id of ["appNav", "btnSettings"]) document.getElementById(id).classList.add("hidden"); // 身份已变（退出 / 换号）：收回
  }
  greetName = owner ? me.username : "";
  applySettings(data.settings || {});
  applyColors(data.settings || {});
  applyItemDefaults(data.settings || {});
  const rows = data.items || [];

  // 头部入口 / 导航
  const actions = document.getElementById("topActions");
  if (owner) {
    document.getElementById("appNav").classList.remove("hidden");
    document.getElementById("btnSettings").classList.remove("hidden");
  } else if (me && me.board && me.board.slug) {
    document.getElementById("myBoardLink")?.remove();
    const mine = document.createElement("a"); mine.id = "myBoardLink";
    mine.className = "btn sm ghost"; mine.style.textDecoration = "none";
    mine.href = "/b/" + me.board.slug; mine.textContent = t("b_myboard");
    actions.insertBefore(mine, document.getElementById("langMenu"));
  }

  // 渲染
  chartsEl.innerHTML = "";
  items.length = 0;
  if (owner) {
    addCardEl = document.createElement("button");
    addCardEl.className = "add-card";
    addCardEl.replaceChildren(ri("add-line"), document.createTextNode(t("b_add")));
    addCardEl.addEventListener("click", () => {
      // 低/高点不预填（必须自己想清楚估值）；安全边际默认 50%、泡沫阈值默认 40%
      const item = addChart({ ticker: "", name: "", symbol: null, price: 0, fairLow: "", fairHigh: "", mos: itemDefaults.mos, ext: itemDefaults.ext, sortOrder: items.length, valuations: [], selectedValuationId: null });
      openItemModal(item, true);
      item.chartEl.scrollIntoView({ behavior: REDUCE ? "auto" : "smooth", block: "center" });
    });
    chartsEl.appendChild(addCardEl);
  }
  if (!rows.length && !owner) {
    chartsEl.innerHTML = `<div class="charts-empty">${t("b_empty")}</div>`;
    return;
  }
  rows.forEach((r) => addChart({ ...r, price: (prices && prices[r.symbol]) || 0 }));
  if (owner && !ownerInited) { ownerInited = true; initOwner(data.settings || {}); }
  if (owner) setTimeout(fillReportDates, 1500); // 页面先画好，再在后台补「最新年报」做复核提醒
  return true;
}

async function init() {
  const m = location.pathname.match(/^\/b\/([^/]+)/);
  boardSlug = m ? decodeURIComponent(m[1]) : "";
  if (!boardSlug) { location.replace("/login"); return; }
  const reqs = Promise.allSettled([
    fetch("/api/config?slug=" + encodeURIComponent(boardSlug)),
    fetch("/api/me"),
  ]);
  let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(BOARD_CACHE()) || "null"); } catch { cached = null; }
  if (cached && cached.data) {
    applyBoard(cached.me, cached.data, cached.prices);
    document.body.classList.remove("booting");
    route();
  }
  const [cfgRes, meRes] = await reqs;

  // 身份
  let me = null;
  if (meRes.status === "fulfilled" && meRes.value.ok) {
    try { me = await meRes.value.json(); } catch { me = null; }
  }

  // 看板数据（有缓存时请求失败就保留缓存画面）
  const fail = (msg) => { if (!cached) chartsEl.innerHTML = `<div class="charts-empty">${msg}</div>`; };
  if (cfgRes.status !== "fulfilled") return fail(t("b_loadfail"));
  const res = cfgRes.value;
  if (res.status === 404) { sessionStorage.removeItem(BOARD_CACHE()); chartsEl.innerHTML = `<div class="charts-empty">${t("b_notfound")}</div>`; return; }
  let data;
  try { data = await res.json(); } catch { return fail(t("b_loadfail")); }
  const same = cached && JSON.stringify(cached.data) === JSON.stringify(data) && JSON.stringify(cached.me) === JSON.stringify(me);
  if (!same) {
    const ok = applyBoard(me, data, cached && cached.prices);
    document.body.classList.remove("booting");
    if (!ok) return;
  }
  await fetchQuotes();
  const prices = {}; for (const i of items) if (i.cfg.symbol && i.cfg.price > 0) prices[i.cfg.symbol] = i.cfg.price;
  try { sessionStorage.setItem(BOARD_CACHE(), JSON.stringify({ me, data, prices })); } catch { /* 存不下就算了 */ }
  loadNames(items.map((i) => i.cfg.symbol)); // 双语名 + 基本面静态信息（不阻塞首屏）
  if (!same) route(); // 按 URL 决定显示列表还是某标的详情（缓存画面已 route 过且数据没变就不重画）
  // 从资产页持仓表点了一只不在自选里的股票：/b/<slug>?add=<代码>&name=<名称> → 打开预填好的添加弹窗（已在自选就直接进详情）
  const q = new URLSearchParams(location.search), addSym = q.get("add");
  if (owner && addSym && /^(us|hk|sh|sz|bj)[A-Za-z0-9.]{1,12}$/.test(addSym)) {
    history.replaceState({}, "", location.pathname);
    const exist = items.find((i) => i.cfg.symbol === addSym);
    if (exist) showDetail(exist);
    else {
      const item = addChart({ ticker: addSym.slice(2).toUpperCase(), name: (q.get("name") || "").slice(0, 60), symbol: addSym, price: 0, fairLow: "", fairHigh: "", mos: itemDefaults.mos, ext: itemDefaults.ext, sortOrder: items.length, valuations: [], selectedValuationId: null });
      openItemModal(item, true);
      fetchQuotes();
    }
  }
  if (owner && location.hash === "#settings") { showSettings(); history.replaceState(history.state, "", location.pathname + location.search); }
  if (owner && location.hash === "#ai") { showSettings(); requestAnimationFrame(() => document.getElementById("aiCfg").scrollIntoView({ block: "start" })); }
}

/* ================= 以下仅主人模式 ================= */

/* ---------- 保存（防抖 + 串行） ---------- */
const modalSaveEl = document.getElementById("modalSave");
function setSaveState(state, text) {
  modalSaveEl.className = "save-state " + (state || "");
  modalSaveEl.textContent = text || "";
}
// 可落库：选了标的即可；若填了内在价值区间则区间须自洽（低<高 + 安全边际/泡沫阈值有效）。
function cfgSavable(c) {
  if (!c.symbol) return false;
  if (hasFairRange(c)) return c.mos > 0 && c.mos < 100 && c.ext > 0;
  return !(c.fairLow > 0) && !(c.fairHigh > 0); // 未估值：低/高都不能是「填了一半」
}
async function saveItem(item) {
  if (!cfgSavable(item.cfg)) return;
  if (item._saving) { item._pendingSave = true; return; }
  item._saving = true;
  setSaveState("", t("st_saving"));
  const payload = {
    ticker: item.cfg.ticker, name: item.cfg.name, symbol: item.cfg.symbol,
    fairLow: item.cfg.fairLow, fairHigh: item.cfg.fairHigh, mos: item.cfg.mos, ext: item.cfg.ext,
    sortOrder: item.cfg.sortOrder || 0,
    valuations: item.cfg.valuations || [], selectedValuationId: item.cfg.selectedValuationId || null,
  };
  const url = item.id ? `/api/my/items/${item.id}` : "/api/my/items";
  const method = item.id ? "PUT" : "POST";
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (res.ok) {
      const body = await res.json();
      if (!item.id && body.id) item.id = body.id;
      if (item._discarded && item.id) { // 关窗丢弃后迟到落库的，删掉以保持一致
        fetch(`/api/my/items/${item.id}`, { method: "DELETE" }).catch(() => {});
        item.id = null;
      }
      setSaveState("ok", t("st_saved"));
    } else setSaveState("err", t("st_failed"));
  } catch { setSaveState("err", t("st_failed")); }
  finally {
    item._saving = false;
    if (item._pendingSave) { item._pendingSave = false; saveItem(item); }
  }
}
function debounceSave(item) {
  clearTimeout(item._saveT);
  item._saveT = setTimeout(() => saveItem(item), 600);
}

/* ---------- 代码联想 ---------- */
let hintSeq = 0;
async function loadHints(q) {
  const seq = ++hintSeq;
  try {
    const res = await fetch("/api/hints?q=" + encodeURIComponent(q));
    const { hints } = await res.json();
    return seq === hintSeq ? hints : null;
  } catch { return []; }
}

/* ---------- 标的编辑弹窗 ---------- */
const FIELDS = [
  { k: "ticker", lab: t("m_ticker"), type: "text" },
  { k: "fairLow", lab: t("m_fair_low"), type: "number", ph: t("m_fair_ph") },
  { k: "fairHigh", lab: t("m_fair_high"), type: "number", ph: t("m_fair_ph") },
  { k: "mos", lab: t("m_mos"), type: "number", presets: [10, 20, 30, 40, 50] },
  { k: "ext", lab: t("m_ext"), type: "number", presets: [10, 20, 30, 40, 50] },
];
const modalOverlay = document.getElementById("modalOverlay");
const modalForm = document.getElementById("modalForm");
const modalTitle = document.getElementById("modalTitle");
const btnModalRemove = document.getElementById("btnModalRemove");
let modalItem = null, modalIsNew = false, modalSnapshot = null;
let fieldErrs = {}, fieldInputs = {};   // 字段级内联报错：key → 错误元素 / 输入框
function showFieldErr(key, msg) { const e = fieldErrs[key]; if (e) { e.textContent = msg; e.style.display = "block"; } if (fieldInputs[key]) fieldInputs[key].classList.add("bad"); }
function clearFieldErrs() { for (const k in fieldErrs) if (fieldErrs[k]) fieldErrs[k].style.display = "none"; }

function modalTitleFor(item) {
  return item.cfg.symbol
    ? `${(item.cfg.ticker || "").toUpperCase()}${displayName(item) && displayName(item) !== item.cfg.ticker ? " · " + displayName(item) : ""}`
    : (modalIsNew ? t("m_add_title") : (item.cfg.ticker || "—").toUpperCase());
}

function buildItemForm(item) {
  modalForm.innerHTML = "";
  fieldErrs = {}; fieldInputs = {};
  let syncValPick = () => {}; // 由估值卡片选择器赋值：刷新高亮（手填区间时解除选中）
  const grid = document.createElement("div");
  grid.className = "cfg-grid";
  FIELDS.forEach((f) => {
    const lab = document.createElement("label");
    lab.className = "field" + (f.k === "ticker" ? " full" : "");
    const span = document.createElement("span");
    span.className = "f-lab"; span.textContent = f.lab;
    const input = document.createElement("input");
    input.type = f.type;
    if (f.type === "number") { input.min = "0"; input.step = "any"; if (f.ph) input.placeholder = f.ph; }
    else { input.maxLength = 24; input.spellcheck = false; input.placeholder = t("m_ph_ticker"); input.autocomplete = "off"; }
    // 内在价值（带 ph 的字段）未设定（0/空）时留空，露出「可留空」占位
    input.value = (f.ph && !(item.cfg[f.k] > 0)) ? "" : (item.cfg[f.k] ?? "");
    fieldInputs[f.k] = input;

    input.addEventListener("input", () => {
      if (fieldErrs[f.k]) fieldErrs[f.k].style.display = "none"; // 输入即清除本字段报错
      const v = f.type === "number" ? parseFloat(input.value) : input.value.trim();
      const next = { ...item.cfg, [f.k]: v };
      let bad = false;
      if (f.k === "fairLow") bad = !(v > 0);
      if (f.k === "fairHigh") bad = !(v > next.fairLow);
      if (f.k === "mos") bad = !(v > 0 && v < 100);
      if (f.k === "ext") bad = !(v > 0);
      input.classList.toggle("bad", bad && input.value !== "");
      // 手动改动区间 ⇒ 不再「跟随」某张估值卡片
      if ((f.k === "fairLow" || f.k === "fairHigh") && next.selectedValuationId) { next.selectedValuationId = null; }
      item.cfg = next;
      if (f.k === "fairLow" || f.k === "fairHigh") syncValPick();
      if (f.k === "ticker") {
        item.live = false; item.gotQuote = false;
        item.cfg = { ...item.cfg, price: 0, symbol: null, name: "" };
        input.classList.remove("ok", "bad");
        modalTitle.textContent = modalTitleFor(item);
        renderVerdict(item);
        item.gauge.set(item.cfg);
      }
      item.gauge.set(item.cfg);   // 钟摆/条带自带占位态，未估值也安全
      renderVerdict(item);
      if (cfgSavable(item.cfg)) debounceSave(item);
    });

    if (f.k === "ticker") {
      const combo = document.createElement("div");
      combo.className = "combo";
      const list = document.createElement("div");
      list.className = "combo-list"; list.style.display = "none";
      const err = document.createElement("div");
      err.className = "f-err"; err.textContent = t("m_pick_err");
      fieldErrs.ticker = err;
      let opts = [], act = -1, searchTimer = null;
      const close = () => { list.style.display = "none"; act = -1; };
      const markState = () => {
        const txt = input.value.trim();
        if (item.cfg.symbol) { input.classList.add("ok"); input.classList.remove("bad"); err.style.display = "none"; }
        else if (txt) { input.classList.add("bad"); input.classList.remove("ok"); err.textContent = t("m_pick_err"); err.style.display = "block"; }
        else { input.classList.remove("ok", "bad"); err.style.display = "none"; }
      };
      const pick = (o) => {
        input.value = o.code;
        item.cfg = { ...item.cfg, ticker: o.code, name: o.name, symbol: o.symbol, price: 0 };
        item.live = false; item.gotQuote = false;
        modalTitle.textContent = modalTitleFor(item);
        item.nameCn = ""; item.nameEn = ""; // 换标的后旧名作废，重新拉
        item.gauge.set(item.cfg); renderVerdict(item); renderItemHead(item);
        if (cfgSavable(item.cfg)) saveItem(item); // 未填区间也可存（仅需标的）
        close(); markState(); fetchQuotes(); loadNames([item.cfg.symbol]);
      };
      const renderList = (arr) => {
        opts = arr; act = -1; list.innerHTML = "";
        if (!arr.length) { close(); return; }
        arr.forEach((o) => {
          const d = document.createElement("div");
          d.className = "combo-opt";
          d.innerHTML = `<span class="c-code"></span><span class="c-name"></span><span class="c-mkt"></span>`;
          d.children[0].textContent = o.code;
          d.children[1].textContent = o.name;
          d.children[2].textContent = MKT_LABEL[o.mkt];
          d.addEventListener("mousedown", (e) => { e.preventDefault(); pick(o); });
          list.appendChild(d);
        });
        list.style.display = "";
      };
      const highlight = () => {
        [...list.children].forEach((d, i) => d.classList.toggle("act", i === act));
        if (act >= 0) list.children[act].scrollIntoView({ block: "nearest" });
      };
      input.addEventListener("input", () => {
        const q = input.value.trim();
        clearTimeout(searchTimer);
        if (q.length < 1) { close(); return; }
        searchTimer = setTimeout(async () => {
          const arr = await loadHints(q);
          if (arr !== null) renderList(arr);
        }, 250);
      });
      input.addEventListener("keydown", (e) => {
        if (list.style.display === "none") return;
        if (e.key === "ArrowDown") { e.preventDefault(); act = Math.min(opts.length - 1, act + 1); highlight(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); act = Math.max(0, act - 1); highlight(); }
        else if (e.key === "Enter") { e.preventDefault(); if (act >= 0) pick(opts[act]); else if (opts.length) pick(opts[0]); }
        else if (e.key === "Escape") { e.stopPropagation(); close(); }
      });
      input.addEventListener("blur", () => { setTimeout(() => { close(); markState(); }, 150); });
      combo.append(input, list);
      lab.append(span, combo, err);
      grid.appendChild(lab);
      if (item.cfg.symbol) input.classList.add("ok");
      return;
    }

    lab.append(span, input);
    if (f.presets) {
      const chips = document.createElement("div");
      chips.className = "chips";
      const chipEls = f.presets.map((p) => {
        const c = document.createElement("button");
        c.type = "button"; c.className = "chip"; c.textContent = p + "%";
        c.addEventListener("click", () => { input.value = p; input.dispatchEvent(new Event("input", { bubbles: true })); });
        chips.appendChild(c);
        return { el: c, val: p };
      });
      const syncChips = () => { const v = parseFloat(input.value); chipEls.forEach(({ el, val }) => el.classList.toggle("on", v === val)); };
      input.addEventListener("input", syncChips);
      syncChips();
      lab.appendChild(chips);
    }
    const fe = document.createElement("div");
    fe.className = "f-err"; fieldErrs[f.k] = fe;
    lab.appendChild(fe);
    grid.appendChild(lab);
    if (f.k === "fairHigh") {
      // 合理价值注释：紧贴低点/高点输入下方，链接到估值方法介绍页
      const note = document.createElement("p");
      note.className = "quote-note";
      note.style.cssText = "grid-column:1 / -1;margin:0";
      note.innerHTML = t("m_note_html");
      grid.appendChild(note);
      // 已有估值卡片 → 一键选作合理区间（紧跟注释，作为「直接填」之外的另一入口）
      const cards = Array.isArray(item.cfg.valuations) ? item.cfg.valuations : [];
      if (cards.length) {
        const pick = document.createElement("div"); pick.className = "valpick";
        const plab = document.createElement("div"); plab.className = "valpick-lab";
        plab.textContent = LANG === "zh" ? "或选用已保存的估值：" : "Or use a saved valuation:";
        const row = document.createElement("div"); row.className = "valpick-row";
        const chipEls = cards.map((card) => {
          const lo = Math.round(Math.min(card.low, card.high) * 100) / 100;
          const hi = Math.round(Math.max(card.low, card.high) * 100) / 100;
          const model = MODELS.find((m) => m.key === card.method);
          const b = document.createElement("button"); b.type = "button"; b.className = "valpick-chip";
          const nm = document.createElement("span"); nm.textContent = model ? (model.label[LANG] || model.key) : card.method;
          const rng = document.createElement("span"); rng.className = "vp-rng"; rng.textContent = `${lo} ~ ${hi}`;
          b.append(nm, rng);
          b.disabled = !usableValuationRange(card);
          b.addEventListener("click", () => {
            fieldInputs.fairLow.value = lo; fieldInputs.fairHigh.value = hi;
            fieldInputs.fairLow.classList.remove("bad"); fieldInputs.fairHigh.classList.remove("bad");
            if (fieldErrs.fairLow) fieldErrs.fairLow.style.display = "none";
            if (fieldErrs.fairHigh) fieldErrs.fairHigh.style.display = "none";
            item.cfg = { ...item.cfg, fairLow: lo, fairHigh: hi, selectedValuationId: card.id };
            item.gauge.set(item.cfg); renderVerdict(item); renderItemHead(item);
            if (cfgSavable(item.cfg)) debounceSave(item);
            syncValPick();
          });
          return { el: b, id: card.id };
        });
        chipEls.forEach(({ el }) => row.appendChild(el));
        syncValPick = () => chipEls.forEach(({ el, id }) => el.classList.toggle("on", item.cfg.selectedValuationId === id));
        syncValPick();
        pick.append(plab, row);
        grid.appendChild(pick);
      }
    }
  });
  modalForm.appendChild(grid);
}

function openItemModal(item, isNew) {
  modalItem = item; modalIsNew = isNew;
  modalSnapshot = { ...item.cfg }; // 取消时回滚到打开前的状态
  modalTitle.textContent = modalTitleFor(item);
  setSaveState("", "");
  btnModalRemove.classList.toggle("hidden", isNew && !item.id);
  buildItemForm(item);
  modalOverlay.classList.remove("hidden");
  const first = modalForm.querySelector("input");
  if (isNew && first) first.focus();
}
function closeItemModal() {
  if (!modalItem) return;
  const item = modalItem;
  // 新增但从未成功保存 → 丢弃卡片；若有迟到的保存（防抖/在途）落库，用 _discarded 标记兜底删除
  if (modalIsNew && !item.id) {
    item._discarded = true;
    clearTimeout(item._saveT);
    removeChart(item);
  }
  modalItem = null;
  modalOverlay.classList.add("hidden");
}
// 「完成」= 提交：逐字段校验，报错就近显示在对应输入下方
function trySubmitModal() {
  const item = modalItem;
  if (!item) return;
  const c = item.cfg;
  // 仅当全新表单「什么都没动」才视为放弃；否则逐字段校验
  const untouched = modalIsNew && !item.id && !c.symbol && !c.ticker && !(c.fairLow > 0) && !(c.fairHigh > 0);
  if (untouched) { closeItemModal(); return; }
  clearFieldErrs();
  let firstBad = null;
  const flag = (key, msg) => { showFieldErr(key, msg); if (!firstBad) firstBad = key; };
  if (!c.symbol) flag("ticker", t("m_err_symbol"));
  // 内在价值区间可选：两个都空 = 未估值，放行；只要填了一个就按完整区间校验
  if (c.fairLow > 0 || c.fairHigh > 0) {
    if (!(c.fairLow > 0)) flag("fairLow", t("m_err_low"));
    else if (!(c.fairHigh > c.fairLow) && !(selectedCard(c)?.scenarioMode === "single" && c.fairHigh === c.fairLow)) flag("fairHigh", t("m_err_high"));
    if (!(c.mos > 0 && c.mos < 100)) flag("mos", t("m_err_mos"));
    if (!(c.ext > 0)) flag("ext", t("m_err_ext"));
  }
  if (firstBad) { const el = fieldInputs[firstBad]; if (el) { el.focus(); el.scrollIntoView({ block: "nearest" }); } return; }
  clearTimeout(item._saveT);
  const wasNew = modalIsNew;
  saveItem(item);            // 立即提交（不等防抖）
  refreshDetailIfOpen(item); // 详情页正展示该标的时，同步钟摆/占位与判定
  modalItem = null;
  modalOverlay.classList.add("hidden");
  // 新加的标的：直接进它的详情页（下一步通常就是估值）；地址同步成 /b/<slug>/<代码>，返回键回到列表
  if (wasNew && c.ticker && viewDetail.classList.contains("hidden")) {
    history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug) + "/" + encodeURIComponent(String(c.ticker).toUpperCase()));
    showDetail(item);
  }
}
document.getElementById("btnModalDone").addEventListener("click", trySubmitModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeItemModal(); });
document.getElementById("btnModalCancel").addEventListener("click", async () => {
  if (!modalItem) return;
  const item = modalItem;
  clearTimeout(item._saveT); // 丢弃尚未发出的防抖保存
  if (modalIsNew) {
    // 新建取消：整个丢弃（期间已自动创建的也删掉）
    if (item.id) await fetch(`/api/my/items/${item.id}`, { method: "DELETE" });
    removeChart(item);
  } else {
    // 编辑取消：回滚到打开前的值；期间的自动保存用快照覆盖回去
    item.cfg = { ...modalSnapshot };
    item.live = false; item.gotQuote = false;
    if (structValid(item.cfg)) { item.gauge.set(item.cfg, false); renderVerdict(item); saveItem(item); }
    fetchQuotes();
  }
  modalItem = null;
  modalOverlay.classList.add("hidden");
});
async function requestRemoveItem(removed) {
  if (!(await confirmDialog({ message: t("m_confirm_remove"), confirmText: LANG === "zh" ? "确认移除" : "Remove", lang: LANG }))) return;
  try {
    if (removed.id) {
      const res = await fetch(`/api/my/items/${removed.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Remove failed");
    }
  } catch {
    showToast(LANG === "zh" ? "移除失败，请稍后重试" : "Could not remove this symbol. Please try again.", { tone: "bad" });
    return;
  }
  clearTimeout(removed._saveT);
  const wasOnDetail = detailItem === removed && !viewDetail.classList.contains("hidden");
  removeChart(removed);
  if (modalItem === removed) { modalItem = null; modalOverlay.classList.add("hidden"); }
  // 在该标的详情页删除 → 回到列表（否则详情页悬空）
  if (wasOnDetail) { detailItem = null; history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug)); showList(); }
}
btnModalRemove.addEventListener("click", () => { if (modalItem) requestRemoveItem(modalItem); });

/* ---------- 视图与路由：列表 / 设置 / 详情 ---------- */
const layoutEl = document.querySelector(".layout");
const viewSettings = document.getElementById("viewSettings");
const viewDetail = document.getElementById("viewDetail");
const viewValEdit = document.getElementById("viewValEdit");
const pageHeadEl = document.querySelector(".page-head");
const btnSettings = document.getElementById("btnSettings");
let detailGauge = null, detailItem = null, detailGwrap = null, detailIdBlock = null, detailValRefresh = null, detailAddValuation = null;
let detailGoFinancials = null;
let detailGoFund = null; // 切到基本面 tab 并滚到某一分节（AI 结论旁的迷你图点击用）

// ---------- 详情页「我的持仓」：资产页持仓表里这只股票的信息（数量、成本、盈亏、占比、目标偏离与建议、各账户） ----------
// 数据优先用资产页的会话缓存（同一份 /api/my/portfolio 返回），没有才请求一次；没持有也没设目标就不显示
async function portfolioData() {
  const user = sessionStorage.getItem(SESSION_KEYS.pfUser), base = localStorage.getItem(LOCAL_KEYS.pfBase) || (LANG === "zh" ? "CNY" : "USD");
  try { const c = JSON.parse(sessionStorage.getItem(pfCacheKey(user, base)) || "null"); if (c && c.data && Array.isArray(c.data.holdings)) return c.data; } catch { /* 没有缓存 */ }
  try { const r = await fetch("/api/my/portfolio?base=" + encodeURIComponent(base)); return r.ok ? await r.json() : null; } catch { return null; }
}
function zoneOfPrice(cfg, price) {
  if (!(price > 0) || !structValid({ ...cfg, price })) return -1;
  return Math.min(ZONES.length - 1, Math.floor(Math.max(0, Math.min(179.9, priceToPhi(computeAnchors(cfg), price))) / (180 / ZONES.length)));
}
async function renderHolding(item, card) {
  const d = await portfolioData();
  const c = item.cfg, zh = LANG === "zh", T = (a, b) => (zh ? a : b);
  const h = holdingFor(d, c.symbol, zoneOfPrice(c, c.price));
  if (!h || !card.isConnected) return;
  const hide = localStorage.getItem(LOCAL_KEYS.pfHide) === "1", MASK = "••••";
  const nf = (n, dg = 2) => new Intl.NumberFormat(zh ? "zh-CN" : "en-US", { minimumFractionDigits: dg, maximumFractionDigits: dg }).format(n);
  const money = (n, cur, dg = 0) => (hide ? MASK : Number.isFinite(n) ? (n < 0 ? "−" : "") + nf(Math.abs(n), dg) + (cur ? " " + cur : "") : "—");
  const signed = (n, cur) => (hide ? MASK : Number.isFinite(n) ? (n > 0 ? "+" : n < 0 ? "−" : "") + nf(Math.abs(n), 0) + (cur ? " " + cur : "") : "—");
  const pct = (n) => (Number.isFinite(n) ? (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1) + "%" : "—");
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  card.innerHTML = "";
  const head = mk("div", "vd-hold-head");
  const link = mk("a", "vd-hold-link"); link.href = "/portfolio"; link.append(document.createTextNode(T("资产页", "Portfolio")), ri("arrow-right-line"));
  head.append(mk("div", "vd-cardtitle", T("我的持仓", "My position")), link);
  card.appendChild(head);
  const TX = driftText(LANG);
  if (h.held) {
    const top = mk("div", "vd-hold-top");
    const v = mk("span", "vd-hold-v"); setNum(v, money(h.value, "", 0)); v.appendChild(mk("span", "vd-hold-cur", h.currency));
    top.append(v, mk("span", "vd-hold-pnl " + (h.pnl > 0 ? "up" : h.pnl < 0 ? "down" : ""), pct(h.pnlPct)));
    card.appendChild(top);
    const rows = mk("div", "vd-hold-rows");
    const kv = (k, val, cls) => { const r = mk("div", "vc-kv"); r.append(mk("span", "vc-kv-k", k), mk("span", "vc-kv-dots"), mk("span", "vc-kv-v " + (cls || ""), val)); rows.appendChild(r); };
    kv(T("数量", "Shares"), hide ? MASK : nf(h.qty, 0));
    kv(T("成本价", "Cost"), Number.isFinite(h.avgCost) ? nf(h.avgCost) : "—");
    kv(T("浮动盈亏", "Unrealised P/L"), signed(h.pnl, h.currency), h.pnl > 0 ? "up" : h.pnl < 0 ? "down" : "");
    if (Number.isFinite(h.day)) kv(T("今日", "Today"), signed(h.day, h.currency), h.day > 0 ? "up" : h.day < 0 ? "down" : "");
    kv(T("占总资产", "Of total assets"), h.weight.toFixed(1) + "%");
    card.appendChild(rows);
    // 成本落在自己设的哪个估值区间：买得贵不贵
    const cz = zoneOfPrice(c, h.avgCost);
    if (cz >= 0) {
      const names = zh ? ["击球区", "低估", "合理", "高估", "泡沫区"] : ["strike zone", "undervalued", "fair", "overvalued", "bubble"];
      const note = mk("div", "vd-hold-note"); const dot = mk("i"); dot.style.background = ZONES[cz].hex;
      note.append(dot, document.createTextNode(T(`按你的合理区间，成本价落在「${names[cz]}」`, `By your fair range, your cost sits in the ${names[cz]} zone`)));
      card.appendChild(note);
    }
  }
  if (h.plan) {
    const p = h.plan, box = mk("div", "vd-hold-plan " + p.status);
    const line = mk("div", "vd-hold-planline");
    line.append(mk("span", "", T(`目标 ${p.tgt.toFixed(1)}%`, `Target ${p.tgt.toFixed(1)}%`)),
      mk("span", "vd-hold-drift " + p.status, p.status === "build" ? T("未持有", "Not held") : (p.drift > 0 ? "+" : p.drift < 0 ? "−" : "") + Math.abs(p.drift).toFixed(1) + "%"));
    box.append(line, mk("div", "vd-hold-say " + p.action, TX[p.action]));
    if (p.status !== "ok" && Number.isFinite(p.trade) && p.trade) {
      const buy = p.trade > 0;
      box.appendChild(mk("div", "vd-hold-how", T(`回到目标约需${buy ? "买入" : "卖出"} ${money(Math.abs(p.trade), h.base)}`, `≈ ${buy ? "buy" : "sell"} ${money(Math.abs(p.trade), h.base)} to reach target`)
        + (Number.isFinite(p.shares) && p.shares && !hide ? T(`（约 ${nf(Math.abs(p.shares), 0)} 股）`, ` (~${nf(Math.abs(p.shares), 0)} sh)`) : "")));
    }
    card.appendChild(box);
  }
  if (h.accounts.length > 1) {
    const acc = mk("div", "vd-hold-accs");
    for (const a of h.accounts) { const r = mk("div", "vd-hold-acc"); r.append(mk("span", "", a.name), mk("span", "", `${hide ? MASK : nf(a.qty, 0)} · ${Number.isFinite(a.costPrice) ? nf(a.costPrice) : "—"}`)); acc.appendChild(r); }
    card.appendChild(acc);
  }
  card.hidden = false;
}

// 详情页钟摆区：已设区间→渲染完整钟摆；未设→占位卡片（直接填或加估值卡片）
function mountDetailPendulum(item) {
  if (!detailGwrap) return;
  // 同一只股票再次渲染（报价刷新、静态信息到达后整页重画）：沿用原钟摆，搬进新容器、只把指针挪到新价格。
  // 重建会让钟摆从头再摆一遍，看起来像「在最高点卡一下」
  if (detailGauge && detailGauge._sym === item.cfg.symbol && hasFairRange(item.cfg)) { // 按代码认（数据刷新后标的对象会重建）
    if (!detailGwrap.contains(detailGauge.svg)) { detailGwrap.innerHTML = ""; detailGwrap.appendChild(detailGauge.svg); }
    detailGauge.setName(displayName(item));
    detailGauge.set(item.cfg, true);
    return;
  }
  if (detailGauge) { detailGauge.destroy && detailGauge.destroy(); detailGauge = null; }
  detailGwrap.innerHTML = "";
  if (hasFairRange(item.cfg)) {
    detailGauge = new Gauge(detailGwrap); detailGauge._sym = item.cfg.symbol;
    detailGauge.setName(displayName(item));
    detailGauge.set(item.cfg, false);
    if (item.cfg.price > 0) detailGauge.swingIn();
    // 视觉裁剪：把 viewBox 收紧到实际绘制内容,去掉体块周围空白,让钟摆视觉更大(原 viewBox 约 1/4 是留白)
    const svg = detailGwrap.querySelector("svg");
    if (svg) requestAnimationFrame(() => {
      try { const b = svg.getBBox(); if (b.width && b.height) { const m = 8; svg.setAttribute("viewBox", `${b.x - m} ${b.y - m} ${b.width + 2 * m} ${b.height + 2 * m}`); } } catch {}
    });
  } else {
    detailGwrap.appendChild(buildValPlaceholder(item));
  }
}

// 未估值占位：极简扁平条 + 文案 + CTA（打开标的编辑弹窗直接填区间）
function buildValPlaceholder(item) {
  // 侧栏钟摆的未估值占位：说明状态；主人多一个「添加估值」按钮（访客只看提示）
  const box = document.createElement("div"); box.className = "vge";
  const bar = document.createElement("div"); bar.className = "vge-bar"; bar.setAttribute("aria-hidden", "true");
  const title = document.createElement("div"); title.className = "vge-title";
  title.textContent = LANG === "zh" ? "尚未设定内在价值" : "No fair value yet";
  const method = document.createElement("a"); method.className = "vge-method"; method.href = "/valuation"; method.replaceChildren(document.createTextNode(t("d_method")), ri("arrow-right-line"));
  box.append(bar, title);
  if (owner) {
    const addv = document.createElement("button"); addv.type = "button"; addv.className = "btn sm primary vge-add";
    addv.append(ri("add-line"), document.createTextNode(LANG === "zh" ? "添加估值" : "Add valuation"));
    addv.addEventListener("click", () => { if (detailAddValuation) detailAddValuation(); });
    box.appendChild(addv);
  }
  box.appendChild(method);
  return box;
}

// 标的编辑保存后，若详情页正展示同一标的，刷新钟摆/占位 + 顶部判定
function refreshDetailIfOpen(item) {
  if (detailItem !== item || viewDetail.classList.contains("hidden")) return;
  mountDetailPendulum(item);
  if (detailIdBlock) {
    const c = item.cfg, s = item.statics || {};
    const nameEl = detailIdBlock.querySelector(".vd-name"); if (nameEl) nameEl.textContent = displayName(item);
    const codeEl = detailIdBlock.querySelector(".vd-code"); if (codeEl) codeEl.textContent = (c.ticker || "").toUpperCase();
    const priceEl = detailIdBlock.querySelector(".vd-price"); if (priceEl) setNum(priceEl, c.price > 0 ? VMSGS.px(c.price) : "—");
    const vv = verdictOf(c, VMSGS);
    const vEl = detailIdBlock.querySelector(".vd-verdict");
    if (vEl) { vEl.textContent = vv.text; vEl.className = "vd-verdict " + vv.cls; }
  }
  if (detailValRefresh) detailValRefresh(); // 估值研究摘要（区间/阈值/判定）同步
}

function showView(v) { // "list" | "settings" | "detail" | "valedit"
  const isList = v === "list", isSettings = v === "settings", isDetail = v === "detail", isValEdit = v === "valedit";
  if (!isValEdit) valEditReturn = null; // 离开编辑器视图即清状态
  pageHeadEl.classList.toggle("hidden", !isList);
  document.getElementById("strikeBanner").classList.toggle("offview", !isList); // 只在列表视图显示
  document.getElementById("reviewBanner").classList.toggle("offview", !isList);
  layoutEl.classList.toggle("hidden", !isList);
  viewSettings.classList.toggle("hidden", !isSettings);
  viewDetail.classList.toggle("hidden", !isDetail);
  viewValEdit.classList.toggle("hidden", !isValEdit);
  document.body.classList.toggle("vd-mode", isDetail); // 详情页锁窗口滚动,右栏独立滚 + tab 吸顶
  document.body.classList.toggle("ve-mode", isValEdit); // 添加估值页:仅隐藏 header(普通表单滚动)
  document.querySelectorAll(".nav-tab").forEach((x) => x.classList.toggle("on", x.dataset.view === "board" && (isList || isDetail || isValEdit)));
  btnSettings.classList.toggle("on", isSettings);
}
function showList() { showView("list"); }
function showSettings() { showView("settings"); }
function showDetail(item, initialTab) { renderDetail(item, initialTab); showView("detail"); window.scrollTo(0, 0); }

function renderDetail(item, initialTab = "val") {
  const c = item.cfg, s = item.statics || {};
  viewDetail.innerHTML = "";
  // 钟摆不在这里销毁：mountDetailPendulum 会判断是不是同一只股票（同一只就沿用，避免重摆）
  detailItem = item;

  // 顶栏：返回 / 语言（「编辑」挪进了侧栏钟摆卡的标题栏：区间、安全边际、泡沫阈值都是钟摆的设定）
  const backRow = document.createElement("div"); backRow.className = "vd-backrow";
  const back = document.createElement("a"); back.className = "vd-back"; back.href = "/b/" + boardSlug; back.replaceChildren(ri("arrow-left-line"), document.createTextNode(t("d_back")));
  back.addEventListener("click", (e) => { e.preventDefault(); history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug)); showList(); });
  backRow.appendChild(back);
  const rightGroup = document.createElement("div"); rightGroup.className = "vd-backrow-right";
  mountLangMenu(rightGroup);
  mountFeedback(rightGroup);
  backRow.appendChild(rightGroup);

  // 身份区：头像 + 代码徽章 + 名称 / 现价 + 当日涨跌 + 判定
  const idBlock = document.createElement("div"); idBlock.className = "vd-hero";
  const v = verdictOf(c, VMSGS);
  idBlock.innerHTML = `<div class="vd-avatar" aria-hidden="true"></div>
    <div class="vd-heroid"><div class="vd-name"></div><div class="vd-meta"><span class="vd-code"></span><span class="vd-metatext"></span></div></div>
    <div class="vd-quote"><div class="vd-price"></div><div class="vd-chg"></div><div class="vd-verdict ${v.cls}"></div></div>`;
  mountLogo(idBlock.querySelector(".vd-avatar"), item);
  idBlock.querySelector(".vd-name").textContent = displayName(item);
  idBlock.querySelector(".vd-code").textContent = (c.ticker || "").toUpperCase();
  const mkt = (c.symbol || "").slice(0, 2);
  idBlock.querySelector(".vd-metatext").textContent = [LANG === "zh" ? MKT_LABEL[mkt] : mkt.toUpperCase(), s.exchange, s.currency].filter(Boolean).join(" · ");
  setNum(idBlock.querySelector(".vd-price"), c.price > 0 ? VMSGS.px(c.price) : "—");
  renderDayChange(item, idBlock.querySelector(".vd-chg"));
  idBlock.querySelector(".vd-verdict").textContent = v.text === "—" ? t("ov_none") : v.text;
  detailIdBlock = idBlock;

  // 关键数据放在右侧钟摆上方；主栏直接展示估值研究 tabs。
  const statsCard = document.createElement("section"); statsCard.className = "vd-card vd-stats";
  renderKeyStats(item, statsCard);

  const tabsNav = document.createElement("div"); tabsNav.className = "vd-tabs";
  const panels = document.createElement("div");
  // 估值研究排第一（默认 tab）：这是价值投资工具的主线；基本面与财报是它的依据
  const defs = [
    { label: t("d_tab_valuation"), kind: "val" },
    { label: t("d_tab_fundamentals"), kind: "fund" },
    { label: t("d_tab_financials"), kind: "fin" },
  ];
  const tabEls = [], panelEls = [];
  defs.forEach((d, i) => {
    const on = d.kind === initialTab;
    const b = document.createElement("button"); b.className = "vd-tab" + (on ? " on" : ""); b.textContent = d.label;
    const p = document.createElement("div"); p.className = "vd-panel p-" + d.kind + (on ? " on" : "");
    b.addEventListener("click", () => { tabEls.forEach((x) => x.classList.remove("on")); panelEls.forEach((x) => x.classList.remove("on")); b.classList.add("on"); p.classList.add("on"); });
    tabsNav.appendChild(b); panels.appendChild(p); tabEls.push(b); panelEls.push(p);
  });
  const panelOf = (kind) => panelEls[defs.findIndex((d) => d.kind === kind)];
  detailGoFinancials = () => { tabEls[defs.findIndex((d) => d.kind === "fin")].click(); panelOf("fin").scrollIntoView({ block: "start", behavior: "auto" }); };
  detailGoFund = (sec) => {
    tabEls[defs.findIndex((d) => d.kind === "fund")].click();
    const p = panelOf("fund");
    // 基本面面板在年报到达后才画出分节；它的 then 先注册，所以这里拿到时分节已在
    loadFinancials(item, "annual").then(() => requestAnimationFrame(() => {
      const s = sec ? p.querySelector(`[data-fd-sec="${sec}"]`) : null;
      (s || p).scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      if (s) { s.classList.add("fd-flash"); setTimeout(() => s.classList.remove("fd-flash"), 1200); }
    }));
  };
  renderValuationPanel(item, panelOf("val"), idBlock);
  renderFundamentalsPanel(item, panelOf("fund"));
  renderFinancialsPanel(item, panelOf("fin"));
  loadFinancials(item, "annual"); // 预取年报，供计算器预填
  loadFinancials(item, "quarter"); // 预取季报，供「最新季 / 近4季 TTM」参考
  // tabs 与内容共用左侧大卡，内部各分节不再重复套卡。
  const main = document.createElement("section"); main.className = "vd-main"; main.append(tabsNav, panels);
  const mainCol = document.createElement("div"); mainCol.className = "vd-maincol"; mainCol.append(main);

  // 侧栏：关键数据 + 估值钟摆 + 同看板标的
  const gwrap = document.createElement("div"); gwrap.className = "vd-gauge";
  detailGwrap = gwrap;
  const pendCard = document.createElement("section"); pendCard.className = "vd-card vd-pendcard";
  const pendLab = document.createElement("div"); pendLab.className = "vd-cardtitle"; pendLab.textContent = LANG === "zh" ? "估值钟摆" : "Valuation pendulum";
  const pendSub = document.createElement("div"); pendSub.className = "vd-cardsub";
  pendSub.textContent = LANG === "zh" ? "现价落在你设定的五个估值区间中的哪一段" : "Where the price sits across your five valuation zones";
  const pendHead = document.createElement("div"); pendHead.className = "vd-pendhead"; pendHead.appendChild(pendLab);
  if (owner) {
    // 低频设定（安全边际、泡沫阈值、手动区间、移除标的）收成一个齿轮图标，主行动「添加估值」在卡片中间
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "btn icon sm vd-pendedit";
    edit.appendChild(ri("settings-3-line"));
    const tip = LANG === "zh" ? "钟摆设置：安全边际、泡沫阈值、手动区间、移除标的" : "Pendulum settings: margin of safety, bubble threshold, manual range, remove";
    edit.title = tip; edit.setAttribute("aria-label", tip);
    edit.addEventListener("click", () => openItemModal(item, false));
    pendHead.appendChild(edit);
  }
  pendCard.append(pendHead, pendSub, gwrap);
  const peers = document.createElement("section"); peers.className = "vd-card vd-peers";
  renderPeers(item, peers);
  const side = document.createElement("aside"); side.className = "vd-side"; side.append(statsCard, pendCard, peers);
  if (owner) { const hold = document.createElement("section"); hold.className = "vd-card vd-hold"; hold.hidden = true; side.insertBefore(hold, peers); renderHolding(item, hold); }

  const cols = document.createElement("div"); cols.className = "vd-cols"; cols.append(mainCol, side);
  viewDetail.append(backRow, idBlock, cols);
  mountDetailPendulum(item);               // 已设区间→钟摆；未设→占位卡片
}

// 当日涨跌：现价 − 昨收（昨收来自腾讯；拿不到就不显示）
function renderDayChange(item, el) {
  const p = item.cfg.price, pc = item.prevClose;
  if (!(p > 0 && pc > 0)) { el.textContent = ""; el.className = "vd-chg"; return; }
  const d = p - pc, pct = d / pc * 100, sign = d > 0 ? "+" : d < 0 ? "−" : "";
  el.textContent = `${sign}${Math.abs(d).toFixed(Math.abs(d) >= 100 ? 0 : 2)} (${sign}${Math.abs(pct).toFixed(2)}%)`;
  el.className = "vd-chg " + (d > 0 ? "up" : d < 0 ? "down" : "");
}

/* ---------- 关键数据 ---------- */
function renderKeyStats(item, card) {
  const c = item.cfg, s = item.statics || {}, cur = s.currency || "";
  const shares = Number(s.totalShares) || 0, eps = parseFloat(s.epsTtm);
  // 市盈率优先用「现价 ÷ 每股收益」，保证与旁边的 EPS 同一口径；拿不到 EPS 才用腾讯行情里的 PE
  const pe = c.price > 0 && eps > 0 ? c.price / eps : parseFloat(s.peTtm);
  // 市净率 = 现价 ÷ 每股净资产；股息率 = 每股股利 ÷ 现价（长桥 dividendYield 字段实为每股股利金额，见 intrinsic.js）
  const bps = parseFloat(s.bps), dps = parseFloat(s.dividendYield);
  const pb = c.price > 0 && bps > 0 ? c.price / bps : NaN;
  const dy = c.price > 0 && Number.isFinite(dps) && dps >= 0 && s.dividendYield !== "" ? dps / c.price * 100 : NaN;
  const rows = [
    [t("d_market_cap"), c.price > 0 && shares ? fmtBig(c.price * shares, cur) : "—", cur],
    [t("d_pe_ttm"), Number.isFinite(pe) ? pe.toFixed(1) : "—", ""],
    [t("d_eps_ttm"), Number.isFinite(eps) ? eps.toFixed(2) : "—", Number.isFinite(eps) ? cur : ""],
    [t("d_shares"), shares ? fmtBig(shares, cur) : "—", ""],
    [t("d_hi52"), fmtPx(parseFloat(s.high52)), ""],
    [t("d_lo52"), fmtPx(parseFloat(s.low52)), ""],
    [t("d_pb"), Number.isFinite(pb) ? pb.toFixed(2) : "—", ""],
    [t("d_div_yield"), Number.isFinite(dy) ? dy.toFixed(2) + "%" : "—", ""],
  ];
  card.innerHTML = `<div class="vd-cardhead"><span class="vd-cardtitle"></span></div><div class="ks-grid"></div>`;
  card.querySelector(".vd-cardtitle").textContent = t("d_stats");
  const grid = card.querySelector(".ks-grid");
  rows.forEach(([k, val, unit]) => {
    const cell = document.createElement("div"); cell.className = "ks-cell";
    cell.innerHTML = `<span class="ks-k"></span><span class="ks-v"></span>`;
    cell.querySelector(".ks-k").textContent = k;
    const ve = cell.querySelector(".ks-v"); ve.textContent = val;
    if (unit && val !== "—") { const u = document.createElement("small"); u.textContent = " " + unit; ve.appendChild(u); }
    grid.appendChild(cell);
  });
}

/* ---------- 同看板标的 ---------- */
function renderPeers(item, card) {
  card.innerHTML = `<div class="vd-cardhead"><span class="vd-cardtitle"></span></div><div class="peer-list"></div>`;
  card.querySelector(".vd-cardtitle").textContent = t("d_peers");
  const list = card.querySelector(".peer-list");
  const others = items.filter((i) => i !== item && i.cfg.symbol && i.cfg.ticker);
  if (!others.length) { card.style.display = "none"; return; }
  others.forEach((o) => {
    const v = verdictOf(o.cfg, VMSGS);
    const b = document.createElement("button"); b.type = "button"; b.className = "peer";
    b.innerHTML = `<span class="peer-av" aria-hidden="true"></span><span class="peer-id"><span class="peer-name"></span><span class="peer-code"></span></span><span class="peer-q"><span class="peer-px"></span><span class="peer-v"></span></span>`;
    mountLogo(b.querySelector(".peer-av"), o);
    b.querySelector(".peer-name").textContent = displayName(o);
    b.querySelector(".peer-code").textContent = o.cfg.ticker.toUpperCase();
    b.querySelector(".peer-px").textContent = o.cfg.price > 0 ? fmtPx(o.cfg.price) : "—";
    const ve = b.querySelector(".peer-v"); ve.textContent = v.text === "—" ? t("ov_none") : v.text; ve.classList.add(v.cls);
    b.addEventListener("click", () => {
      history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug) + "/" + encodeURIComponent(o.cfg.ticker.toUpperCase()));
      showDetail(o);
    });
    list.appendChild(b);
  });
}

const aiSparkEl = (metric, financials, dividends, cur) => _aiSparkEl(metric, financials, dividends, cur, (sec) => { if (detailGoFund) detailGoFund(sec); });

// 基本面面板：01 盈利与现金 / 02 回报与利润率 / 03 资产负债表 / 04 资本配置
// AI 解读：十年财报 → 三条要点 + 一两个风险；用户点了才调用，结果按「标的 + 语言」缓存在本次会话
function fundBriefEl(item, financials, dividends) {
  const zh = LANG === "zh", st = item.statics || {}, sym = item.cfg.symbol || "";
  const key = "fd_brief_" + sym + "_" + LANG;
  const box = document.createElement("div"); box.className = "fd-sec fd-brief";
  const head = document.createElement("div"); head.className = "fd-brief-head";
  const ttl = document.createElement("div"); ttl.className = "fd-brief-title";
  ttl.append(ri("sparkling-2-fill"), document.createTextNode(zh ? "AI 解读" : "AI summary"));
  const sub = document.createElement("div"); sub.className = "fd-brief-sub";
  sub.textContent = zh ? "把十年财报浓缩成三条要点和风险，帮你判断值不值得深入研究" : "Ten years of statements in three points and the risks — is it worth a deeper look?";
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "vc-note-ai";
  const body = document.createElement("div"); body.className = "fd-brief-body";
  const err = document.createElement("div"); err.className = "vc-note-err"; err.hidden = true;
  const txt = document.createElement("div"); txt.append(ttl, sub);
  head.append(txt, btn); box.append(head, body, err);
  const setBtn = (busy, again) => { btn.disabled = busy; btn.replaceChildren(ri(busy ? "loader-4-line" : again ? "refresh-line" : "sparkling-2-fill"), document.createTextNode(busy ? (zh ? "解读中…" : "Reading…") : again ? (zh ? "重新生成" : "Regenerate") : (zh ? "生成解读" : "Summarize"))); };
  const show = (b) => {
    body.replaceChildren();
    const ul = document.createElement("ul"); ul.className = "fd-brief-list";
    // 每条 {text, metric?}（会话里缓存的老结果是纯字符串）；有指标且有数据就在右侧挂迷你图
    const row = (x, cls, icon) => {
      const it = typeof x === "string" ? { text: x } : x || {};
      const li = document.createElement("li"); if (cls) li.className = cls;
      const tx = document.createElement("span"); tx.textContent = it.text || "";
      li.append(ri(icon), tx);
      const sp = aiSparkEl(it.metric, financials, dividends, st.currency || ""); if (sp) li.appendChild(sp);
      ul.appendChild(li);
    };
    for (const p of b.points) row(p, "", "checkbox-blank-circle-fill");
    for (const r of b.risks) row(r, "risk", "error-warning-line");
    const foot = document.createElement("div"); foot.className = "fd-brief-foot";
    foot.textContent = zh ? "AI 根据财报数据生成，可能有误；不构成投资建议" : "Generated by AI from the statements; may be wrong. Not investment advice.";
    body.append(ul, foot);
  };
  let cached = null; try { cached = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { cached = null; }
  if (cached && cached.points) { show(cached); setBtn(false, true); } else setBtn(false, false);
  btn.addEventListener("click", async () => {
    setBtn(true); err.hidden = true;
    try {
      const [quarter, research] = await Promise.all([loadFinancials(item, "quarter").catch(() => null),
        fetch("/api/research?symbol=" + encodeURIComponent(sym)).then((r) => r.json()).then((j) => j.research).catch(() => null)]);
      const req = {
        lang: LANG,
        stock: { name: displayName(item), code: (item.cfg.ticker || "").toUpperCase(), currency: st.currency || "" },
        verified: verifiedFacts({ financials, dividends, dps: parseFloat(st.dividendYield), financial: isFinancialCompany(research), lang: LANG }),
        metrics: latestMetrics({ financials, financialsQ: quarter && quarter.financials, lang: LANG }),
        market: marketViews({ research, financials, price: item.cfg.price, market: sym.slice(0, 2), lang: LANG }),
        lenses: masterLenses({ financials, research, price: item.cfg.price, eps: parseFloat(st.epsTtm), bps: parseFloat(st.bps), lang: LANG }),
      };
      const r = await fetch("/api/my/ai/brief", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.brief) throw new Error(aiErrorText(r.status, j, LANG));
      try { sessionStorage.setItem(key, JSON.stringify(j.brief)); } catch { /* 存不下就不缓存 */ }
      show(j.brief); setBtn(false, true);
    } catch (e) {
      err.textContent = (zh ? "解读失败：" : "Summary failed: ") + (e && e.message || e); err.hidden = false;
      setBtn(false, !!body.firstChild);
    }
  });
  return box;
}
function renderFundamentalsPanel(item, panel) {
  const skc = (h) => `<div class="sk-card" style="margin-bottom:14px" aria-hidden="true"><div class="sk-row"><span class="sk sk-line" style="width:140px;height:16px"></span><span class="sk-grow"></span><span class="sk sk-line" style="width:70px;height:28px"></span></div><span class="sk" style="height:${h}px;border-radius:16px"></span><span class="sk sk-line" style="width:55%"></span></div>`;
  panel.innerHTML = skc(180) + skc(120) + skc(150);
  const cur = (item.statics && item.statics.currency) || "";
  loadFinancials(item, "annual").then(({ financials, dividends }) => {
    panel.innerHTML = "";
    if (!financials || !financials.IS) { panel.innerHTML = `<div class="fd-empty">${t("d_no_fundamentals")}</div>`; return; }
    const zh = LANG === "zh";
    if (owner) panel.appendChild(fundBriefEl(item, financials, dividends));
    const sec = (n, title, sub, heroV, heroJ, heroCls) => {
      const s = document.createElement("div"); s.className = "fd-sec"; s.dataset.fdSec = n;
      const h = document.createElement("div"); h.className = "fd-head";
      h.innerHTML = `<span class="fd-num">${n}</span><span class="fd-title">${title}${sub ? `<span class="sub">· ${sub}</span>` : ""}</span>`
        + (heroV ? `<span class="fd-hero"><span class="fd-herov">${heroV}</span><div class="fd-heroj ${heroCls || ""}">${heroJ || ""}</div></span>` : "");
      s.appendChild(h); panel.appendChild(s); return s;
    };
    const NI = fdSeries(financials, "IS", "NetProfit");
    const FCF = fdSeries(financials, "CF", "NetFreeCashFlow");
    const REV = fdSeries(financials, "IS", "OperatingRevenue");

    // 01 盈利与现金
    if (NI.length) {
      const fcfM = FCF.filter((f) => NI.find((y) => y.year === f.year)), niM = NI.filter((x) => FCF.find((y) => y.year === x.year));
      const sumNI = niM.reduce((a, b) => a + b.value, 0), sumF = fcfM.reduce((a, b) => a + b.value, 0);
      const ratio = sumNI ? sumF / sumNI : NaN;
      let hj = "", hc = "";
      if (Number.isFinite(ratio)) { if (ratio >= 0.8) { hj = zh ? "现金扎实" : "Cash-backed"; hc = "good"; } else if (ratio >= 0.4) { hj = zh ? "现金 < 账面利润" : "Cash < earnings"; } else { hj = zh ? "FCF 远低于利润 · 重资本" : "FCF ≪ earnings"; hc = "bad"; } }
      const s = sec("01", zh ? "盈利与现金" : "Earnings & cash", "", Number.isFinite(ratio) ? `${ratio.toFixed(2)}<span class="u">×</span>` : "—", (zh ? "近 " + niM.length + " 年累计 FCF/净利 · " : niM.length + "y cum. FCF/NI · ") + hj, hc);
      if (FCF.length) {
        s.appendChild(fdChartWrap(fdBarLine(NI, FCF, (v) => fdMoney(v, cur)), NI.map((d) => d.year), [
          { label: zh ? "净利润" : "Net income", data: NI, color: "var(--chart-1)", fmt: (v) => fdMoney(v, cur) },
          { label: zh ? "自由现金流" : "Free cash flow", data: FCF, color: "var(--chart-2)", fmt: (v) => fdMoney(v, cur) },
        ]));
        const lg = document.createElement("div"); lg.className = "fd-legend";
        lg.innerHTML = `<span><i class="swb" style="background:var(--chart-1)"></i>${zh ? "净利润" : "Net income"}</span>`
          + `<span><i class="swb" style="background:var(--chart-neg)"></i>${zh ? "亏损年" : "Loss yr"}</span>`
          + `<span><i class="swl"></i>${zh ? "自由现金流" : "Free cash flow"}</span>`;
        s.appendChild(lg);
      } else { s.appendChild(fdChartWrap(fdBars(NI, false, 180, (v) => fdMoney(v, cur)), NI.map((d) => d.year), [{ label: zh ? "净利润" : "Net income", data: NI, color: "var(--chart-1)", fmt: (v) => fdMoney(v, cur) }])); }
      const niMin = Math.min(...NI.map((x) => x.value)), niMax = Math.max(...NI.map((x) => x.value));
      // FCF vs 净利润 关系按累计比值如实描述(不再写死"长期低于")
      let fcfClause = "";
      if (FCF.length && Number.isFinite(ratio)) fcfClause = zh
        ? (ratio >= 1.1 ? "，自由现金流累计高于净利润、现金质量好" : ratio >= 0.8 ? "，自由现金流与净利润大致相当" : ratio >= 0.4 ? "，自由现金流低于净利润" : "，自由现金流远低于净利润、偏重资本")
        : (ratio >= 1.1 ? "; FCF exceeds net income — strong cash quality" : ratio >= 0.8 ? "; FCF roughly tracks net income" : ratio >= 0.4 ? "; FCF runs below net income" : "; FCF far below net income — capital-heavy");
      // 仅在有亏损年(真·周期/困境)时提示用正常化口径
      const normTail = niMin < 0 ? (zh ? "——含亏损年,别用任一单年,看穿越周期的正常化口径" : " — has loss years; judge on a normalized, through-cycle basis") : "";
      const co = document.createElement("div"); co.className = "fd-callout";
      co.innerHTML = zh
        ? `近 ${NI.length} 年净利润在 <b>${fdMoney(niMin, cur)} ~ ${fdMoney(niMax, cur)}</b> 间波动${fcfClause}${normTail}。`
        : `Net income over ${NI.length}y ranged <b>${fdMoney(niMin, cur)} ~ ${fdMoney(niMax, cur)}</b>${fcfClause}${normTail}.`;
      s.appendChild(co);
    }

    // 02 回报与利润率
    const ROE = fdSeries(financials, "IS", "ROE"), GM = fdSeries(financials, "IS", "GrossMgn"), NM = fdSeries(financials, "IS", "NetProfitMargin"), TA = fdSeries(financials, "BS", "TotalAssets");
    const ROA = fdDerive(NI, TA, (ni, ta) => (ta ? ni / ta * 100 : null));
    const metrics = [
      { lab: "ROE", s: ROE }, { lab: "ROA", s: ROA },
      { lab: zh ? "毛利率" : "Gross margin", s: GM }, { lab: zh ? "净利率" : "Net margin", s: NM },
    ].filter((m) => m.s.length);
    if (metrics.length) {
      const roeLast = fdLast(ROE), roeVals = ROE.map((x) => x.value);
      const volatile = ROE.length && (Math.max(...roeVals) - Math.min(...roeVals) > 25);
      const heroM = Number.isFinite(roeLast) ? null : metrics[0], heroLast = heroM ? fdLast(heroM.s) : roeLast;
      const s = sec("02", zh ? "回报与利润率" : "Returns & margins", zh ? "护城河代理" : "moat proxy",
        Number.isFinite(heroLast) ? `${heroLast.toFixed(1)}<span class="u">%</span>` : "—",
        heroM ? (zh ? `${heroM.lab} 当期` : `${heroM.lab} latest`) : zh ? (volatile ? "ROE 强周期,非稳定高回报" : "ROE 当期") : (volatile ? "ROE highly cyclical" : "ROE latest"), "");
      const grid = document.createElement("div"); grid.className = "fd-mgrid";
      metrics.forEach((m) => {
        const c = document.createElement("div"); c.className = "fd-mcell"; const last = fdLast(m.s);
        c.innerHTML = `<div class="fd-mlab">${m.lab}</div><div class="fd-spwrap"></div><div class="fd-mval">${Number.isFinite(last) ? last.toFixed(1) : "—"}<span class="u">%</span></div><div class="fd-mtr">${fdRange(m.s)}</div>`;
        c.querySelector(".fd-spwrap").appendChild(fdChartWrap(fdSpark(m.s), m.s.map((d) => d.year), [{ label: m.lab, data: m.s, color: "var(--chart-1)", fmt: (v) => v.toFixed(1) + "%" }], { W: 120, PADX: 0 })); grid.appendChild(c);
      });
      s.appendChild(grid);
    }

    // 03 资产负债表
    const ND = fdSeries(financials, "BS", "NetDebt"), TL = fdSeries(financials, "BS", "TotalLiability"), LV = fdSeries(financials, "BS", "Leverage"), OI = fdSeries(financials, "IS", "OperatingIncome");
    if (ND.length) {
      const ndLast = fdLast(ND), oiLast = fdLast(OI);
      const ndOi = (Number.isFinite(ndLast) && Number.isFinite(oiLast) && oiLast > 0) ? ndLast / oiLast : NaN;
      let hj = "", hc = "", heroV;
      if (ndLast <= 0) { hj = zh ? "净现金 · 无偿债压力" : "Net cash"; hc = "good"; heroV = zh ? "净现金" : "Net cash"; }
      else { heroV = Number.isFinite(ndOi) ? `${ndOi.toFixed(1)}<span class="u">×</span>` : fdMoney(ndLast, cur);
        if (Number.isFinite(ndOi)) { if (ndOi < 1) { hj = zh ? "杠杆低 · 扛得住周期" : "Low leverage"; hc = "good"; } else if (ndOi < 3) { hj = zh ? "杠杆温和" : "Moderate leverage"; } else { hj = zh ? "杠杆偏高" : "Elevated leverage"; hc = "bad"; } } }
      const s = sec("03", zh ? "资产负债表" : "Balance sheet", zh ? "先排雷" : "survival first", heroV, (ndLast > 0 && Number.isFinite(ndOi) ? (zh ? "净负债/营业利润 · " : "NetDebt/EBIT · ") : "") + hj, hc);
      s.appendChild(fdChartWrap(fdBars(ND, true, 150, (v) => fdMoney(v, cur)), ND.map((d) => d.year), [{ label: zh ? "净负债" : "Net debt", data: ND, color: "var(--chart-1)", fmt: (v) => fdMoney(v, cur) }]));
      const ndLg = document.createElement("div"); ndLg.className = "fd-legend";
      ndLg.innerHTML = `<span><i class="swb" style="background:var(--chart-1)"></i>${zh ? "净负债" : "Net debt"}</span><span><i class="swb" style="background:var(--chart-2)"></i>${zh ? "净现金（负值）" : "Net cash (negative)"}</span>`;
      s.appendChild(ndLg);
      const stats = document.createElement("div"); stats.className = "fd-stats";
      const debtAssets = (TL.length && TA.length && fdLast(TA)) ? fdLast(TL) / fdLast(TA) * 100 : NaN;
      stats.innerHTML = `<span class="fd-stat"><b>${fdMoney(ndLast, cur)}</b>${zh ? "净负债" : "Net debt"}</span>`
        + (Number.isFinite(debtAssets) ? `<span class="fd-stat"><b>${debtAssets.toFixed(0)}%</b>${zh ? "资产负债率" : "Debt / assets"}</span>` : "")
        + (LV.length ? `<span class="fd-stat"><b>${fdLast(LV).toFixed(2)}×</b>${zh ? "权益乘数" : "Equity mult."}</span>` : "");
      s.appendChild(stats);
    }

    // 04 资本配置
    const BPS = fdSeries(financials, "BS", "BPS"), CAP = fdSeries(financials, "CF", "CapEx"), OCFC = fdSeries(financials, "CF", "OCFCoverage");
    // 流通股数 ≈ 股东权益 / 每股净资产（比 净利/EPS 稳健：微利年 EPS 趋近 0 会让 净利/EPS 失真暴增）
    const EQ = fdDerive(TA, TL, (ta, tl) => ta - tl);
    const SH = fdDerive(EQ, BPS, (eq, bps) => (bps ? eq / bps : null));
    if (SH.length > 1) {
      // 按「近年趋势」判断(约 5 年前 vs 最新),避免十年前一次性增发把长期平稳误判为持续稀释
      const last = SH[SH.length - 1].value, ref = SH[Math.max(0, SH.length - 5)].value;
      let hj = "", hc = "";
      if (last < ref * 0.97) { hj = zh ? "近年回购" : "Buyback"; hc = "good"; }
      else if (last > ref * 1.03) { hj = zh ? "近年稀释" : "Diluting"; hc = "bad"; }
      else { hj = zh ? "股本平稳" : "Roughly flat"; }
      const s = sec("04", zh ? "资本配置" : "Capital allocation", zh ? "钱去哪了" : "where cash goes",
        `${(last / 1e9).toFixed(2)}<span class="u">B</span>`, (zh ? "流通股数 · " : "Shares · ") + hj, hc);
      s.appendChild(fdChartWrap(fdLineChart(SH, 130, (v) => (v / 1e9).toFixed(2) + "B"), SH.map((d) => d.year), [{ label: zh ? "流通股数" : "Shares", data: SH, color: "var(--chart-1)", fmt: (v) => (v / 1e9).toFixed(2) + "B" }]));
      const stats = document.createElement("div"); stats.className = "fd-stats";
      const capInt = (CAP.length && REV.length && fdLast(REV)) ? Math.abs(fdLast(CAP)) / fdLast(REV) * 100 : NaN;
      stats.innerHTML = (Number.isFinite(capInt) ? `<span class="fd-stat"><b>${capInt.toFixed(0)}%</b>${zh ? "capex / 营收" : "capex / rev"}</span>` : "")
        + (OCFC.length ? `<span class="fd-stat"><b>${fdLast(OCFC).toFixed(0)}%</b>${zh ? "经营现金流覆盖" : "OCF coverage"}</span>` : "")
        + (FCF.length ? `<span class="fd-stat"><b>${fdMoney(fdLast(FCF), cur)}</b>${zh ? "最新自由现金流" : "Latest FCF"}</span>` : "");
      s.appendChild(stats);
    }

    // 05 股东回报：逐年每股现金分红（东财全市场）+ 连续派息年数 + 股息率/分红率
    const dps0 = parseFloat((item.statics || {}).dividendYield), epsT0 = parseFloat((item.statics || {}).epsTtm), px0 = item.cfg.price;
    const divHist = (dividends && Array.isArray(dividends.years) && dividends.years.length) ? dividends : null;
    if (divHist || (Number.isFinite(dps0) && dps0 > 0)) {
      const dcur = (divHist && dividends.currency) || cur;
      const dseries = divHist ? dividends.years.slice(-10).map((y) => ({ year: y.year, value: y.perShare })) : [];
      // 连续派息年数：从最新年份往回，逐年（year=前一年-1 且 >0）计数
      let streak = 0;
      if (divHist) { const ys = dividends.years; let prev = null; for (let i = ys.length - 1; i >= 0; i--) { if (ys[i].perShare > 0 && (prev === null || ys[i].year === prev - 1)) { streak++; prev = ys[i].year; } else break; } }
      // 每股股利：优先用历史最新一期，回退 statics
      const dpsLatest = divHist ? dividends.years[dividends.years.length - 1].perShare : dps0;
      const divYield = (Number.isFinite(dpsLatest) && px0 > 0) ? dpsLatest / px0 * 100 : NaN;
      const payout = (Number.isFinite(dpsLatest) && Number.isFinite(epsT0) && epsT0 > 0) ? dpsLatest / epsT0 * 100 : NaN;
      const heroV = divHist ? `${streak}<span class="u">${zh ? "年" : "y"}</span>` : `${dpsLatest.toFixed(2)}<span class="u"> ${dcur}</span>`;
      const heroJ = divHist ? (zh ? "连续派息" : "Consecutive payouts") : (zh ? "每股股利 · 仅最新一期" : "DPS · latest only");
      const s = sec("05", zh ? "股东回报" : "Shareholder returns", zh ? "分红连续性" : "dividend track record", heroV, heroJ, divHist ? "good" : "");
      if (dseries.length) {
        s.appendChild(fdChartWrap(fdBars(dseries, false, 150, (v) => v.toFixed(2)), dseries.map((d) => d.year), [
          { label: zh ? "每股股利" : "DPS", data: dseries, color: "var(--chart-1)", fmt: (v) => v.toFixed(2) + " " + dcur },
        ]));
      }
      const stats = document.createElement("div"); stats.className = "fd-stats";
      stats.innerHTML = `<span class="fd-stat"><b>${Number.isFinite(dpsLatest) ? dpsLatest.toFixed(2) : "—"} ${dcur}</b>${zh ? "每股股利" : "DPS"}</span>`
        + (Number.isFinite(divYield) ? `<span class="fd-stat"><b>${divYield.toFixed(2)}%</b>${zh ? "股息率" : "Div yield"}</span>` : "")
        + (Number.isFinite(payout) ? `<span class="fd-stat"><b>${payout.toFixed(0)}%</b>${zh ? "分红率" : "Payout"}</span>` : "");
      s.appendChild(stats);
      if (divHist && dseries.length) {
        const co = document.createElement("div"); co.className = "fd-callout";
        const first = dseries[0], last = dseries[dseries.length - 1];
        // 期间存在 >45% 的同比骤降(拆股口径断裂 或 真·大幅减派)→ 平滑年化会误导,不报 CAGR
        const hasBreak = dseries.some((d, i) => i > 0 && dseries[i - 1].value > 0 && d.value / dseries[i - 1].value < 0.55);
        const cagr = (!hasBreak && first.value > 0 && last.value > 0 && last.year > first.year) ? (Math.pow(last.value / first.value, 1 / (last.year - first.year)) - 1) * 100 : NaN;
        co.innerHTML = zh
          ? (Number.isFinite(cagr)
              ? `近 ${dseries.length} 年每股股利 <b>${first.value.toFixed(2)} → ${last.value.toFixed(2)} ${dcur}</b>,年化 ${cagr >= 0 ? "+" : ""}${cagr.toFixed(1)}%。${streak >= 5 ? "连续派息记录稳定。" : ""}`
              : `近 ${dseries.length} 年逐年每股股利如上,最新 <b>${last.value.toFixed(2)} ${dcur}</b>。期间口径有断裂(拆股或大幅减派),不宜直接比较前后绝对额;原始金额未做复权。`)
          : (Number.isFinite(cagr)
              ? `DPS over ${dseries.length}y: <b>${first.value.toFixed(2)} → ${last.value.toFixed(2)} ${dcur}</b>, ${cagr >= 0 ? "+" : ""}${cagr.toFixed(1)}% CAGR.`
              : `Annual DPS above; latest <b>${last.value.toFixed(2)} ${dcur}</b>. A break in the series (split or large cut) makes cross-period comparison unreliable; raw amounts, not split-adjusted.`);
        s.appendChild(co);
      }
    }
  });
}

// 估值研究面板：摘要 + 估值卡片列表 ⇄ 卡片编辑器。idBlock 用于联动刷新顶部判定。
function newValuationId() { return "v" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

function valuationCtx(item) {
  const c = item.cfg, s = item.statics || {};
  const latest = (item._financials && item._financials.annual && item._financials.annual.latest) || {};
  return { price: c.price || 0, epsTtm: parseFloat(s.epsTtm) || NaN, bps: parseFloat(s.bps) || NaN,
    shares: Number(s.totalShares) || 0, dividendYield: parseFloat(s.dividendYield) || NaN, mos: c.mos || 0, ext: c.ext || 0,
    revenue: Number.isFinite(latest.revenue) ? latest.revenue : undefined,
    netIncome: Number.isFinite(latest.netIncome) ? latest.netIncome : undefined,
    deductedNetIncome: Number.isFinite(latest.deductedNetIncome) ? latest.deductedNetIncome : undefined,
    adjustedEps: Number.isFinite(latest.adjustedEps) ? latest.adjustedEps : undefined,
    netDebt: Number.isFinite(latest.netDebt) ? latest.netDebt : undefined,
    fcf: Number.isFinite(latest.fcf) ? latest.fcf : undefined,
    annualYear: Number.isFinite(latest.year) ? latest.year : undefined,
    // 近一年（过去 12 个月除息）每股股息，DDM 优先用它预填
    dpsTtm: (() => { const d = item._financials && item._financials.annual && item._financials.annual.dividends; const t = d && d.ttm; return t && Number.isFinite(t.perShare) && t.perShare > 0 ? t.perShare : undefined; })() };
}

// 把某卡设为合理区间：写 fair 区间 + 选中 id，刷新钟摆/顶部判定/列表行，并保存。
function selectValuation(item, card, idBlock) {
  if (!usableValuationRange(card)) return;
  const c = item.cfg;
  c.fairLow = Math.round(Math.min(card.low, card.high) * 100) / 100;
  c.fairHigh = Math.round(Math.max(card.low, card.high) * 100) / 100;
  c.selectedValuationId = card.id;
  syncFairUI(item, idBlock);
}

// 取消选定（回到未估值占位）：清空区间 + 选中 id。
function clearValuation(item, idBlock) {
  const c = item.cfg;
  c.fairLow = 0; c.fairHigh = 0; c.selectedValuationId = null;
  syncFairUI(item, idBlock);
}

// 区间变更后统一刷新：详情钟摆/占位、顶部判定、列表行、保存。
function syncFairUI(item, idBlock, persist = true) {
  const c = item.cfg;
  mountDetailPendulum(item);
  if (idBlock) { const vv = verdictOf(c, VMSGS); const vEl = idBlock.querySelector(".vd-verdict"); vEl.textContent = vv.text; vEl.className = "vd-verdict " + vv.cls; }
  if (item.gauge) item.gauge.set(c, true);
  renderVerdict(item); renderItemHead(item);
  if (persist) saveItem(item);
}

// 关键假设摘要：先列单值「(高)增长年数」(它框定后面增速的适用区间)，再列 dual 字段（保守–乐观）
function assumeSummary(model, inputs) {
  const fields = modeFields(model, inputs?._mode || model.defaultMode, inputs || {});
  const parts = [];
  // 资源股 NAV/SOTP：先报资产数（资产明细在 inputs.assets，不是 dual 字段）
  if (model.assetModel && Array.isArray(inputs.assets)) {
    const n = inputs.assets.filter((a) => a && Number.isFinite(Number(a.cf)) && Number(a.L) > 0).length;
    if (n) parts.push(LANG === "zh" ? `${n} 项资产` : `${n} assets`);
  }
  const nf = fields.find((f) => f.k === "n"), nv = nf && inputs.n;
  if (nf && nv != null && nv !== "") {
    const lab = (nf.label && nf.label[LANG]) || "n";
    parts.push(LANG === "zh" ? `${lab} ${nv} 年` : `${lab} ${nv}`);
  }
  fields.filter((f) => f.col === "dual").forEach((f) => {
    const v = inputs[f.k]; if (!v || typeof v !== "object") return;
    const lab = (f.label && f.label[LANG]) || f.k;
    const unit = f.unit === "%" ? "%" : "";
    parts.push(`${lab} ${v.c === v.o ? v.c : `${v.c}–${v.o}`}${unit}`);
  });
  return parts.join(" · ");
}

// 按需取财报（按 period 在 item 上内存缓存本会话）。返回 { financials, latest }。
function loadFinancials(item, period) {
  item._financials = item._financials || {};
  if (item._financials[period]) return Promise.resolve(item._financials[period]);
  const url = `/api/financials?symbol=${encodeURIComponent(item.cfg.symbol)}&period=${period}&v=5`;
  return fetch(url).then((r) => r.json()).then((j) => (item._financials[period] = j))
    .catch(() => (item._financials[period] = { financials: null, latest: null }));
}

// 财报 tab：报表(利润表/资产负债表/现金流) × 周期(年报/季报) 切换 + 表格
function renderFinancialsPanel(item, panel) {
  panel.innerHTML = "";
  let stmt = "IS", period = "annual";
  const controls = document.createElement("div"); controls.className = "fin-controls";
  const stmtSeg = document.createElement("div"); stmtSeg.className = "fin-seg";
  const perSeg = document.createElement("div"); perSeg.className = "fin-seg";
  const body = document.createElement("div"); body.className = "fin-body";
  panel.append(controls, body); controls.append(stmtSeg, perSeg);

  const stmtBtns = [["IS", "d_stmt_is"], ["BS", "d_stmt_bs"], ["CF", "d_stmt_cf"]].map(([k, key]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "fin-segbtn"; b.textContent = t(key);
    b.addEventListener("click", () => { stmt = k; sync(); draw(); }); stmtSeg.appendChild(b); return [k, b];
  });
  const perBtns = [["annual", "d_period_annual"], ["quarter", "d_period_quarter"]].map(([k, key]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "fin-segbtn"; b.textContent = t(key);
    b.addEventListener("click", () => { period = k; sync(); draw(); }); perSeg.appendChild(b); return [k, b];
  });
  function sync() {
    stmtBtns.forEach(([k, b]) => b.classList.toggle("on", k === stmt));
    perBtns.forEach(([k, b]) => b.classList.toggle("on", k === period));
  }
  function draw() {
    // 财报表格骨架：表头一行 + 若干行
    body.innerHTML = `<div aria-hidden="true" style="display:flex;flex-direction:column;gap:14px;padding:6px 0">${Array.from({ length: 8 }, (_, i) => `<div class="sk-row"><span class="sk sk-line" style="width:${i ? 22 : 14}%"></span><span class="sk-grow"></span>${'<span class="sk sk-line" style="width:9%"></span>'.repeat(5)}</div>`).join("")}</div>`;
    const reqStmt = stmt, reqPeriod = period;
    loadFinancials(item, period).then(({ financials }) => {
      if (reqStmt !== stmt || reqPeriod !== period) return; // 期间用户又切了，忽略旧结果
      body.innerHTML = "";
      const accts = financials && financials[stmt];
      if (!accts || !accts.length) { const e = document.createElement("div"); e.className = "vd-empty"; e.textContent = t("d_no_financials"); body.appendChild(e); return; }
      body.appendChild(financialsTable(accts));
    });
  }
  sync(); draw();
}

// 参考溯源 URL：财报→优先官方监管(美股 EDGAR)否则长桥财报页；倍数→长桥估值页
function valuationSources(item, lang) {
  const m = /^(us|hk|sh|sz|bj)(.+)$/i.exec(item.cfg.symbol || "");
  if (!m) return null;
  const mkt = m[1].toUpperCase();
  const code = mkt === "HK" ? String(parseInt(m[2], 10)) : (mkt === "US" ? m[2].toUpperCase() : m[2]);
  const counterId = encodeURIComponent(`ST/${mkt}/${code}`);
  const lblang = lang === "zh" ? "zh-CN" : "en-US";
  // 长桥公司财报页（含营收/净利/利润率/ROE 等基本面与估值指标，全市场可渲染）
  const lbFin = `https://app.lbkrs.com/ig/financial-report?counterId=${counterId}&need_login=0&lblang=${lblang}&lbtheme=light&lbapp=0`;
  const financial = mkt === "US"
    ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=${encodeURIComponent(code)}&type=10-K&dateb=&owner=include&count=40`
    : lbFin;
  return { financial, valuation: lbFin };
}

function renderValuationPanel(item, panel, idBlock) {
  // 注意：不要捕获 item.cfg —— 行情刷新会重建该对象，捕获会读到旧引用（选中态丢失）。
  panel.innerHTML = "";
  detailValRefresh = () => showList(); // 供外部（标的编辑保存后）刷新摘要
  detailAddValuation = () => showEditor(null); // 供占位卡「添加估值」按钮直接打开编辑器

  function showList() {
    panel.innerHTML = "";
    const cards = item.cfg.valuations || [];
    // 真正空态（无卡片且未直接设定区间）：用图标 + 标题 + 说明 + 主行动,而不是一排"—"摘要
    if (!cards.length && !hasFairRange(item.cfg)) { panel.appendChild(emptyValuations()); return; }
    // 估值区间对照图 + 估值卡片
    if (cards.length) panel.appendChild(valuationMap(cards)); // 只有手动区间、没有估值卡时，对照图没有可比的内容

    const head = document.createElement("div"); head.className = "vsec-head";
    head.innerHTML = `<span class="vsec-title">${LANG === "zh" ? "估值卡片" : "Valuation cards"}</span><span class="vsec-sub"></span>`;
    head.querySelector(".vsec-sub").textContent = cards.length ? (LANG === "zh" ? `${cards.length} 张 · 选中的一张决定钟摆区间` : `${cards.length} · the selected card sets the pendulum range`) : (LANG === "zh" ? "当前区间为手动设定" : "Range was set manually");
    panel.appendChild(head);
    const list = document.createElement("div"); list.className = "vcards";
    cards.forEach((card) => list.appendChild(cardEl(card)));
    const add = document.createElement("button"); add.className = "vcard-add"; add.type = "button";
    add.innerHTML = `<span class="vcard-add-plus" aria-hidden="true"><i class="ri-add-line"></i></span><span></span>`;
    add.lastChild.textContent = LANG === "zh" ? "添加估值" : "Add valuation";
    add.addEventListener("click", () => showEditor(null));
    list.appendChild(add);
    panel.appendChild(list);
  }

  // 估值区间对照图：线性价格轴，每张估值卡一行，竖线标现价，两端渐变表示击球区/泡沫区。
  function valuationMap(cards) {
    const c = item.cfg, zh = LANG === "zh", p = c.price;
    const valued = structValid(c);
    const a = valued ? computeAnchors(c) : null;
    const pts = [p > 0 ? p : NaN, ...(valued ? [a[1], a[4]] : []), ...cards.flatMap((k) => [k.low, k.high])].filter((v) => Number.isFinite(v) && v > 0);
    const wrap = document.createElement("div"); wrap.className = "vmap";
    const title = document.createElement("div"); title.className = "vsec-head";
    title.innerHTML = `<span class="vsec-title">${zh ? "估值对照" : "Valuation map"}</span>`;
    wrap.appendChild(title);
    if (!pts.length) return wrap;
    let lo = Math.min(...pts), hi = Math.max(...pts);
    const pad = (hi - lo) * 0.12 || hi * 0.2;
    lo = Math.max(0, lo - pad); hi = hi + pad;
    const X = (v) => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
    const grid = document.createElement("div"); grid.className = "vmap-grid";
    const row = (label, cls) => {
      const l = document.createElement("div"); l.className = "vmap-lab " + (cls || ""); l.textContent = label;
      const tr = document.createElement("div"); tr.className = "vmap-track " + (cls || "");
      grid.append(l, tr); return { l, tr };
    };
    // 每张估值卡一行
    cards.forEach((k) => {
      const model = MODELS.find((m) => m.key === k.method);
      const picked = c.selectedValuationId === k.id;
      const { l, tr } = row(model ? (model.label[LANG] || model.key) : k.method, picked ? "picked" : "");
      const single = k.scenarioMode === "single" && k.low === k.high;
      if (picked) { const s = document.createElement("span"); s.className = "vmap-pick"; s.textContent = zh ? "钟摆采用" : "In use"; s.title = zh ? "钟摆按这张卡的区间划分" : "The pendulum uses this card's range"; l.appendChild(s); }
      const x0 = X(Math.min(k.low, k.high)), x1 = X(Math.max(k.low, k.high));
      if (single) {
        const point = document.createElement("div"); point.className = "vmap-point" + (x0 < 20 ? " edge-start" : x0 > 80 ? " edge-end" : ""); point.style.left = x0 + "%";
        const value = document.createElement("span"); value.className = "vmap-value"; value.textContent = (zh ? "合理价值 " : "Fair value ") + fmtPx(k.low);
        point.appendChild(value); tr.appendChild(point); return;
      }
      const bar = document.createElement("div"); bar.className = "vmap-bar"; bar.style.left = x0 + "%"; bar.style.width = Math.max(0.8, x1 - x0) + "%";
      const caption = document.createElement("div"); caption.className = "vmap-range-caption";
      caption.style.setProperty("--range-center", ((x0 + x1) / 2) + "%");
      const text = document.createElement("span"); text.textContent = (zh ? "合理区间 " : "Fair range ") + fmtPx(Math.min(k.low, k.high)) + "–" + fmtPx(Math.max(k.low, k.high));
      caption.appendChild(text); tr.append(bar, caption);
    });
    // 现价竖线：每条轨道各画一段，上下伸进行间距里首尾相接；第一段顶上挂现价标签
    if (p > 0) {
      grid.querySelectorAll(".vmap-track").forEach((tr, i) => {
        const seg = document.createElement("div"); seg.className = "vmap-now" + (i === 0 ? " first" : ""); seg.style.left = X(p) + "%";
        if (i === 0) { const tag = document.createElement("span"); tag.className = "vmap-now-tag"; tag.textContent = (zh ? "现价 " : "Price ") + fmtPx(p); seg.appendChild(tag); }
        tr.appendChild(seg);
      });
    }
    // 两端区域向图外延伸；渐变由阈值向外缘淡回底色，虚线精确标出阈值。各行首尾相接。
    if (valued) {
      const tracks = [...grid.querySelectorAll(".vmap-track")];
      const labels = document.createElement("div"); labels.className = "vmap-zone-labels" + (X(a[4]) - X(a[1]) < 15 ? " tight" : "");
      [[a[1], ZONES[0].hex, "strike", zh ? "← 击球区" : "← Strike zone"], [a[4], ZONES[ZONES.length - 1].hex, "bubble", zh ? "泡沫区 →" : "Bubble zone →"]].forEach(([v, col, side, lab]) => {
        tracks.forEach((tr) => {
          const zone = document.createElement("div"); zone.className = "vmap-zone " + side;
          zone.style.setProperty("--zone-color", col); zone.style.width = (side === "strike" ? X(v) : 100 - X(v)) + "%";
          zone.setAttribute("aria-hidden", "true"); tr.prepend(zone);
        });
        const label = document.createElement("div"); label.className = "vmap-zone-label " + side; label.style.color = col; label.style.setProperty("--threshold", X(v) + "%");
        const name = document.createElement("strong"); name.textContent = lab;
        const rule = document.createElement("span"); rule.textContent = (zh ? "价格 " : "Price ") + (side === "strike" ? "≤ " : "> ") + fmtPx(v);
        label.append(name, rule); labels.appendChild(label);
      });
      grid.appendChild(labels);
    }
    // 价格轴刻度
    const axL = document.createElement("div"); axL.className = "vmap-lab axis";
    const ax = document.createElement("div"); ax.className = "vmap-axis";
    const step = niceStep((hi - lo) / 5), digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
    for (let i = Math.ceil(lo / step); i * step <= hi + 1e-9; i++) {
      const v = i * step, s = document.createElement("span"); s.style.left = X(v) + "%"; s.textContent = v.toFixed(digits); ax.appendChild(s);
    }
    grid.append(axL, ax);
    wrap.appendChild(grid);
    return wrap;
  }

  function emptyValuations() {
    const zh = LANG === "zh";
    const box = document.createElement("div"); box.className = "vempty";
    box.innerHTML = `<div class="vempty-icon" aria-hidden="true"><i class="ri-bar-chart-2-line" aria-hidden="true"></i></div>`
      + `<div class="vempty-title">${zh ? "还没有估值" : "No valuations yet"}</div>`
      + `<div class="vempty-sub">${zh ? "用 PE、DCF、股息等方法添加一张估值卡片，推导内在价值。设为合理区间后，估值钟摆会据此判定贵贱。" : "Add a valuation (PE, DCF, dividend…) to derive intrinsic value. Mark one as the fair range and the pendulum reflects it."}</div>`;
    const cta = document.createElement("button"); cta.type = "button"; cta.className = "vempty-cta";
    cta.textContent = zh ? "添加估值" : "Add valuation";
    cta.addEventListener("click", () => showEditor(null));
    const link = document.createElement("a"); link.className = "vempty-link"; link.href = "/valuation";
    link.replaceChildren(document.createTextNode(zh ? "常见估值方法" : "Valuation methods"), ri("arrow-right-line"));
    box.append(cta, link);
    return box;
  }

  function cardEl(card) {
    const c = item.cfg; // 实时读取，避免行情刷新后引用失效
    const model = MODELS.find((m) => m.key === card.method);
    const wrap = document.createElement("div");
    wrap.className = "vcard" + (c.selectedValuationId === card.id ? " on" : "");
    const head = document.createElement("div"); head.className = "vcard-head";
    const name = document.createElement("span"); name.className = "vcard-method"; name.textContent = model ? (model.label[LANG] || model.key) : card.method;
    head.appendChild(name);
    if (c.selectedValuationId === card.id) { const b = document.createElement("span"); b.className = "vcard-badge"; b.textContent = card.scenarioMode === "single" ? (LANG === "zh" ? "合理价值" : "Fair value") : LANG === "zh" ? "合理区间" : "Fair range"; head.appendChild(b); }
    const range = document.createElement("div"); range.className = "vcard-range";
    // 低、高两个数各自缩小小数部分，中间破折号保持原样
    const rLo = document.createElement("span"), rHi = document.createElement("span");
    setNum(rLo, fmtPx(Math.min(card.low, card.high))); setNum(rHi, fmtPx(Math.max(card.low, card.high)));
    if (card.scenarioMode === "single") range.append(rLo); else range.append(rLo, " – ", rHi);
    const sum = document.createElement("div"); sum.className = "vcard-assume"; sum.textContent = (card.scenarioMode === "single" ? (LANG === "zh" ? "单场景 · " : "Single case · ") : "") + (model ? assumeSummary(model, card.inputs) : "");
    const vinfo = verdictOf({ ...c, fairLow: card.low, fairHigh: card.high, scenarioMode: card.scenarioMode }, VMSGS);
    const verd = document.createElement("div"); verd.className = "vcard-verdict " + vinfo.cls; verd.textContent = c.price > 0 ? vinfo.text : ""; if (!(c.price > 0)) verd.style.display = "none";
    const note = document.createElement("div"); note.className = "vcard-note"; note.textContent = card.note || ""; if (!card.note) note.style.display = "none";
    const thesis = cleanThesis(card.thesis);
    const story = document.createElement("div"); story.className = "vcard-thesis";
    for (const scenario of [...THESIS_SCENARIOS, { key: "legacy", zh: "未分场景的旧记录", en: "Previous shared notes" }]) {
      const fields = thesis[scenario.key]; if (!fields) continue;
      const section = document.createElement("section"); section.className = "vcard-thesis-case";
      const title = document.createElement("h4"); title.textContent = card.scenarioMode === "single" && scenario.key === "c" ? (LANG === "zh" ? "主情景" : "Main case") : LANG === "zh" ? scenario.zh : scenario.en; section.append(title);
      for (const field of thesisEntries(fields, LANG)) {
        const row = document.createElement("div");
        const label = document.createElement("strong"); label.textContent = field.label;
        const text = document.createElement("p"); text.textContent = field.text;
        row.append(label, text); section.append(row);
      }
      story.append(section);
    }
    const actions = document.createElement("div"); actions.className = "vcard-actions";
    const picked = c.selectedValuationId === card.id;
    const sel = document.createElement("button"); sel.type = "button"; sel.className = "vcard-sel" + (picked ? " on" : "");
    sel.textContent = picked ? (LANG === "zh" ? "取消选定" : "Unset") : card.scenarioMode === "single" ? (LANG === "zh" ? "设为合理价值" : "Set as fair value") : (LANG === "zh" ? "设为合理区间" : "Set as fair range");
    sel.disabled = !usableValuationRange(card);
    if (sel.disabled) sel.textContent = LANG === "zh" ? "保留研究结果（不设钟摆）" : "Research result only";
    sel.title = picked ? (LANG === "zh" ? "点击取消选定" : "Click to unset") : "";
    sel.addEventListener("click", () => { (picked ? clearValuation : (i, b) => selectValuation(i, card, b))(item, idBlock); showList(); });
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "vcard-edit"; edit.textContent = LANG === "zh" ? "编辑" : "Edit";
    edit.addEventListener("click", () => showEditor(card));
    const del = document.createElement("button"); del.type = "button"; del.className = "vcard-del"; del.textContent = LANG === "zh" ? "删除" : "Delete";
    del.addEventListener("click", () => {
      const wasPicked = c.selectedValuationId === card.id;
      c.valuations = (c.valuations || []).filter((x) => x.id !== card.id);
      if (wasPicked) clearValuation(item, idBlock); else saveItem(item);
      showList();
    });
    // AI 复核：用最新财报检查这张卡当初的假设还成不成立，结果存在卡上（card.review）
    const rev = document.createElement("button"); rev.type = "button"; rev.className = "vcard-ai";
    rev.replaceChildren(ri("sparkling-2-fill"), document.createTextNode(card.review ? (LANG === "zh" ? "重新复核" : "Re-review") : (LANG === "zh" ? "AI 复核" : "AI review")));
    rev.title = LANG === "zh" ? "用最新财报检查当初的估值假设还成不成立" : "Check the assumptions against the latest reports";
    const revErr = document.createElement("div"); revErr.className = "vrev-err"; revErr.hidden = true;
    rev.addEventListener("click", () => runReview(card, rev, revErr));
    actions.append(sel, rev, edit, del);
    // 复核状态：上次什么时候、怎么看过；选中的卡到了该复核的时候，多一个「标记已复核」（看过、假设仍成立，不用改卡）
    const zh = LANG === "zh", lc = lastChecked(card), due = picked ? reviewReasonsFor(card, c.symbol) : null;
    const chk = document.createElement("div"); chk.className = "vcard-checked" + (due ? " due" : "");
    if (lc) {
      const days = Math.floor((Date.now() - Date.parse(lc.at)) / 86400000);
      const when = days < 1 ? (zh ? "今天" : "today") : zh ? `${days} 天前` : `${days} day${days > 1 ? "s" : ""} ago`;
      const how = { edit: zh ? "编辑" : "edited", ai: zh ? "AI 复核" : "AI review", mark: zh ? "手动标记" : "marked" }[lc.how];
      chk.append(ri(due ? "error-warning-line" : "checkbox-circle-line"), document.createTextNode((zh ? `上次复核 ${when} · ${how}` : `Last reviewed ${when} · ${how}`) + (due ? (zh ? " · " : " · ") + due.join(zh ? "，" : ", ") : "")));
    }
    if (due && !reviewNeedsUpdate(card)) {
      const mark = document.createElement("button"); mark.type = "button"; mark.className = "vcard-mark";
      mark.textContent = zh ? "标记已复核" : "Mark reviewed";
      mark.title = zh ? "看过了，假设仍成立，不需要改这张卡" : "Checked — the assumptions still hold, no edit needed";
      mark.addEventListener("click", () => { card.reviewedAt = new Date().toISOString(); saveItem(item); renderOverview(); showList(); });
      chk.appendChild(mark);
    }
    const details = document.createElement("details"); details.className = "vcard-details";
    const detailLabel = document.createElement("summary");
    detailLabel.textContent = zh ? (story.childElementCount ? "叙事与参数" : "参数与备注") : (story.childElementCount ? "Narrative & assumptions" : "Assumptions & notes");
    details.append(detailLabel, sum, story, note);
    wrap.append(head, range, verd);
    if (sum.textContent || story.childElementCount || card.note) wrap.appendChild(details);
    if (lc) wrap.appendChild(chk);
    if (card.review) wrap.appendChild(reviewEl(card, model));
    wrap.append(revErr, actions);
    return wrap;
  }

  // ---- AI 复核 ----
  const REV_MONEY = new Set(["revenue", "netIncome", "netDebt", "ebitda", "fcf"]);
  const revFields = (model, inputs) => modeFields(model, inputs && inputs._mode, inputs || {}).map((f) => {
    const v = inputs ? inputs[f.k] : undefined, n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    return { k: f.k, label: (f.label && f.label[LANG]) || f.k, col: f.col, unit: f.unit || "", meta: f.meta || "", money: !!f.money || REV_MONEY.has(f.meta),
      value: f.col === "dual" ? { c: n(v && v.c), o: n(v && v.o) } : n(v) };
  });
  async function runReview(card, btn, errEl) {
    const model = MODELS.find((m) => m.key === card.method); if (!model) return;
    btn.disabled = true; btn.classList.add("busy");
    btn.replaceChildren(ri("loader-4-line"), document.createTextNode(LANG === "zh" ? "复核中…" : "Reviewing…"));
    errEl.hidden = true;
    try {
      const [annual, quarter, research] = await Promise.all([loadFinancials(item, "annual"), loadFinancials(item, "quarter"),
        fetch("/api/research?symbol=" + encodeURIComponent(item.cfg.symbol || "")).then((r) => r.json()).then((j) => j.research).catch(() => null)]);
      const c = item.cfg, st = item.statics || {};
      const scenarioMode = reviewMode(card);
      const fields = scopeReviewFields(revFields(model, card.inputs), scenarioMode);
      const evidence = buildReviewEvidence({ fields, scenarioMode, financials: annual?.financials, valuationRefs: annual?.valuationRefs, dividends: annual?.dividends, financialsSource: annual?.financialsSource, lang: LANG });
      const body = {
        lang: LANG, scenarioMode, evidence,
        stock: { name: displayName(item), code: (c.ticker || "").toUpperCase(), currency: st.currency || "", price: c.price > 0 ? c.price : null },
        method: { key: model.key, label: model.label[LANG] || model.key },
        valuedAt: card.updatedAt || "",
        thesis: scenarioMode === "single" ? cleanThesis({ c: card.thesis?.c, legacy: card.thesis?.legacy }) : cleanThesis(card.thesis),
        fields,
        result: { low: Math.min(card.low, card.high), high: Math.max(card.low, card.high), price: c.price || null },
        verified: verifiedFacts({ financials: annual && annual.financials, dividends: annual && annual.dividends, dps: parseFloat(st.dividendYield), financial: isFinancialCompany(research), lang: LANG }),
        metrics: latestMetrics({ financials: annual && annual.financials, financialsQ: quarter && quarter.financials, valuationRefs: annual && annual.valuationRefs, valuedAt: card.updatedAt, lang: LANG }),
        market: marketViews({ research, financials: annual && annual.financials, price: item.cfg.price, market: (item.cfg.symbol || "").slice(0, 2), lang: LANG }),
        lenses: masterLenses({ financials: annual && annual.financials, research, price: item.cfg.price, eps: parseFloat(st.epsTtm), bps: parseFloat(st.bps), lang: LANG }),
        business: businessFacts({ research, lang: LANG }),
        // Comparable values, periods and source names are captured with the review.
      };
      const r = await fetch("/api/my/ai/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.review) throw new Error(aiErrorText(r.status, j, LANG));
      card.review = j.review;
      saveItem(item);
      renderOverview(); // AI 复核也算复核过：刷新顶部提示
      showList();
    } catch (e) {
      errEl.textContent = (LANG === "zh" ? "复核失败：" : "Review failed: ") + (e && e.message || e);
      errEl.hidden = false;
      btn.disabled = false; btn.classList.remove("busy");
      btn.replaceChildren(ri("sparkling-2-fill"), document.createTextNode(LANG === "zh" ? "重试复核" : "Retry"));
    }
  }
  // 复核结果：总体结论徽章 + 一句总结 + 逐项假设（状态点 · 名称 · 当初的值 · 依据），可去调整假设
  function reviewEl(card, model) {
    return reviewElement(card, { fields: model ? revFields(model, card.inputs) : [], lang: LANG,
      onEdit: () => showEditor(card), onFinancials: () => detailGoFinancials?.(),
      loadTrend: async (metric) => {
        const a = await loadFinancials(item, "annual"), series = metricSeries(metric, a?.financials, a?.dividends);
        const element = aiSparkEl(metric, a?.financials, a?.dividends, item.statics?.currency || "");
        const m = METRICS[metric];
        return { element, label: `${m ? (LANG === "zh" ? m.zh : m.en) : metric} · FY${series[0]?.year || "—"}–FY${series.at(-1)?.year || "—"} · ${LANG === "zh" ? "年度趋势" : "Annual trend"}` };
      },
    });
  }

  // 打开全屏双栏编辑器视图（添加/编辑卡片）
  function showEditor(card) {
    valEditReturn = item;
    history.pushState({ valedit: 1 }, "", location.href); // 压一条 → 后退=取消
    viewValEdit.innerHTML = "";
    const head = document.createElement("div"); head.className = "ve-head";
    const back = document.createElement("a"); back.className = "ve-back"; back.href = "#"; back.replaceChildren(ri("arrow-left-line"), document.createTextNode(t("d_back")));
    back.addEventListener("click", (e) => { e.preventDefault(); leaveValEdit(); });
    // 标题行：返回独占一行；下一行「标题 | 名称 · 代码」基线对齐、竖线分隔
    const titleRow = document.createElement("div"); titleRow.className = "ve-titlerow";
    const title = document.createElement("span"); title.className = "ve-title";
    title.textContent = card ? (LANG === "zh" ? "编辑估值" : "Edit valuation") : (LANG === "zh" ? "添加估值" : "Add valuation");
    titleRow.append(title); // 标的信息在工作台右栏的资料卡里
    head.append(back, titleRow);
    const headRight = document.createElement("div"); headRight.className = "ve-head-right";
    mountLangMenu(headRight);
    head.appendChild(headRight);
    const mountEl = document.createElement("div");
    viewValEdit.append(head, mountEl);
    if (valEditApi && valEditApi.destroy) valEditApi.destroy();
    valEditApi = mountValuationCalc(mountEl, valuationCtx(item), {
      lang: LANG,
      initialMethod: card ? card.method : undefined,
      initialInputs: card ? card.inputs : undefined,
      initialDerivations: card ? card.derivations : undefined,
      initialSegments: card ? card.segments : undefined,
      initialNote: card ? card.note : undefined,
      initialThesis: card ? card.thesis : undefined,
      initialScenarioMode: card?.scenarioMode,
      initialManagementResearch: card?.managementResearch,
      draftKey: `${greetName}:${boardSlug}:${item.cfg.symbol}:${card?.id || "new"}`,
      initialUpdatedAt: card?.updatedAt || "",
      loadGuideData: async () => { const annual = await loadFinancials(item, "annual"); return { financials: annual?.financials || null, dividends: annual?.dividends || null }; },
      refData: {
        financials: (item._financials && item._financials.annual && item._financials.annual.financials) || null,
        financialsQ: (item._financials && item._financials.quarter && item._financials.quarter.financials) || null,
        valuationRefs: (item._financials && item._financials.annual && item._financials.annual.valuationRefs) || null,
        dividends: (item._financials && item._financials.annual && item._financials.annual.dividends) || null,
        sources: valuationSources(item, LANG),
      },
      verdict: (low, high) => { const vv = verdictOf({ ...item.cfg, fairLow: low, fairHigh: high, ...(low === high ? { scenarioMode: "single" } : {}) }, VMSGS); return { text: vv.text, cls: vv.cls }; },
      stock: editorStock(item),
      onCancel: () => finishValEdit(),
      onDone: async (value) => {
        const result = await persistValuation(item, card?.id, value);
        Object.assign(item.cfg, result.change); item.id = result.id;
        syncFairUI(item, idBlock, false); finishValEdit();
        return true;
      },
    });
    showView("valedit");
    window.scrollTo(0, 0);
  }

  showList();
}

// 估值工作台右栏的标的资料：名称 / 代码 / logo + 估值模型会用到的数据（市值、股本、EPS、每股净资产、净负债）
function editorStock(item) {
  const c = item.cfg, s = item.statics || {}, cur = s.currency || "";
  const latest = (item._financials && item._financials.annual && item._financials.annual.latest) || {};
  const shares = Number(s.totalShares) || 0, eps = parseFloat(s.epsTtm), bps = parseFloat(s.bps);
  const zh = LANG === "zh";
  const money = (n) => Number.isFinite(n) ? (n < 0 ? "−" : "") + fmtBig(Math.abs(n), cur) + (cur ? " " + cur : "") : "—";
  return {
    name: displayName(item), code: (c.ticker || "").toUpperCase(), currency: cur, symbol: c.symbol || "",
    mountLogo: (el) => mountLogo(el, item),
    rows: [
      [t("d_market_cap"), c.price > 0 && shares ? money(c.price * shares) : "—"],
      [t("d_shares"), shares ? fmtBig(shares, cur) + (zh ? " 股" : " shares") : (zh ? "暂无数据" : "Unavailable")],
      [t("d_eps_ttm"), Number.isFinite(eps) ? eps.toFixed(2) + (cur ? " " + cur : "") + (zh ? "/股" : "/share") : (zh ? "暂无数据" : "Unavailable")],
      [zh ? "每股净资产" : "Book value / share", Number.isFinite(bps) ? bps.toFixed(2) + (cur ? " " + cur : "") + (zh ? "/股" : "/share") : (zh ? "暂无数据" : "Unavailable")],
      [zh ? "净负债" : "Net debt", Number.isFinite(latest.netDebt) ? money(latest.netDebt) + (Number.isFinite(latest.year) ? ` (${latest.year})` : (zh ? "（报告期待补）" : " (period unavailable)")) : (zh ? "暂无数据" : "Unavailable")],
    ],
  };
}

// 退出编辑器：弹掉压入的历史条 → popstate 回到详情
function finishValEdit() { if (!valEditReturn) return; valEditLeaving = true; history.back(); }
// 用户要离开（返回 / Esc / 浏览器后退）：有未保存改动就先问
function leaveValEdit() {
  if (valEditApi?.isSaving()) return;
  if (valEditApi && valEditApi.isDirty()) askSaveValEdit(); else finishValEdit();
}
function askSaveValEdit() {
  if (document.getElementById("veConfirm")) return;
  const zh = LANG === "zh", canSave = valEditApi && valEditApi.canSave(), canDraft = valEditApi?.hasLocalDraft();
  const ov = document.createElement("div"); ov.className = "overlay"; ov.id = "veConfirm";
  const box = document.createElement("div"); box.className = "modal ve-confirm"; box.setAttribute("role", "alertdialog"); box.setAttribute("aria-modal", "true");
  const title = document.createElement("div"); title.className = "modal-title"; title.textContent = zh ? "保存这次修改吗？" : "Save your changes?";
  const msg = document.createElement("p"); msg.className = "ve-confirm-msg";
  msg.textContent = canSave ? (zh ? "可以保存为正式估值，也可以只保留此浏览器中的研究草稿，下次继续。" : "Save the valuation, or keep a research draft in this browser to continue later.")
    : (zh ? "研究还没完成，可以先保留在此浏览器，下次回来继续；草稿不会参与估值钟摆。" : "Keep the unfinished research in this browser and resume later. Drafts do not affect the valuation gauge.");
  const acts = document.createElement("div"); acts.className = "ve-confirm-acts";
  const mk = (cls, text) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn " + cls; b.textContent = text; return b; };
  const keep = mk("ghost", zh ? "继续编辑" : "Keep editing");
  const discard = mk("", zh ? "不保存" : "Don't save");
  const draft = mk(canSave ? "" : "primary", zh ? "保留草稿并离开" : "Keep draft and leave"); draft.disabled = !canDraft;
  const save = mk("primary", zh ? "保存估值并离开" : "Save valuation and leave"); save.hidden = !canSave; save.disabled = !canSave;
  acts.append(keep, discard, draft); if (canSave) acts.append(save);
  box.append(title, msg, acts); ov.appendChild(box); document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey, true);
  keep.addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  discard.addEventListener("click", () => { valEditApi?.discardDraft(); close(); finishValEdit(); });
  draft.addEventListener("click", () => {
    if (valEditApi.keepDraft()) { close(); finishValEdit(); }
    else msg.textContent = zh ? "此浏览器未能保留草稿，请继续编辑或复制研究内容。" : "The draft could not be stored. Keep editing or copy your research.";
  });
  save.addEventListener("click", () => { if (canSave) { close(); valEditApi.save(); } });
  (canSave ? save : keep).focus();
}
// 关标签页 / 刷新：浏览器自带的离开提醒
window.addEventListener("beforeunload", (e) => {
  if (valEditReturn && !valEditLeaving && valEditApi && valEditApi.isDirty()) { e.preventDefault(); e.returnValue = ""; }
});

function currentDetailCode() {
  const m = location.pathname.match(/^\/b\/[^/]+\/([^/]+)/);
  return m ? decodeURIComponent(m[1]).toUpperCase() : null;
}
function route() {
  const code = currentDetailCode();
  const item = code ? items.find((i) => (i.cfg.ticker || "").toUpperCase() === code) : null;
  if (item && owner) showDetail(item); else showList();
}
window.addEventListener("popstate", () => {
  if (valEditReturn) {
    if (!valEditLeaving && valEditApi?.isSaving()) { history.pushState({ valedit: 1 }, "", location.href); return; }
    // 浏览器后退但有未保存改动：把历史条压回去，先问
    if (!valEditLeaving && valEditApi && valEditApi.isDirty()) { history.pushState({ valedit: 1 }, "", location.href); askSaveValEdit(); return; }
    const it = valEditReturn; valEditReturn = null; valEditLeaving = false;
    if (valEditApi && valEditApi.destroy) valEditApi.destroy(); valEditApi = null;
    showDetail(it, "val"); return; // 退出编辑器→回详情（停在估值研究 tab）
  }
  route();
});

document.querySelectorAll('.nav-tab[data-view="board"]').forEach((tab) => // Portfolio 是普通链接，不拦截
  tab.addEventListener("click", () => { history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug)); showList(); }));
btnSettings.addEventListener("click", showSettings);
// 产品名 = 回到 Watchlist
document.getElementById("brand").addEventListener("click", (e) => {
  e.preventDefault();
  if (owner) { location.href = "/portfolio"; return; } // 资产（Portfolio）是主人的首页；访客留在看板
  history.pushState({}, "", "/b/" + encodeURIComponent(boardSlug)); showList();
});


document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.getElementById("veConfirm")) return; // 确认框自己处理 Esc
    if (valEditReturn) { leaveValEdit(); }
    else if (!modalOverlay.classList.contains("hidden")) closeItemModal();
    return;
  }
  // Enter = 提交编辑弹窗（但代码联想下拉打开时让其自行处理，textarea 内不拦截）
  if (e.key === "Enter" && !modalOverlay.classList.contains("hidden")) {
    if (document.querySelector("#modalOverlay .combo-list")) return;
    if ((e.target.tagName || "").toLowerCase() === "textarea") return;
    e.preventDefault();
    trySubmitModal();
  }
});

/* ---------- 估值默认值（新标的预填的安全边际 / 泡沫阈值，自动保存） ---------- */
let itemDefaults = { mos: 50, ext: 40 };
function applyItemDefaults(settings) {
  const m = Number(settings && settings.default_mos), e = Number(settings && settings.default_ext);
  itemDefaults = { mos: m > 0 ? m : 50, ext: e > 0 ? e : 40 };
}
const defMos = document.getElementById("defMos"), defExt = document.getElementById("defExt"), defSave = document.getElementById("defSave");
let defTimer = null;
async function saveDefaults() {
  defSave.className = "save-state"; defSave.textContent = t("st_saving");
  try {
    const res = await fetch("/api/my/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ default_mos: defMos.value, default_ext: defExt.value }) });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { applyItemDefaults(j.settings || {}); defSave.className = "save-state ok"; defSave.textContent = t("st_saved"); }
    else { defSave.className = "save-state err"; defSave.textContent = j.error || t("st_failed"); }
  } catch { defSave.className = "save-state err"; defSave.textContent = t("st_failed"); }
}
[defMos, defExt].forEach((el) => el.addEventListener("input", () => { clearTimeout(defTimer); defTimer = setTimeout(saveDefaults, 600); }));

/* ---------- 数据导出：自选与全部估值卡（JSON） ---------- */
document.getElementById("btnExport").addEventListener("click", async () => {
  const note = document.getElementById("exportNote");
  try {
    const j = await fetch("/api/my/items").then((r) => r.json());
    const out = { app: "ValuePort", exportedAt: new Date().toISOString(), board: boardSlug, items: j.items || [] };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    a.download = `valueport-${boardSlug}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    note.className = "ai-result ok"; note.textContent = LANG === "zh" ? `已导出 ${out.items.length} 只标的` : `Exported ${out.items.length} item(s)`;
  } catch { note.className = "ai-result bad"; note.textContent = t("st_failed"); }
});

/* ---------- 看板设置 ---------- */
const boardNameEl = document.getElementById("boardName");
const boardSlugEl = document.getElementById("boardSlug");
const boardSaveEl = document.getElementById("boardSave");
const boardLinkEl = document.getElementById("boardLink");
let boardTimer = null;
function updateBoardLink(slug) {
  if (slug && SLUG_RE.test(slug)) {
    const url = location.origin + "/b/" + slug;
    boardLinkEl.href = url;
    boardLinkEl.textContent = url;
  } else {
    boardLinkEl.href = "#";
    boardLinkEl.textContent = t("s_slug_invalid");
  }
}
document.getElementById("btnCopyUrl").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!boardLinkEl.href || boardLinkEl.href.endsWith("#")) return;
  try {
    await navigator.clipboard.writeText(boardLinkEl.href);
    const old = btn.textContent;
    btn.textContent = t("s_copied");
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch { /* 剪贴板不可用时点链接也能打开 */ }
});
async function saveBoard() {
  const name = boardNameEl.value.trim();
  const slug = boardSlugEl.value.trim();
  if (!SLUG_RE.test(slug)) return;
  boardSaveEl.className = "save-state"; boardSaveEl.textContent = t("st_saving");
  try {
    const res = await fetch("/api/my/board", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, slug }),
    });
    if (res.ok) {
      boardSaveEl.className = "save-state ok"; boardSaveEl.textContent = t("st_saved");
      updateBoardLink(slug);
      if (slug !== boardSlug) {
        boardSlug = slug;
        history.replaceState(null, "", "/b/" + slug); // 地址栏跟随新 slug
      }
    } else {
      let errMsg = t("st_failed");
      try { const b = await res.json(); if (b.error) errMsg = b.error; } catch { /* ignore */ }
      boardSaveEl.className = "save-state err"; boardSaveEl.textContent = errMsg;
    }
  } catch { boardSaveEl.className = "save-state err"; boardSaveEl.textContent = t("st_failed"); }
}
boardSlugEl.addEventListener("input", () => {
  const v = boardSlugEl.value.trim();
  boardSlugEl.classList.toggle("bad", !(v === "" || SLUG_RE.test(v)));
  updateBoardLink(v);
  if (SLUG_RE.test(v)) {
    clearTimeout(boardTimer);
    boardTimer = setTimeout(saveBoard, 600);
  }
});
boardNameEl.addEventListener("input", () => {
  clearTimeout(boardTimer);
  boardTimer = setTimeout(saveBoard, 600);
});

document.getElementById("btnLogout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  try { sessionStorage.clear(); } catch {} // 清掉身份提示与资产页缓存
  location.replace("/login");
});

/* ---------- 主人模式初始化 ---------- */
function initOwner(settings) {
  mountAiSettings();
  mountJevSettings(document.getElementById("jevCfgBody"), LANG);
  const zh = LANG === "zh";
  document.getElementById("defCfgName").textContent = zh ? "估值默认值" : "Valuation defaults";
  document.getElementById("defMosLab").textContent = zh ? "安全边际 %" : "Margin of safety %";
  document.getElementById("defExtLab").textContent = zh ? "泡沫阈值 %" : "Bubble threshold %";
  document.getElementById("defNote").textContent = zh ? "新添加标的时预填的值，单个标的仍可在它的设置里改。安全边际 5–95，泡沫阈值 5–300；留空用 50 / 40。" : "Prefilled when you add a stock; each stock can still override them. Margin 5–95, bubble 5–300; blank = 50 / 40.";
  defMos.value = settings.default_mos || ""; defExt.value = settings.default_ext || "";
  document.getElementById("dataCfgName").textContent = zh ? "数据" : "Data";
  document.getElementById("btnExport").textContent = zh ? "导出自选与估值卡（JSON）" : "Export watchlist & valuations (JSON)";
  // 看板信息从 /api/me 来，已在 init 中确定 slug
  // 看板名/slug：取 /api/me（再取一次便宜且总是新鲜）
  fetch("/api/me").then((r) => r.ok ? r.json() : null).then((me) => {
    if (!me || !me.board) return;
    boardNameEl.value = me.board.name || "";
    boardSlugEl.value = me.board.slug || "";
    updateBoardLink(me.board.slug || "");
  }).catch(() => {});
}

init().finally(() => document.body.classList.remove("booting"));
setInterval(fetchQuotes, 60000);
