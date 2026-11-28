// Pure formatting, unitized money parsing, field-initial helpers, and SVG schedule chart builder for valuation-ui.js.
import { methodMenuMeta } from "./index.js";

export const MONEY_METAS = new Set(["revenue", "netIncome", "netDebt", "ebitda", "fcf"]);

export function fmt(v, dash = "—") {
  return (v !== null && isFinite(v)) ? Number(v).toFixed(2) : dash;
}

export function fmtMoney(n) {
  const s = n < 0 ? "-" : "", a = Math.abs(n);
  if (a >= 1e12) return s + (a / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(2) + "K";
  return s + a.toFixed(2);
}

// 解析带单位的金额：支持 K/M/B/T、万/亿/万亿/兆、千分位、负号
export function parseMoney(s) {
  if (typeof s !== "string") return NaN;
  s = s.trim().replace(/[,，\s]/g, "");
  if (!s) return NaN;
  const m = /^(-?\d*\.?\d+)(万亿|亿|万|兆|[kmbtKMBT])?$/.exec(s);
  if (!m) return NaN;
  const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, "万": 1e4, "亿": 1e8, "万亿": 1e12, "兆": 1e12 };
  const u = (m[2] || "").toLowerCase();
  return parseFloat(m[1]) * (mult[u] ?? 1);
}

export function fmtKind(n, kind) {
  if (!Number.isFinite(n)) return null;
  if (kind === "mult") return n.toFixed(1) + "x";
  if (kind === "pct") return n.toFixed(1) + "%";
  if (kind === "money") return fmtMoney(n);
  return n.toFixed(2);
}

export function fmtRange(a, b, kind) {
  const A = fmtKind(a, kind), B = fmtKind(b, kind);
  if (A === null && B === null) return "—";
  if (A === null) return B;
  if (B === null) return A;
  return A === B ? A : `${A}–${B}`;
}

export function initialFor(field, ctx) {
  let v = "";
  if (typeof field.prefill === "function") { try { v = field.prefill(ctx); } catch { v = ""; } }
  const blank = v === "" || v === undefined || v === null || (typeof v === "number" && !isFinite(v));
  if (blank && field.default !== undefined) v = field.default;
  return v;
}

export function textFor(obj, lang, fallback = "") {
  return (obj && (obj[lang] || obj.zh || obj.en)) || fallback;
}

export function modelTitle(model, lang) {
  const meta = methodMenuMeta(model);
  return textFor(meta && meta.title, lang, (model && model.label && model.label[lang]) || (model && model.key) || "");
}

export function buildScheduleChart(series) {
  const wrap = document.createElement("div");
  wrap.className = "vc-chart-wrap";
  const w = 640, h = 260, pad = 34;
  const vals = series.map((p) => p.value);
  const min = Math.min(0, ...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => pad + (series.length === 1 ? 0 : i * (w - pad * 2) / (series.length - 1));
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const pts = series.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const area = `${pad},${h - pad} ${pts} ${x(series.length - 1)},${h - pad}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "vc-chart");
  svg.innerHTML = `
    <polyline class="vc-chart-area" points="${area}"></polyline>
    <polyline class="vc-chart-line" points="${pts}"></polyline>
    ${series.map((p, i) => `<circle class="vc-chart-dot" cx="${x(i)}" cy="${y(p.value)}" r="3"></circle>`).join("")}
    ${series.map((p, i) => `<text class="vc-chart-x" x="${x(i)}" y="${h - 10}" text-anchor="middle">${p.label}</text>`).join("")}
  `;
  wrap.appendChild(svg);
  return wrap;
}
