// 横向五段色带：钟摆"展平"——同一套 priceToPhi 映射，列表行里用
import { ZONES, computeAnchors, priceToPhi } from "./core.js";
import { LANG } from "./i18n.js";

const REDUCE = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
const SEG_DEG = 180 / ZONES.length; // 36
// 区间缩写（与钟摆五区间一一对应：深度低估/低估/合理/高估/极度高估）
const ZONE_SHORT = {
  zh: ["深值", "低估", "合理", "高估", "极高"],
  en: ["Deep", "Under", "Fair", "Over", "Ext"],
};

export class Bar {
  constructor(mount) { this.build(mount); }
  build(mount) {
    const shorts = ZONE_SHORT[LANG] || ZONE_SHORT.en;
    const root = document.createElement("div"); root.className = "vbar";
    const labels = document.createElement("div"); labels.className = "vbar-labels";
    this.labelEls = ZONES.map((z, i) => { const s = document.createElement("span"); s.textContent = shorts[i] || z.en; labels.appendChild(s); return s; });
    const track = document.createElement("div"); track.className = "vbar-track";
    this.segs = ZONES.map(() => { const d = document.createElement("div"); d.className = "vbar-seg"; track.appendChild(d); return d; });
    this.marker = document.createElement("div"); this.marker.className = "vbar-marker"; this.marker.style.left = "50%";
    track.appendChild(this.marker);
    const ticks = document.createElement("div"); ticks.className = "vbar-ticks";
    this.tickEls = [0, 1, 2, 3].map((k) => { const s = document.createElement("span"); s.className = "vbar-tick"; s.style.left = ((k + 1) * 20) + "%"; ticks.appendChild(s); return s; });
    root.append(labels, track, ticks);
    mount.appendChild(root);
    this.root = root;
  }
  set(cfg, animate = true) {
    const anchors = computeAnchors(cfg); // [0, t1, t2, t3, t4, Infinity]
    this.tickEls.forEach((el, k) => { const v = anchors[k + 1]; el.textContent = isFinite(v) ? Math.round(v) : ""; });
    const hasPrice = cfg.price > 0;
    const phi = hasPrice ? priceToPhi(anchors, cfg.price) : 90;
    const zi = hasPrice ? Math.min(ZONES.length - 1, Math.floor(Math.max(0, Math.min(180, phi)) / SEG_DEG)) : -1;
    this.segs.forEach((d, i) => { d.style.background = i === zi ? ZONES[i].hex : "var(--track)"; });
    this.labelEls.forEach((s, i) => { s.style.color = i === zi ? "var(--ink)" : "var(--ink-mute)"; s.style.fontWeight = i === zi ? "600" : "500"; });
    const x = Math.max(0, Math.min(100, phi / 180 * 100));
    this.marker.style.display = hasPrice ? "" : "none";
    if (!animate || REDUCE) { this.marker.style.transition = "none"; this.marker.style.left = x + "%"; }
    else { this.marker.style.transition = "left 1.1s cubic-bezier(.22,1,.36,1)"; requestAnimationFrame(() => { this.marker.style.left = x + "%"; }); }
  }
  destroy() { if (this.root) this.root.remove(); }
}
