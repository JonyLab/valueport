// 纯逻辑：无 DOM 依赖，可在 node 下单测。
export const ZONES = [
  { key: "deep",  en: "Deep value",  hex: "#2ea35d" },
  { key: "under", en: "Undervalued", hex: "#3a73ee" },
  { key: "fair",  en: "Fair value",  hex: "#555e6b" },
  { key: "over",  en: "Overvalued",  hex: "#e23c3c" },
  { key: "xover", en: "Extreme",     hex: "#a31515" },
];
export const N = ZONES.length;
export const SEG = 180 / N;
export const PHI_MAX = 179;

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

export function structValid(c) {
  return c.fairLow > 0 && c.fairHigh > c.fairLow && c.mos > 0 && c.mos < 100 && c.ext > 0;
}

export function verdictOf(cfg) {
  if (!cfg.symbol) return { cls: "v-fair", text: "未选择标的", px: "现价 —" };
  if (!(cfg.price > 0)) return { cls: "v-fair", text: "等待报价…", px: "现价 —" };
  if (!(cfg.fairLow > 0) || !(cfg.fairHigh > cfg.fairLow))
    return { cls: "v-fair", text: "—", px: `现价 ${cfg.price}` };
  if (cfg.price < cfg.fairLow) {
    const pct = (cfg.fairLow - cfg.price) / cfg.fairLow * 100;
    return { cls: "v-under", text: `安全边际 ${pct.toFixed(0)}%`, px: `现价 ${cfg.price}` };
  }
  if (cfg.price > cfg.fairHigh) {
    const pct = (cfg.price - cfg.fairHigh) / cfg.fairHigh * 100;
    return { cls: "v-over", text: `高估 ${pct.toFixed(0)}%`, px: `现价 ${cfg.price}` };
  }
  return { cls: "v-fair", text: "合理区间内", px: `现价 ${cfg.price}` };
}
