import { ZONES, N, SEG, PHI_MAX, computeAnchors, priceToPhi } from "./core.js";
import { LANG } from "./i18n.js";

// 区间名（随界面语言；与卡片五段条、详情文案一致）
const ZONE_NAMES = { zh: ["击球区", "低估", "合理", "高估", "泡沫区"], en: ["Strike zone", "Undervalued", "Fair value", "Overvalued", "Bubble"] };
const GAP = 1.6; // 相邻区间带之间的缝隙（度）
const RC = 10;   // 区间带圆角半径

const NS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
const REDUCE = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
let UID = 0;

export class Gauge {
  constructor(mount, opts = {}) {
    this.uid = ++UID;
    this.compact = !!opts.compact; // 紧凑模式：隐藏区间标签/刻度数字/中枢文字（名称已移到左侧信息区）
    this.cx = 300; this.cy = 112;
    this.rO = 190; this.rI = 142;
    this.rM = (this.rO + this.rI) / 2;
    this.rB = this.rI + 12; this.rL = this.rM; this.rN = this.rI - 16; // rL：区间名沿带中线居中
    this.RHUB = 74;
    this.anchors = [0, 1, 2, 3, 4, Infinity];
    this.current = 0; this.target = 0; this.raf = null; this.swinging = false;
    this.build(mount);
  }
  pt(r, phi) { return [this.cx - r * Math.cos(phi * D2R), this.cy + r * Math.sin(phi * D2R)]; }
  // 区间带：两侧各内缩半个缝隙，带与带之间留出细缝（首尾贴着水平基线不内缩）
  band(i) { return this.annular(i * SEG + (i ? GAP / 2 : 0), (i + 1) * SEG - (i < N - 1 ? GAP / 2 : 0)); }
  // 圆角扇环：四个角各用一段二次贝塞尔（控制点取原尖角）过渡，圆角半径 RC
  annular(a0, a1) {
    const { rO, rI } = this, rc = Math.min(RC, (rO - rI) / 2);
    const dO = rc / rO / D2R, dI = rc / rI / D2R; // 圆角在内外弧上占的角度
    const P = (r, a) => this.pt(r, a).join(" ");
    return `M ${P(rO - rc, a0)} Q ${P(rO, a0)} ${P(rO, a0 + dO)} `
         + `A ${rO} ${rO} 0 0 0 ${P(rO, a1 - dO)} Q ${P(rO, a1)} ${P(rO - rc, a1)} `
         + `L ${P(rI + rc, a1)} Q ${P(rI, a1)} ${P(rI, a1 - dI)} `
         + `A ${rI} ${rI} 0 0 1 ${P(rI, a0 + dI)} Q ${P(rI, a0)} ${P(rI + rc, a0)} Z`;
  }
  mk(tag, attrs = {}) { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; }
  build(mount) {
    const svg = this.mk("svg", { viewBox: "0 0 600 322", role: "img", "aria-label": LANG === "zh" ? "估值钟摆" : "Valuation pendulum" });
    const { cx, cy, rN, rL, rB } = this;
    // 五段区间带（无细刻度、无分隔线、无基线；靠缝隙分段）
    this.bands = [];
    const gB = this.mk("g");
    ZONES.forEach((z, i) => {
      const b = this.mk("path", { d: this.band(i), fill: "var(--track)", class: "gband" });
      b.style.transition = "fill .4s ease";
      gB.appendChild(b); this.bands.push(b);
    });
    const names = ZONE_NAMES[LANG] || ZONE_NAMES.en;
    const defs = this.mk("defs"); const gL = this.mk("g"); this.labels = [];
    ZONES.forEach((z, i) => {
      const a0 = i * SEG + 3, a1 = (i + 1) * SEG - 3;
      const [sx, sy] = this.pt(rL, a0), [ex, ey] = this.pt(rL, a1);
      const id = `g${this.uid}lp${i}`;
      defs.appendChild(this.mk("path", { id, d: `M ${sx} ${sy} A ${rL} ${rL} 0 0 0 ${ex} ${ey}` }));
      const t = this.mk("text", { class: "glabel", "dominant-baseline": "central" });
      t.style.cssText = "font-family:var(--font);font-size:12.5px;font-weight:500;fill:var(--ink-mute);transition:fill .35s";
      const tp = this.mk("textPath", { href: "#" + id, startOffset: "50%", "text-anchor": "middle" });
      tp.textContent = names[i] || z.en; t.appendChild(tp);
      gL.appendChild(t); this.labels.push(t);
    });
    this.nums = [];
    const gN = this.mk("g");
    for (let i = 1; i < N; i++) {
      const [x, y] = this.pt(rN, i * SEG);
      const t = this.mk("text", { x, y: y + 4, "text-anchor": "middle" });
      t.style.cssText = "font-family:var(--font);font-size:13px;font-weight:500;fill:var(--ink-soft);font-variant-numeric:tabular-nums";
      gN.appendChild(t); this.nums.push(t);
    }
    this.gNeedle = this.mk("g");
    const [bx, by] = this.pt(rB, 90);
    // 指针从圆心下方 20 起画（被中枢半圆盖住），否则圆头线帽会从半圆上沿露出一个小黑点
    const needle = this.mk("line", { x1: cx, y1: cy + 20, x2: bx, y2: by, stroke: "var(--hub)", "stroke-width": 3, "stroke-linecap": "round" });
    this.ring = this.mk("circle", { cx: bx, cy: by, r: 9, fill: "#fff", "stroke-width": 3.5, class: "gring" });
    this.ring.style.transition = "stroke .4s ease";
    this.dot = this.mk("circle", { cx: bx, cy: by, r: 3, class: "gdot" });
    this.dot.style.transition = "fill .4s ease";
    this.gNeedle.append(needle, this.ring, this.dot);
    // 中枢半圆：两个上角圆角（RC），无投影
    const R = this.RHUB, d = RC / R, cs = R * Math.cos(d), sn = R * Math.sin(d);
    const hubPath = `M ${cx - R + RC} ${cy} L ${cx + R - RC} ${cy} Q ${cx + R} ${cy} ${cx + cs} ${cy + sn} `
                  + `A ${R} ${R} 0 0 1 ${cx - cs} ${cy + sn} Q ${cx - R} ${cy} ${cx - R + RC} ${cy} Z`;
    const hubRing = this.mk("path", { d: hubPath, fill: "#fff" });
    // 第一行：名称（大）；第二行：代码（小）
    this.hubName = this.mk("text", { x: cx, y: cy + this.RHUB * 0.40, "text-anchor": "middle", "dominant-baseline": "middle" });
    this.hubName.style.cssText = "font-family:var(--font);font-weight:500;letter-spacing:-.01em;fill:var(--ink)";
    this.hubCode = this.mk("text", { x: cx, y: cy + this.RHUB * 0.70, "text-anchor": "middle", "dominant-baseline": "middle" });
    this.hubCode.style.cssText = "font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.04em;fill:var(--ink-mute)";
    svg.append(defs, gB, gL, gN, this.gNeedle, hubRing, this.hubName, this.hubCode);
    if (this.compact) { // 小图：保留刻度数字，隐藏区间词标签/中枢文字
      gL.style.display = "none";
      this.hubName.style.display = "none"; this.hubCode.style.display = "none";
      this.nums.forEach((t) => { t.style.fontSize = "24px"; }); // 放大刻度数字，小图上才看得清
    }
    mount.appendChild(svg);
    this.svg = svg;
  }
  paint(phi) {
    const zi = this.hasPrice ? Math.min(N - 1, Math.floor(Math.max(0, Math.min(180, phi)) / SEG)) : -1;
    const z = zi >= 0 ? ZONES[zi] : null;
    this.gNeedle.setAttribute("transform", `rotate(${90 - phi} ${this.cx} ${this.cy})`);
    this.bands.forEach((b, i) => b.setAttribute("fill", i === zi ? z.hex : "var(--track)"));
    this.labels.forEach((t, i) => t.style.fill = i === zi ? "#fff" : "var(--ink-mute)");
    this.ring.setAttribute("stroke", z ? z.hex : "var(--node)");
    this.dot.setAttribute("fill", z ? z.hex : "var(--node)");
  }
  set(cfg, animate = true) {
    this.anchors = computeAnchors(cfg);
    // 区间未填完时锚点为 NaN：刻度留空而不是显示 "NaN"
    this.nums.forEach((t, k) => { const v = this.anchors[k + 1]; t.textContent = isFinite(v) ? Math.round(v) : ""; });
    // 第一行名称、第二行代码；名称可被 setName() 覆盖（双语切换），否则用 cfg.name
    this._code = (cfg.ticker || "—").toUpperCase();
    this._renderHub(this.displayName != null ? this.displayName : (cfg.name || ""));
    this.hasPrice = cfg.price > 0;
    this.target = this.hasPrice ? priceToPhi(this.anchors, cfg.price) : 90;
    if (!animate || REDUCE) { this.current = this.target; this.paint(this.current); return; }
    if (!this.raf && !this.swinging) this.follow();
  }
  // 覆盖中枢名称（双语切换用）；持久保存，后续 set() 仍沿用
  setName(name) { this.displayName = name; this._renderHub(name); }
  // 中枢两行：名称行按长度自适应字号/截断（中文短、英文长），代码行用 ticker
  _renderHub(name) {
    if (this.compact) return; // 紧凑模式不显示中枢文字
    name = (name || "").trim();
    const code = this._code || "—";
    if (!name) {
      this.hubName.textContent = code;
      this.hubName.style.fontSize = code.length > 6 ? "15px" : "20px";
      this.hubCode.textContent = "";
      return;
    }
    const len = name.length;
    const fs = len <= 6 ? 18 : len <= 9 ? 15 : len <= 13 ? 13 : 12;
    const cap = len <= 6 ? 6 : len <= 9 ? 9 : len <= 13 ? 13 : 16;
    this.hubName.textContent = len > cap ? name.slice(0, cap - 1) + "…" : name;
    this.hubName.style.fontSize = fs + "px";
    this.hubCode.textContent = code;
  }
  follow() {
    const step = () => {
      this.current += (this.target - this.current) * 0.16;
      this.paint(this.current);
      if (Math.abs(this.target - this.current) > 0.05) { this.raf = requestAnimationFrame(step); }
      else { this.current = this.target; this.paint(this.current); this.raf = null; }
    };
    this.raf = requestAnimationFrame(step);
  }
  swingIn() {
    if (REDUCE) { this.current = this.target; this.paint(this.current); return; }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.swinging = true;
    const to = this.target, start = to >= 90 ? 8 : 172;
    const lambda = 0.9, omega = 3.0, t0 = performance.now();
    const step = (now) => {
      const t = (now - t0) / 1000, env = Math.exp(-lambda * t);
      this.current = Math.max(0, Math.min(180, to + (start - to) * env * Math.cos(omega * t)));
      this.paint(this.current);
      if (env > 0.012) { this.raf = requestAnimationFrame(step); }
      else { this.current = to; this.paint(to); this.raf = null; this.swinging = false; if (this.target !== to) this.follow(); }
    };
    this.raf = requestAnimationFrame(step);
  }
  repaint() { this.paint(this.current); } // 用配色变更后按当前角度重绘
  destroy() { if (this.raf) cancelAnimationFrame(this.raf); this.svg.remove(); }
}
