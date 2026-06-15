import { ZONES, N, SEG, PHI_MAX, computeAnchors, priceToPhi } from "./core.js";

const NS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
const REDUCE = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
let UID = 0;

export class Gauge {
  constructor(mount) {
    this.uid = ++UID;
    this.cx = 300; this.cy = 112;
    this.rO = 190; this.rI = 134;
    this.rM = (this.rO + this.rI) / 2;
    this.rB = this.rI + 12; this.rL = this.rM + 9; this.rN = this.rI - 14;
    this.RHUB = 74;
    this.anchors = [0, 1, 2, 3, 4, Infinity];
    this.current = 0; this.target = 0; this.raf = null; this.swinging = false;
    this.build(mount);
  }
  pt(r, phi) { return [this.cx - r * Math.cos(phi * D2R), this.cy + r * Math.sin(phi * D2R)]; }
  annular(a0, a1) {
    const [ox0, oy0] = this.pt(this.rO, a0), [ox1, oy1] = this.pt(this.rO, a1);
    const [ix1, iy1] = this.pt(this.rI, a1), [ix0, iy0] = this.pt(this.rI, a0);
    return `M ${ox0} ${oy0} A ${this.rO} ${this.rO} 0 0 0 ${ox1} ${oy1} `
         + `L ${ix1} ${iy1} A ${this.rI} ${this.rI} 0 0 1 ${ix0} ${iy0} Z`;
  }
  mk(tag, attrs = {}) { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; }
  build(mount) {
    const svg = this.mk("svg", { viewBox: "0 0 600 322", role: "img", "aria-label": "估值钟摆" });
    const { cx, cy, rO, rI, rN, rL, rB } = this;
    const gT = this.mk("g");
    for (let a = 2; a < 180; a += 3) {
      const [x0, y0] = this.pt(rI + 3, a), [x1, y1] = this.pt(rO - 3, a);
      gT.appendChild(this.mk("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: "var(--track-edge)", "stroke-width": 1, opacity: 0.38 }));
    }
    this.bands = [];
    const gB = this.mk("g");
    ZONES.forEach((z, i) => {
      const b = this.mk("path", { d: this.annular(i * SEG, (i + 1) * SEG), fill: "var(--track)", class: "gband" });
      b.style.transition = "fill .4s ease";
      gB.appendChild(b); this.bands.push(b);
    });
    const gD = this.mk("g");
    for (let i = 1; i < N; i++) {
      const [x0, y0] = this.pt(rI, i * SEG), [x1, y1] = this.pt(rO, i * SEG);
      gD.appendChild(this.mk("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: "var(--divider)", "stroke-width": 1.4 }));
    }
    const base = this.mk("line", { x1: cx - rO, y1: cy, x2: cx + rO, y2: cy, stroke: "var(--divider)", "stroke-width": 1.5, "stroke-linecap": "round" });
    const defs = this.mk("defs"); const gL = this.mk("g"); this.labels = [];
    ZONES.forEach((z, i) => {
      const a0 = i * SEG + 3, a1 = (i + 1) * SEG - 3;
      const [sx, sy] = this.pt(rL, a0), [ex, ey] = this.pt(rL, a1);
      const id = `g${this.uid}lp${i}`;
      defs.appendChild(this.mk("path", { id, d: `M ${sx} ${sy} A ${rL} ${rL} 0 0 0 ${ex} ${ey}` }));
      const t = this.mk("text", { class: "glabel" });
      t.style.cssText = "font-size:11px;font-weight:600;letter-spacing:.02em;fill:var(--ink-mute);transition:fill .35s";
      const tp = this.mk("textPath", { href: "#" + id, startOffset: "50%", "text-anchor": "middle" });
      tp.textContent = z.en; t.appendChild(tp);
      gL.appendChild(t); this.labels.push(t);
    });
    this.nums = [];
    const gN = this.mk("g");
    for (let i = 1; i < N; i++) {
      const [x, y] = this.pt(rN, i * SEG);
      const t = this.mk("text", { x, y: y + 4, "text-anchor": "middle" });
      t.style.cssText = "font-family:var(--mono);font-size:12px;font-weight:600;fill:var(--ink-soft);font-variant-numeric:tabular-nums";
      gN.appendChild(t); this.nums.push(t);
    }
    this.gNeedle = this.mk("g");
    const [bx, by] = this.pt(rB, 90);
    const needle = this.mk("line", { x1: cx, y1: cy, x2: bx, y2: by, stroke: "var(--hub)", "stroke-width": 2.4, "stroke-linecap": "round" });
    this.ring = this.mk("circle", { cx: bx, cy: by, r: 9, fill: "#fff", "stroke-width": 4, class: "gring" });
    this.ring.style.transition = "stroke .4s ease";
    this.dot = this.mk("circle", { cx: bx, cy: by, r: 3, class: "gdot" });
    this.dot.style.transition = "fill .4s ease";
    this.gNeedle.append(needle, this.ring, this.dot);
    const hubPath = `M ${cx - this.RHUB} ${cy} A ${this.RHUB} ${this.RHUB} 0 0 0 ${cx + this.RHUB} ${cy} Z`;
    const hubShadow = this.mk("path", { d: hubPath, fill: "rgba(20,30,50,.08)", transform: "translate(0,2)" });
    const hubRing = this.mk("path", { d: hubPath, fill: "#fff", stroke: "#dfe3ea", "stroke-width": 1.5 });
    // 第一行：名称（大）；第二行：代码（小）
    this.hubName = this.mk("text", { x: cx, y: cy + this.RHUB * 0.40, "text-anchor": "middle", "dominant-baseline": "middle" });
    this.hubName.style.cssText = "font-family:var(--font);font-weight:700;letter-spacing:.01em;fill:var(--ink)";
    this.hubCode = this.mk("text", { x: cx, y: cy + this.RHUB * 0.70, "text-anchor": "middle", "dominant-baseline": "middle" });
    this.hubCode.style.cssText = "font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.04em;fill:var(--ink-mute)";
    svg.append(gT, gB, gD, base, defs, gL, gN, this.gNeedle, hubShadow, hubRing, this.hubName, this.hubCode);
    mount.appendChild(svg);
    this.svg = svg;
  }
  paint(phi) {
    const zi = this.hasPrice ? Math.min(N - 1, Math.floor(Math.max(0, Math.min(180, phi)) / SEG)) : -1;
    const z = zi >= 0 ? ZONES[zi] : null;
    this.gNeedle.setAttribute("transform", `rotate(${90 - phi} ${this.cx} ${this.cy})`);
    this.bands.forEach((b, i) => b.setAttribute("fill", i === zi ? z.hex : "var(--track)"));
    this.labels.forEach((t, i) => t.style.fill = i === zi ? "#fff" : "var(--ink-mute)");
    this.ring.setAttribute("stroke", z ? z.hex : "#c4cad4");
    this.dot.setAttribute("fill", z ? z.hex : "#c4cad4");
  }
  set(cfg, animate = true) {
    this.anchors = computeAnchors(cfg);
    // 区间未填完时锚点为 NaN：刻度留空而不是显示 "NaN"
    this.nums.forEach((t, k) => { const v = this.anchors[k + 1]; t.textContent = isFinite(v) ? Math.round(v) : ""; });
    // 第一行名称、第二行代码；无名称时名称行直接显示代码、隐藏第二行
    const code = (cfg.ticker || "—").toUpperCase();
    const name = (cfg.name || "").trim();
    if (name) {
      this.hubName.textContent = name.length > 9 ? name.slice(0, 8) + "…" : name;
      this.hubName.style.fontSize = name.length > 6 ? "15px" : "18px";
      this.hubCode.textContent = code;
    } else {
      this.hubName.textContent = code;
      this.hubName.style.fontSize = code.length > 6 ? "15px" : "20px";
      this.hubCode.textContent = "";
    }
    this.hasPrice = cfg.price > 0;
    this.target = this.hasPrice ? priceToPhi(this.anchors, cfg.price) : 90;
    if (!animate || REDUCE) { this.current = this.target; this.paint(this.current); return; }
    if (!this.raf && !this.swinging) this.follow();
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
