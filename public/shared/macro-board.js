// 宏观看板的纯逻辑（无 DOM）：市场显示偏好的（反）序列化、按规则生成的「今日一句话」、迷你走势线几何。
// 前端 macro.html 与后端 src/macro.js（校验 /api/my/macro-prefs）共用；test-core/macro-board.test.js 覆盖。

export const MACRO_MARKETS = ["us", "hk", "cn"];
export const PREFS_KEY = "macro_prefs"; // localStorage 键；也是 D1 settings 表里的 key
export const DEFAULT_PREFS = Object.freeze({ order: MACRO_MARKETS.slice(), hidden: [], cross: true, at: 0 });

// 任意输入 → 规范的偏好：order 必含全部市场且不重复（未知键丢弃，缺的按默认顺序补在后面），hidden ⊂ 市场，
// cross = 是否显示「利率 · 汇率 · 商品」，at = 最后修改时间（毫秒，多端同步时取较新的一份）
export function normalizePrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const order = [];
  for (const k of Array.isArray(p.order) ? p.order : []) if (MACRO_MARKETS.includes(k) && !order.includes(k)) order.push(k);
  for (const k of MACRO_MARKETS) if (!order.includes(k)) order.push(k);
  const hidden = MACRO_MARKETS.filter((k) => Array.isArray(p.hidden) && p.hidden.includes(k));
  const at = Number(p.at);
  return { order, hidden, cross: p.cross !== false, at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0 };
}
export function serializePrefs(p) {
  const n = normalizePrefs(p);
  return JSON.stringify({ order: n.order, hidden: n.hidden, cross: n.cross, at: n.at });
}
// 坏 JSON / 空值 → null（调用方据此判断「从没设置过」）
export function parsePrefs(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try { const j = JSON.parse(text); return j && typeof j === "object" && !Array.isArray(j) ? normalizePrefs(j) : null; } catch { return null; }
}
export const visibleMarkets = (p) => { const n = normalizePrefs(p); return n.order.filter((k) => !n.hidden.includes(k)); };
export const isDefaultPrefs = (p) => { const n = normalizePrefs(p); return n.cross && !n.hidden.length && n.order.join() === MACRO_MARKETS.join(); };
export function toggleMarket(p, key, on, now = Date.now()) {
  const n = normalizePrefs(p);
  const hidden = on ? n.hidden.filter((k) => k !== key) : [...n.hidden, key];
  return normalizePrefs({ ...n, hidden, at: now });
}
// dir = -1 上移 / +1 下移；到头了原样返回（不改 at）
export function moveMarket(p, key, dir, now = Date.now()) {
  const n = normalizePrefs(p), i = n.order.indexOf(key), j = i + dir;
  if (i < 0 || j < 0 || j >= n.order.length) return n;
  const order = n.order.slice(); [order[i], order[j]] = [order[j], order[i]];
  return normalizePrefs({ ...n, order, at: now });
}
export const setCross = (p, on, now = Date.now()) => normalizePrefs({ ...normalizePrefs(p), cross: !!on, at: now });
// 本地与云端各一份：取 at 较新的；一方没有就用另一方
export function pickNewer(local, remote) {
  if (!remote) return local ? normalizePrefs(local) : null;
  if (!local) return normalizePrefs(remote);
  return normalizePrefs(remote).at > normalizePrefs(local).at ? normalizePrefs(remote) : normalizePrefs(local);
}

// ---------- 一句话：按规则拼，不用 AI，不做预测 ----------
const sign = (v, d = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d) + "%";
// m = { indices: [{ name, pct, chg1y, fromHigh }], level?, zoneName? }；lang = "zh" | "en"
export function marketSummary(m, lang = "zh") {
  const zh = lang === "zh";
  const live = ((m && m.indices) || []).filter((x) => x && Number.isFinite(x.pct));
  const parts = [];
  if (live.length) {
    const avg = live.reduce((a, x) => a + x.pct, 0) / live.length;
    const up = live.filter((x) => x.pct > 0).length, dn = live.filter((x) => x.pct < 0).length;
    const mag = Math.abs(avg) < 0.3 ? (zh ? "小幅" : "slightly ") : Math.abs(avg) >= 1.5 ? (zh ? "大幅" : "sharply ") : "";
    const lead = live[0];
    let day;
    if (Math.abs(avg) < 0.1 && up && dn) day = zh ? "窄幅震荡" : "Flat, mixed";
    else if (up === live.length) day = zh ? `${mag}普涨` : `${mag}higher across the board`;
    else if (dn === live.length) day = zh ? `${mag}普跌` : `${mag}lower across the board`;
    else day = zh ? "涨跌互现" : "Mixed";
    parts.push(zh ? `${day}，${lead.name} ${sign(lead.pct)}` : `${day}; ${lead.name} ${sign(lead.pct)}`);
    if (Number.isFinite(lead.chg1y)) {
      let tail = zh ? `近一年 ${sign(lead.chg1y, 1)}` : `${sign(lead.chg1y, 1)} over a year`;
      if (Number.isFinite(lead.fromHigh)) {
        if (lead.fromHigh > -2) tail += zh ? "，贴近一年高点" : ", near its 1-year high";
        else if (lead.fromHigh <= -20) tail += zh ? `，较一年高点回撤 ${Math.abs(lead.fromHigh).toFixed(0)}%` : `, ${Math.abs(lead.fromHigh).toFixed(0)}% off its 1-year high`;
      }
      parts.push(tail);
    }
  }
  if (m && Number.isFinite(m.level) && m.zoneName) parts.push(zh ? `估值水位 ${m.level} 分位（${m.zoneName}）` : `valuation P${m.level} (${m.zoneName})`);
  if (!parts.length) return "";
  return zh ? parts.join("；") + "。" : parts.join("; ").replace(/^./, (c) => c.toUpperCase()) + ".";
}

// ---------- 迷你走势线 ----------
// 数值序列 → SVG path（viewBox 0 0 w h，上下留 pad）；少于 2 个有效点返回 ""
export function sparkPath(values, w = 100, h = 28, pad = 2) {
  const v = (values || []).filter(Number.isFinite);
  if (v.length < 2) return "";
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  return v.map((y, i) => `${i ? "L" : "M"}${(i / (v.length - 1) * w).toFixed(1)},${(pad + (hi - y) / span * (h - pad * 2)).toFixed(1)}`).join("");
}
