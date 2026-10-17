// 纯逻辑：无 DOM 依赖，可在 node 下单测。
export const ZONES = [
  { key: "deep",  en: "Strike zone", hex: "#2ea35d" },
  { key: "under", en: "Undervalued", hex: "#3a73ee" },
  { key: "fair",  en: "Fair value",  hex: "#555e6b" },
  { key: "over",  en: "Overvalued",  hex: "#f08c2e" },
  { key: "xover", en: "Bubble",      hex: "#e23c3c" },
];
export const N = ZONES.length;
export const SEG = 180 / N;
export const PHI_MAX = 179;

// 区间默认配色（用于「恢复默认」与色块配置 UI 的初始值）。
export const DEFAULT_ZONE_COLORS = Object.fromEntries(ZONES.map((z) => [z.key, z.hex]));

// 用 {zoneKey: "#rrggbb"} 覆盖区间高亮色；未提供的键回退到默认色。
export function applyZoneColors(map) {
  for (const z of ZONES) z.hex = (map && map[z.key]) || DEFAULT_ZONE_COLORS[z.key];
}

// cfg: { fairLow, fairHigh, mos, ext } -> [0, t1, t2, t3, t4, Infinity]
export function computeAnchors(cfg) {
  const t2 = cfg.fairLow, t3 = cfg.fairHigh;
  const t1 = t2 * (1 - cfg.mos / 100);
  const t4 = t3 * (1 + cfg.ext / 100);
  return [0, t1, t2, t3, t4, Infinity];
}

export function priceToPhi(anchors, p) {
  const [, t1, t2, t3, t4] = anchors;
  if (!(p > 0)) return 0;
  if (p <= t1) return SEG * (p / t1);
  if (p <= t2) return SEG + SEG * (p - t1) / (t2 - t1);
  if (p <= t3) return SEG * 2 + SEG * (p - t2) / (t3 - t2);
  if (p <= t4) return SEG * 3 + SEG * (p - t3) / (t4 - t3);
  return Math.min(PHI_MAX, SEG * 4 + SEG * (1 - t4 / p));
}

// 是否已设定内在价值区间（低<高）。未设定时钟摆改为占位态。
export function hasFairRange(c) {
  return c.fairLow > 0 && c.fairHigh > c.fairLow;
}

export function structValid(c) {
  return hasFairRange(c) && c.mos > 0 && c.mos < 100 && c.ext > 0;
}

// 默认中文文案；页面可传入 msgs 做多语言（见 shared/i18n.js）。
export const VERDICT_MSGS_ZH = {
  px: (p) => `现价 ${p}`,
  pxNone: "现价 —",
  noSymbol: "未选择标的",
  waiting: "等待报价…",
  under: (pct) => `安全边际 ${pct}%`,
  over: (pct) => `高估 ${pct}%`,
  fair: "合理区间内",
};

export function verdictOf(cfg, msgs = VERDICT_MSGS_ZH) {
  if (!cfg.symbol) return { cls: "v-fair", text: msgs.noSymbol, px: msgs.pxNone };
  if (!(cfg.price > 0)) return { cls: "v-fair", text: msgs.waiting, px: msgs.pxNone };
  if (!(cfg.fairLow > 0) || !(cfg.fairHigh > cfg.fairLow))
    return { cls: "v-fair", text: "—", px: msgs.px(cfg.price) };
  if (cfg.price < cfg.fairLow) {
    const pct = (cfg.fairLow - cfg.price) / cfg.fairLow * 100;
    return { cls: "v-under", text: msgs.under(pct.toFixed(0)), px: msgs.px(cfg.price) };
  }
  if (cfg.price > cfg.fairHigh) {
    const pct = (cfg.price - cfg.fairHigh) / cfg.fairHigh * 100;
    return { cls: "v-over", text: msgs.over(pct.toFixed(0)), px: msgs.px(cfg.price) };
  }
  return { cls: "v-fair", text: msgs.fair, px: msgs.px(cfg.price) };
}
