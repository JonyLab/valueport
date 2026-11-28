// Fundamentals & financials chart/table rendering and numeric formatters for the stock detail view.
import { LANG } from "../i18n.js";
import { METRICS, metricKey, metricSeries, sparkGeom } from "../metric-spark.js";

const FD_NS = "http://www.w3.org/2000/svg";

// 大数字格式：按货币用 亿/万亿（CNY/HKD）或 K/M/B/T
export function fmtBig(n, currency) {
  if (!(n > 0)) return "—";
  const cjk = currency === "CNY" || currency === "HKD" || currency === "CNH";
  if (cjk) { const yi = n / 1e8; return yi >= 10000 ? (yi / 1e4).toFixed(2) + " 万亿" : yi.toFixed(2) + " 亿"; }
  for (const [s, base] of [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]]) if (n >= base) return (n / base).toFixed(2) + s;
  return String(Math.round(n));
}

// 价格显示精度：≥100 取整、≥10 一位小数、其余两位
export function fmtPx(v) {
  return !Number.isFinite(v) ? "—" : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

// 坐标轴「好看」的步长（1 / 2 / 5 × 10^n）
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}

export function fdEl(tag, attrs, text) {
  const e = document.createElementNS(FD_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

// 某科目按「年份升序」的 {year,value}（财报数组最新在前，需反转）
export function fdSeries(financials, kind, field) {
  const a = financials && financials[kind] && financials[kind].find((x) => x.field === field);
  if (!a || !a.values) return [];
  return a.values.map((v) => ({ year: v.year, value: v.value })).filter((v) => Number.isFinite(v.value)).reverse();
}

export function fdMoney(n, cur) {
  return Number.isFinite(n) ? (n < 0 ? "−" : "") + fmtBig(Math.abs(n), cur) : "—";
}

export const fdLast = (s) => (s.length ? s[s.length - 1].value : NaN);

// 按年份对齐两序列做逐年比值/运算，返回 {year,value} 升序
export function fdDerive(base, by, fn) {
  return base.map((x) => {
    const m = by.find((y) => y.year === x.year);
    const v = m ? fn(x.value, m.value) : null;
    return Number.isFinite(v) ? { year: x.year, value: v } : null;
  }).filter(Boolean);
}

const fdDiv = (cls, css) => { const d = document.createElement("div"); d.className = cls; if (css) d.style.cssText = css; return d; };
function fdNiceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

// 基本面图表：柱子 / 圆点 / 年份 / 网格刻度用 HTML 画，只有折线用 SVG
export function fdPlot({ years, bars, line, H = 168, negIsGood = false, fmt = (v) => String(v), lineOnly = false }) {
  const n = years.length;
  const vals = [...(bars || []).map((b) => b.value), ...(line || []).map((l) => l.value)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lineOnly) { const pad = (hi - lo) * 0.35 || Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad; }
  else { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const step = fdNiceStep((hi - lo) / 3 || 1);
  if (!lineOnly) { lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step; }
  const PADT = 8, PADB = 2, Y = (v) => PADT + (hi - v) / ((hi - lo) || 1) * (H - PADT - PADB);
  const root = fdDiv("fd-plot"), area = fdDiv("fd-plot-area", `height:${H}px`);
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) {
    const g = fdDiv("fd-grid" + (Math.abs(t) < step * 1e-6 ? " zero" : ""), `top:${Y(t)}px`);
    const lab = document.createElement("span"); lab.className = "fd-gridlab"; lab.textContent = Math.abs(t) < step * 1e-6 ? "0" : String(fmt(t)).replace(/\.0+(?=\D|$)/, "");
    g.appendChild(lab); area.appendChild(g);
  }
  if (bars) {
    const cols = fdDiv("fd-cols");
    bars.forEach((b) => {
      const col = fdDiv("fd-col");
      const v = b.value, top = Y(Math.max(v, 0)), bot = Y(Math.min(v, 0));
      const bar = fdDiv("fd-bar2" + (v < 0 ? (negIsGood ? " good down" : " neg down") : ""), `top:${top}px;height:${Math.max(bot - top, 2)}px`);
      col.appendChild(bar); cols.appendChild(col);
    });
    area.appendChild(cols);
  }
  if (line && line.length) {
    const X = (i) => (i + 0.5) / n * 1000;
    const idx = (l) => years.indexOf(l.year);
    const pts = line.filter((l) => idx(l) >= 0).map((l) => [X(idx(l)), Y(l.value)]);
    const svg = fdEl("svg", { class: "fd-plot-svg", viewBox: `0 0 1000 ${H}`, preserveAspectRatio: "none" });
    if (lineOnly && pts.length) svg.appendChild(fdEl("polygon", { class: "fd-area", points: `${pts[0][0]},${H} ${pts.map((p) => p.join(",")).join(" ")} ${pts[pts.length - 1][0]},${H}` }));
    svg.appendChild(fdEl("polyline", { class: "fd-line2" + (lineOnly ? " ink" : ""), points: pts.map((p) => p.join(",")).join(" "), "vector-effect": "non-scaling-stroke" }));
    area.appendChild(svg);
    pts.forEach(([x, y]) => area.appendChild(fdDiv("fd-pdot" + (lineOnly ? " ink" : ""), `left:${x / 10}%;top:${y}px`)));
  }
  const axis = fdDiv("fd-axis");
  years.forEach((y) => { const sp = document.createElement("span"); sp.textContent = String(y).slice(2); axis.appendChild(sp); });
  root.append(area, axis);
  return root;
}

export function fdBarLine(bars, line, fmt) { return fdPlot({ years: bars.map((b) => b.year), bars, line, H: 180, fmt }); }
export function fdBars(series, negIsGood, h, fmt) { return fdPlot({ years: series.map((x) => x.year), bars: series, H: h || 130, negIsGood, fmt }); }
export function fdLineChart(series, h, fmt) { return fdPlot({ years: series.map((x) => x.year), line: series, H: h || 130, fmt, lineOnly: true }); }

export function fdSpark(series) {
  const W = 120, H = 44, svg = fdEl("svg", { class: "fd-sparksvg", width: "100%", height: H, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  const vals = series.map((s) => s.value);
  let mx = Math.max(...vals), mn = Math.min(...vals);
  const pad = (mx - mn) * 0.25 || Math.abs(mx) * 0.1 || 1; mx += pad; mn -= pad;
  const Y = (v) => H - 2 - (v - mn) / ((mx - mn) || 1) * (H - 4), X = (i) => i / ((series.length - 1) || 1) * W;
  if (mn < 0 && mx > 0) svg.appendChild(fdEl("line", { class: "fd-spark0", x1: 0, x2: W, y1: Y(0), y2: Y(0), "vector-effect": "non-scaling-stroke" }));
  const pts = series.map((s, i) => `${X(i)},${Y(s.value)}`).join(" ");
  svg.appendChild(fdEl("polygon", { class: "fd-area", points: `0,${H} ${pts} ${W},${H}` }));
  svg.appendChild(fdEl("polyline", { class: "fd-spark", points: pts, "vector-effect": "non-scaling-stroke" }));
  return svg;
}

export const fdRange = (s) => { const v = s.map((x) => x.value); return `${Math.min(...v).toFixed(0)}% → ${Math.max(...v).toFixed(0)}%`; };

export function fdChartWrap(svg, years, series, opts) {
  const W = (opts && opts.W) || 800, PADX = (opts && opts.PADX != null) ? opts.PADX : 0, n = years.length;
  const wrap = document.createElement("div"); wrap.className = "fd-chartwrap" + (svg.classList.contains("fd-plot") ? " plot" : ""); wrap.appendChild(svg);
  const line = document.createElement("div"); line.className = "fd-hoverline"; line.style.display = "none";
  const tip = document.createElement("div"); tip.className = "fd-tip"; tip.style.display = "none";
  wrap.appendChild(line); wrap.appendChild(tip);
  const gap = (W - PADX * 2) / n;
  const colAt = (x, rw) => { const vx = x / rw * W; return Math.max(0, Math.min(n - 1, Math.floor((vx - PADX) / gap))); };
  const show = (e) => {
    const off = wrap.classList.contains("plot") ? 52 : 0;
    const r = svg.getBoundingClientRect(); if (!r.width) return;
    const col = colAt(e.clientX - r.left - off, r.width - off), yr = years[col];
    tip.innerHTML = `<div class="fd-tipyr">${yr}</div>` + series.map((s) => {
      const pt = s.data.find((d) => d.year === yr);
      return `<div class="fd-tiprow"><span class="fd-tipk"><i style="background:${s.color}"></i>${s.label}</span><b>${pt ? s.fmt(pt.value) : "—"}</b></div>`;
    }).join("");
    tip.style.display = "block";
    const cx = (PADX + gap * (col + 0.5)) / W * (r.width - off);
    line.style.left = cx + "px"; line.style.display = "block";
    const tw = tip.offsetWidth; tip.style.left = Math.max(0, Math.min(r.width - tw, off + cx - tw / 2)) + "px";
  };
  const hide = () => { tip.style.display = "none"; line.style.display = "none"; };
  svg.addEventListener("mousemove", show); svg.addEventListener("mouseleave", hide);
  return wrap;
}

// AI 结论旁的迷你图：模型只给白名单里的指标 key，曲线和数字取自已加载的财报
export function aiSparkEl(metric, financials, dividends, cur, onOpenSec) {
  const key = metricKey(metric), m = key && METRICS[key];
  if (!m) return null;
  const series = metricSeries(key, financials, dividends), g = sparkGeom(series, 64, 20, 2);
  if (!g) return null;
  const zh = LANG === "zh", v = g.latest.value, dcur = (m.kind === "DIV" && dividends && dividends.currency) || cur;
  const val = m.unit === "money" ? fdMoney(v, cur) : m.unit === "pct" ? v.toFixed(1) + "%" : v.toFixed(2) + (dcur ? " " + dcur : "");
  const tip = `${zh ? m.zh : m.en} · ${g.latest.year} ${val}`;
  const b = document.createElement("button"); b.type = "button"; b.className = "ai-spark"; b.dataset.tip = tip;
  b.setAttribute("aria-label", tip + (m.sec ? (zh ? "，查看基本面" : ", view in Fundamentals") : ""));
  const svg = fdEl("svg", { width: 64, height: 20, viewBox: "0 0 64 20", "aria-hidden": "true" });
  if (g.zero != null) svg.appendChild(fdEl("line", { class: "sp-zero", x1: 0, x2: 64, y1: g.zero, y2: g.zero }));
  svg.appendChild(fdEl("polygon", { class: "sp-area", points: g.area }));
  svg.appendChild(fdEl("polyline", { class: "sp-line", points: g.line }));
  svg.appendChild(fdEl("circle", { class: "sp-dot", cx: g.last[0], cy: g.last[1], r: 2.4 }));
  b.appendChild(svg);
  b.addEventListener("click", () => { if (onOpenSec) onOpenSec(m.sec); });
  return b;
}

// 财报数值格式：大额用 fmtBig（按币种），小额（比率/每股）保留两位
export function finFmt(n, currency) {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return (n < 0 ? "-" : "") + fmtBig(a, currency);
  return n.toFixed(2);
}

// 一张报表（accounts）→ 多期表格（最多 6 期）
export function financialsTable(accounts) {
  const cols = Math.min(6, (accounts[0] && accounts[0].values.length) || 0);
  const table = document.createElement("table"); table.className = "fin-table";
  const thead = document.createElement("thead"); const htr = document.createElement("tr");
  htr.appendChild(document.createElement("th"));
  for (let j = 0; j < cols; j++) { const th = document.createElement("th"); th.textContent = accounts[0].values[j].period; htr.appendChild(th); }
  thead.appendChild(htr); table.appendChild(thead);
  const tb = document.createElement("tbody");
  accounts.forEach((a) => {
    const tr = document.createElement("tr");
    const nm = document.createElement("td"); nm.className = "fin-name"; nm.textContent = a.name; tr.appendChild(nm);
    for (let j = 0; j < cols; j++) { const td = document.createElement("td"); const v = a.values[j]; td.textContent = v ? finFmt(v.value, a.currency) : "—"; tr.appendChild(td); }
    tb.appendChild(tr);
  });
  table.appendChild(tb); return table;
}
