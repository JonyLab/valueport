// 纯逻辑模块（无 DOM 依赖，Node 单测与浏览器共用）：
// 1. 资产大类（分组桶）两层配置汇总与 5/25 偏离判定
// 2. 指标条件提醒（如「股债性价比到达历史 95% 或 5% 分位 → 触发提醒并可选推荐切换配置方案」）
// 3. 再平衡工作台：标准买卖再平衡 + 仅用新增现金流补低配（不卖出）+ 估值护栏开关
// 4. 定期再平衡复盘日程状态
// 5. 资产曲线保守风控指标（最大回撤、当前回撤、年化波动率）

import { driftTolerance, driftStatus, driftAction } from "./holding.js";

export const SCHEDULE_FREQS = ["none", "monthly", "quarterly", "semiannual", "annual"];

export const BUCKET_PRESETS = {
  balanced: {
    zh: "经典股债平衡 (50/35/10/5)",
    en: "Classic Balanced (50/35/10/5)",
    buckets: [
      { id: "equity", nameZh: "权益", nameEn: "Equities", target: 50 },
      { id: "bond", nameZh: "债券 / 固收", nameEn: "Bonds", target: 35 },
      { id: "commodity", nameZh: "商品 / 黄金", nameEn: "Commodities", target: 10 },
      { id: "cash", nameZh: "现金", nameEn: "Cash", target: 5, isCash: true },
    ],
  },
  allweather: {
    zh: "保守全天候 (30/45/15/10)",
    en: "Conservative All-Weather (30/45/15/10)",
    buckets: [
      { id: "equity", nameZh: "权益", nameEn: "Equities", target: 30 },
      { id: "bond", nameZh: "债券 / 固收", nameEn: "Bonds", target: 45 },
      { id: "commodity", nameZh: "商品 / 黄金", nameEn: "Commodities", target: 15 },
      { id: "cash", nameZh: "现金", nameEn: "Cash", target: 10, isCash: true },
    ],
  },
  core: {
    zh: "权益为主 + 现金缓冲 (70/20/10)",
    en: "Core Equity + Buffer (70/20/10)",
    buckets: [
      { id: "core", nameZh: "核心权益", nameEn: "Core Equity", target: 70 },
      { id: "defensive", nameZh: "红利 / 防御", nameEn: "Defensive / Income", target: 20 },
      { id: "cash", nameZh: "现金", nameEn: "Cash", target: 10, isCash: true },
    ],
  },
};

export function presetBuckets(key, lang = "zh") {
  const p = BUCKET_PRESETS[key];
  if (!p) return [];
  const zh = lang !== "en";
  return p.buckets.map((b) => ({
    id: b.id,
    name: zh ? b.nameZh : b.nameEn,
    target: b.target,
    ...(b.isCash ? { isCash: true } : {}),
  }));
}

// ---------- 指标条件提醒定义（对接 /api/macro 已有数据） ----------
// modes: ["pct", "value"] 表示既支持按历史分位（0-100%）触发，也支持按具体数值触发
export const ALERT_METRICS = [
  { key: "cn_erp",     zh: "A 股 · 股债性价比 (ERP)",  en: "China A · Equity-Bond Spread",   modes: ["pct", "value"], unit: "pp", market: "cn", ind: "cn_erp" },
  { key: "us_erp",     zh: "美股 · 股债性价比 (ERP)",   en: "US · Equity-Bond Spread",        modes: ["pct", "value"], unit: "pp", market: "us", ind: "us_erp" },
  { key: "hk_erp",     zh: "港股 · 股债性价比 (ERP)",   en: "HK · Equity-Bond Spread",        modes: ["pct", "value"], unit: "pp", market: "hk", ind: "hk_erp" },
  { key: "cn_level",   zh: "A 股 · 综合估值水位",       en: "China A · Valuation Level",      modes: ["pct"],          unit: "%",  market: "cn", level: true },
  { key: "us_level",   zh: "美股 · 综合估值水位",       en: "US · Valuation Level",           modes: ["pct"],          unit: "%",  market: "us", level: true },
  { key: "hk_level",   zh: "港股 · 综合估值水位",       en: "HK · Valuation Level",           modes: ["pct"],          unit: "%",  market: "hk", level: true },
  { key: "cn_pe",      zh: "A 股 · 全 A 市盈率",        en: "China A · Market P/E",           modes: ["pct", "value"], unit: "x",  market: "cn", ind: "cn_pe" },
  { key: "hk_pe",      zh: "港股 · 恒指市盈率",         en: "HK · Hang Seng P/E",             modes: ["pct", "value"], unit: "x",  market: "hk", ind: "hk_pe" },
  { key: "cape",       zh: "美股 · 席勒市盈率 (CAPE)",  en: "US · Shiller CAPE",              modes: ["pct", "value"], unit: "x",  market: "us", ind: "cape" },
  { key: "buffett",    zh: "美股 · 总市值 / GDP",       en: "US · Market Cap / GDP",          modes: ["pct", "value"], unit: "%",  market: "us", ind: "buffett" },
  { key: "cn10y",      zh: "中国 10 年国债收益率",      en: "China 10Y Treasury Yield",       modes: ["value"],        unit: "%",  rate: "cn10y" },
  { key: "us10y",      zh: "美国 10 年国债收益率",      en: "US 10Y Treasury Yield",          modes: ["value"],        unit: "%",  rate: "us10y" },
  { key: "us_real10y", zh: "美国 10 年实际利率",        en: "US 10Y Real Yield",              modes: ["value"],        unit: "%",  rate: "us_real10y" },
];
export const ALERT_METRIC_KEYS = ALERT_METRICS.map((m) => m.key);
export const alertMetricMeta = (key) => ALERT_METRICS.find((m) => m.key === key) || null;

export const ALERT_TEMPLATE_GROUPS = [
  { key: "featured", zh: "精选", en: "Popular" },
  { key: "cn",       zh: "A 股", en: "China A" },
  { key: "hk",       zh: "港股", en: "Hong Kong" },
  { key: "us",       zh: "美股", en: "US" },
  { key: "rates",    zh: "国债利率", en: "Bond yields" },
  { key: "all",      zh: "全部", en: "All" },
];

export const ALERT_TEMPLATES = [
  // ---- A 股 ----
  {
    key: "cn_erp_high", group: "cn", featured: true,
    zh: "A 股股债性价比 ≥ 历史 90%（股票极便宜）",
    en: "China A ERP ≥ 90th pct (equities very cheap)",
    metric: "cn_erp", mode: "pct", op: "gte", threshold: 90,
    noteZh: "A 股相对国债性价比进入历史高位，可考虑逐步增配权益",
    noteEn: "China A equity-bond spread is near historical highs — consider adding equities",
  },
  {
    key: "cn_erp_low", group: "cn", featured: true,
    zh: "A 股股债性价比 ≤ 历史 10%（股票偏贵）",
    en: "China A ERP ≤ 10th pct (equities expensive)",
    metric: "cn_erp", mode: "pct", op: "lte", threshold: 10,
    noteZh: "A 股相对国债性价比偏薄，可考虑把超配权益挪向债券或现金",
    noteEn: "China A equity-bond spread is historically thin — consider shifting toward bonds/cash",
  },
  {
    key: "cn_level_low", group: "cn",
    zh: "A 股综合水位 ≤ 15%（低估击球区）",
    en: "China A level ≤ 15th pct (strike zone)",
    metric: "cn_level", mode: "pct", op: "lte", threshold: 15,
    noteZh: "A 股综合估值水位落入历史低位，适合加大定投或向权益再平衡",
    noteEn: "China A composite valuation is in historical low zone — good window to add equities",
  },
  {
    key: "cn_pe_low", group: "cn",
    zh: "全 A 市盈率 ≤ 历史 15%（估值便宜）",
    en: "China A P/E ≤ 15th pct (cheap)",
    metric: "cn_pe", mode: "pct", op: "lte", threshold: 15,
    noteZh: "全 A 市盈率处于历史低分位，中长期赔率偏有利",
    noteEn: "China A market P/E is near historical lows — favorable long-term odds",
  },
  // ---- 港股 ----
  {
    key: "hk_erp_high", group: "hk", featured: true,
    zh: "港股股债性价比 ≥ 历史 90%（高赔率区）",
    en: "HK ERP ≥ 90th pct (high reward)",
    metric: "hk_erp", mode: "pct", op: "gte", threshold: 90,
    noteZh: "港股相对无风险利率风险溢价极高，留意高股息与核心宽基机会",
    noteEn: "HK equity risk premium is near historical highs — watch high-dividend & index opportunities",
  },
  {
    key: "hk_erp_low", group: "hk",
    zh: "港股股债性价比 ≤ 历史 10%（性价比偏薄）",
    en: "HK ERP ≤ 10th pct (thin spread)",
    metric: "hk_erp", mode: "pct", op: "lte", threshold: 10,
    noteZh: "港股相对美债性价比收窄，注意控制仓位上限、逢高再平衡",
    noteEn: "HK equity-bond spread has narrowed — review equity cap and rebalance",
  },
  {
    key: "hk_pe_low", group: "hk",
    zh: "恒指市盈率 ≤ 9x（历史深谷）",
    en: "Hang Seng P/E ≤ 9x (deep value)",
    metric: "hk_pe", mode: "value", op: "lte", threshold: 9,
    noteZh: "恒生指数市盈率跌破 9 倍，处于长期深度价值区间",
    noteEn: "Hang Seng P/E is below 9x — deep historical value territory",
  },
  {
    key: "hk_level_low", group: "hk",
    zh: "港股综合水位 ≤ 15%（低估区）",
    en: "HK level ≤ 15th pct (undervalued)",
    metric: "hk_level", mode: "pct", op: "lte", threshold: 15,
    noteZh: "港股综合估值处于历史低位，适合分批补齐港股配置权重",
    noteEn: "Hong Kong composite valuation is historically low — consider topping up HK allocation",
  },
  // ---- 美股 ----
  {
    key: "us_erp_high", group: "us",
    zh: "美股股债性价比 ≥ 历史 85%（难得便宜）",
    en: "US ERP ≥ 85th pct (rarely cheap)",
    metric: "us_erp", mode: "pct", op: "gte", threshold: 85,
    noteZh: "美股相对实际利率性价比罕见走高，可逐步增加美股宽基权重",
    noteEn: "US equity risk premium is unusually attractive — consider adding US equities",
  },
  {
    key: "us_erp_low", group: "us", featured: true,
    zh: "美股股债性价比 ≤ 历史 5%（美股偏贵）",
    en: "US ERP ≤ 5th pct (US equities expensive)",
    metric: "us_erp", mode: "pct", op: "lte", threshold: 5,
    noteZh: "美股相对美债风险溢价极薄，可考虑偏向美债或现金防守",
    noteEn: "US equity risk premium is historically thin — consider tilting to bonds/cash",
  },
  {
    key: "us_cape_high", group: "us",
    zh: "美股席勒 PE ≥ 35x（长期估值偏高）",
    en: "US Shiller CAPE ≥ 35x (richly valued)",
    metric: "cape", mode: "value", op: "gte", threshold: 35,
    noteZh: "美股席勒周期调整市盈率突破 35 倍，未来十年预期回报收窄，宜控回撤",
    noteEn: "US Shiller CAPE topped 35x — long-term forward returns tighten, stay disciplined",
  },
  {
    key: "us_buffett_high", group: "us",
    zh: "美股总市值 / GDP ≥ 历史 95%（巴菲特指标极高）",
    en: "US Mkt Cap / GDP ≥ 95th pct (Buffett extreme)",
    metric: "buffett", mode: "pct", op: "gte", threshold: 95,
    noteZh: "美股总市值相对 GDP 处于历史极端高位，注意严守股债再平衡纪律",
    noteEn: "US Market Cap / GDP is at historical extremes — stick strictly to rebalancing bands",
  },
  // ---- 国债利率 ----
  {
    key: "cn10y_low", group: "rates", featured: true,
    zh: "中国 10 年国债 ≤ 1.8%（长债利率低位）",
    en: "China 10Y yield ≤ 1.8% (low rates)",
    metric: "cn10y", mode: "value", op: "lte", threshold: 1.8,
    noteZh: "国债利率处于低位，留意长债久期风险与高股息资产性价比",
    noteEn: "China 10Y yield is low — watch long-duration bond risk and income equity value",
  },
  {
    key: "cn10y_high", group: "rates",
    zh: "中国 10 年国债 ≥ 3.0%（中债配置窗口）",
    en: "China 10Y yield ≥ 3.0% (attractive yield)",
    metric: "cn10y", mode: "value", op: "gte", threshold: 3.0,
    noteZh: "中债无风险票息回到较厚区间，可适度拉长久期锁定收益",
    noteEn: "China 10Y yield is attractive again — consider locking in duration",
  },
  {
    key: "us10y_high", group: "rates", featured: true,
    zh: "美国 10 年国债 ≥ 4.5%（美债高息锁利）",
    en: "US 10Y yield ≥ 4.5% (high Treasury yield)",
    metric: "us10y", mode: "value", op: "gte", threshold: 4.5,
    noteZh: "美债票息处于近十余年高位，可作为稳健仓位的优质压舱石",
    noteEn: "US 10Y Treasury yield is near multi-year highs — strong defensive ballast",
  },
  {
    key: "us_real10y_high", group: "rates",
    zh: "美国 10 年实际利率 ≥ 2.0%（TIPS / 长债吸引）",
    en: "US 10Y real yield ≥ 2.0% (TIPS attractive)",
    metric: "us_real10y", mode: "value", op: "gte", threshold: 2.0,
    noteZh: "扣除通胀后的美债实际回报 ≥ 2%，对保守型配置非常有吸引力",
    noteEn: "Inflation-adjusted US 10Y real yield ≥ 2% — compelling for conservative portfolios",
  },
];

export function createAlertFromTemplate(key, lang = "zh") {
  const t = ALERT_TEMPLATES.find((x) => x.key === key);
  if (!t) return null;
  return {
    id: "a_" + Math.random().toString(36).slice(2, 8),
    enabled: true,
    metric: t.metric,
    mode: t.mode,
    op: t.op,
    threshold: t.threshold,
    note: lang === "en" ? t.noteEn : t.noteZh,
  };
}

// 从 /api/macro 读取某个指标的实时值与真实历史分位（0-100，不做取反）
export function readMacroMetric(macro, metricKey) {
  const meta = alertMetricMeta(metricKey);
  if (!meta || !macro) return { available: false, pct: null, value: null, unit: meta?.unit || "", date: "" };
  if (meta.rate) {
    const r = (Array.isArray(macro.rates) ? macro.rates : []).find((x) => x && x.key === meta.rate);
    if (!r || !Number.isFinite(r.value)) return { available: false, pct: null, value: null, unit: meta.unit, date: "" };
    return { available: true, pct: null, value: r.value, unit: meta.unit, date: r.date || "" };
  }
  const m = (Array.isArray(macro.markets) ? macro.markets : []).find((x) => x && x.key === meta.market && !x.pending);
  if (!m) return { available: false, pct: null, value: null, unit: meta.unit, date: "" };
  if (meta.level) {
    if (!Number.isFinite(m.level)) return { available: false, pct: null, value: null, unit: "%", date: "" };
    return { available: true, pct: m.level, value: m.level, unit: "%", date: "" };
  }
  const ind = (Array.isArray(m.indicators) ? m.indicators : []).find((x) => x && x.key === meta.ind);
  if (!ind || !Number.isFinite(ind.value)) return { available: false, pct: null, value: null, unit: meta.unit, date: "" };
  return {
    available: true,
    pct: Number.isFinite(ind.pct) ? ind.pct : null,
    value: ind.value,
    unit: ind.unit || meta.unit,
    date: ind.date || "",
    since: ind.since || "",
  };
}

export function evaluateSignalAlerts(alerts = [], macro = null, profiles = []) {
  const list = Array.isArray(alerts) ? alerts : [];
  const profMap = new Map((Array.isArray(profiles) ? profiles : []).map((p) => [p.id, p]));
  const items = list.map((a) => {
    const meta = alertMetricMeta(a.metric);
    const reading = readMacroMetric(macro, a.metric);
    const actual = a.mode === "pct" ? reading.pct : reading.value;
    const available = reading.available && Number.isFinite(actual);
    const triggered = a.enabled !== false && available && (a.op === "gte" ? actual >= a.threshold : actual <= a.threshold);
    const suggestProfile = a.suggestProfileId ? (profMap.get(a.suggestProfileId) || null) : null;
    return {
      ...a,
      meta,
      reading,
      actual,
      available,
      triggered,
      suggestProfile,
    };
  });
  return {
    items,
    triggered: items.filter((x) => x.triggered),
  };
}

// 为指标提醒提取历史月度序列与阈值线（供前端画走势小图 + 阈值虚线 + 触发阴影区）
export function extractAlertSeries(macro, metricKey, mode, threshold, maxPoints = 60) {
  const meta = alertMetricMeta(metricKey);
  if (!meta || !macro) return null;
  const g = macro.gravity || {};
  const pairDiff = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b)) return [];
    const mb = new Map(b.map(([d, v]) => [d, v]));
    const out = [];
    for (const [d, v] of a) {
      const y = mb.get(d);
      if (Number.isFinite(v) && Number.isFinite(y)) out.push([d, Math.round((v - y) * 100) / 100]);
    }
    return out;
  };
  const invEy = (arr) => (Array.isArray(arr) ? arr.filter(([, v]) => Number.isFinite(v) && v > 0).map(([d, v]) => [d, Math.round(100 / v * 10) / 10]) : []);

  let all = [];
  if (metricKey === "cn10y") all = Array.isArray(g.cn?.y10) ? g.cn.y10 : [];
  else if (metricKey === "us10y") all = Array.isArray(g.us?.y10) ? g.us.y10 : [];
  else if (metricKey === "us_real10y") all = Array.isArray(g.us?.real) ? g.us.real : [];
  else if (metricKey === "cn_erp") all = pairDiff(g.cn?.ey, g.cn?.y10);
  else if (metricKey === "hk_erp") all = pairDiff(g.hk?.ey, g.hk?.y10);
  else if (metricKey === "us_erp") all = pairDiff(g.us?.ey, g.us?.real);
  else if (metricKey === "cn_pe") all = invEy(g.cn?.ey);
  else if (metricKey === "hk_pe") all = invEy(g.hk?.ey);
  else if (metricKey === "cape") all = invEy(g.us?.ey);

  // 兜底：若 gravity 没带该利率，用 rates[].spark（近 36 个月无日期点）
  if (!all.length && meta.rate && Array.isArray(macro.rates)) {
    const r = macro.rates.find((x) => x && x.key === meta.rate);
    if (r && Array.isArray(r.spark) && r.spark.length >= 2) {
      all = r.spark.map((v, i) => [String(i), v]);
    }
  }
  all = all.filter((p) => Array.isArray(p) && Number.isFinite(p[1]));
  if (all.length < 2) return null;

  const recent = all.length > maxPoints ? all.slice(-maxPoints) : all;
  let thresholdVal = null;
  if (Number.isFinite(threshold)) {
    if (mode === "value") {
      thresholdVal = threshold;
    } else if (mode === "pct") {
      const sorted = all.map((p) => p[1]).sort((a, b) => a - b);
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * Math.max(0, Math.min(100, threshold)) / 100)));
      thresholdVal = sorted[idx];
    }
  }
  const vals = recent.map((p) => p[1]);
  const lo = Math.min(...vals, ...(Number.isFinite(thresholdVal) ? [thresholdVal] : []));
  const hi = Math.max(...vals, ...(Number.isFinite(thresholdVal) ? [thresholdVal] : []));
  const firstD = /^\d{4}-\d{2}/.test(recent[0][0]) ? recent[0][0] : "";
  const lastD = /^\d{4}-\d{2}/.test(recent[recent.length - 1][0]) ? recent[recent.length - 1][0] : "";
  return {
    points: recent,
    thresholdVal,
    min: lo,
    max: hi,
    current: recent[recent.length - 1][1],
    unit: meta.unit || "",
    fromDate: firstD,
    toDate: lastD,
  };
}

export function isAllocOnly(plan, symbol) {
  return Array.isArray(plan?.allocOnly) && plan.allocOnly.includes(symbol);
}

// 系统能判断的，不留给用户：根据常见 ETF 代码与名称自动推断「是否配置型」与「默认归属大类」
const EQUITY_ETF_RE = /^(us(VOO|SPY|IVV|VTI|QQQ|QQQM|VT|VXUS|SCHD|VYM|VIG|DIA|IWM|VEA|VWO)|hk(02800|02828|03033|03067|03110)|sh(510300|510500|510050|510880|512890|513100|513500|588000)|sz(159915|159919|159949|159901))$/i;
const BOND_ETF_RE = /^(us(TLT|IEF|IEI|SHY|SGOV|BIL|BND|AGG|BNDX|LQD|TIP|VGIT|VGLT|VCIT)|sh(511010|511020|511030|511090|511260|511360|511380)|sz(159972))$/i;
const COMMODITY_ETF_RE = /^(us(GLD|GLDM|IAU|SLV|DBC|PDBC|USO)|sh(518880|518800)|sz(159934|159937))$/i;

export function inferAssetDefaults(symbol, name = "", buckets = []) {
  const s = String(symbol || "").trim();
  const n = String(name || "");
  let kind = null; // "equity" | "bond" | "commodity"
  if (BOND_ETF_RE.test(s) || /(国债|政金债|美债|债[券基]|Treasury|Bond|TIPS)/i.test(n)) kind = "bond";
  else if (COMMODITY_ETF_RE.test(s) || /(黄金|白银|商品|Gold|Silver|Commodity)/i.test(n)) kind = "commodity";
  else if (EQUITY_ETF_RE.test(s) || /(ETF|指数|标普|纳斯达克|沪深300|中证|红利|S&P|Nasdaq|Index)/i.test(n)) kind = "equity";

  const allocOnly = kind !== null;
  const nonCash = (Array.isArray(buckets) ? buckets : []).filter((b) => !b.isCash);
  let bucketId = "";
  const pickBucket = (idHints, nameRe) => {
    for (const h of idHints) { const hit = nonCash.find((b) => b.id === h); if (hit) return hit.id; }
    const hit = nonCash.find((b) => nameRe.test(b.name || ""));
    return hit ? hit.id : "";
  };
  if (kind === "bond") bucketId = pickBucket(["bond", "defensive"], /(债|固收|bond|fixed|income)/i);
  else if (kind === "commodity") bucketId = pickBucket(["commodity", "gold"], /(商品|黄金|大宗|commodity|gold)/i);
  else if (kind === "equity") bucketId = pickBucket(["equity", "core"], /(权益|股票|股|equit|stock|core)/i);
  else if (s) bucketId = pickBucket(["equity", "core"], /(权益|股票|股|equit|stock|core)/i); // 普通个股默认归入权益类

  return { kind, allocOnly, bucketId };
}

// 根据不同指标给出符合直觉的快捷阈值建议（系统帮用户选好最常用的极值）
export function metricQuickPresets(metricKey, lang = "zh") {
  const zh = lang !== "en", T = (a, b) => (zh ? a : b);
  const meta = alertMetricMeta(metricKey);
  if (!meta) return [];
  if (meta.rate) {
    if (metricKey === "cn10y") return [
      { label: T("利率低位 ≤1.8%", "Low ≤1.8%"), mode: "value", op: "lte", threshold: 1.8, note: T("国债利率处于低位，留意长债久期风险与高股息机会", "China 10Y yield is low — watch bond duration and dividend equities") },
      { label: T("利率回升 ≥2.5%", "Higher ≥2.5%"), mode: "value", op: "gte", threshold: 2.5, note: T("国债利率回升至相对高位，固收配置性价比提升", "China 10Y yield rose — bonds look more attractive") },
    ];
    if (metricKey === "us_real10y") return [
      { label: T("实际利率高 ≥2.0%", "High ≥2.0%"), mode: "value", op: "gte", threshold: 2.0, note: T("美债实际利率偏高，长债与无风险收益更有吸引力", "High US real yield favors bonds over gold/growth") },
      { label: T("实际利率低 ≤0.5%", "Low ≤0.5%"), mode: "value", op: "lte", threshold: 0.5, note: T("实际利率偏低，黄金与实物资产防御价值提升", "Low real yield improves gold/real asset appeal") },
    ];
    return [
      { label: T("高利率 ≥4.5%", "High ≥4.5%"), mode: "value", op: "gte", threshold: 4.5, note: T("美债 10 年利率较高，债券票息性价比突出", "US 10Y yield is high — attractive bond carry") },
      { label: T("低利率 ≤3.0%", "Low ≤3.0%"), mode: "value", op: "lte", threshold: 3.0, note: T("美债利率回落至低位，关注权益资产弹性", "US 10Y yield is low — check equity opportunities") },
    ];
  }
  if (/_erp$/.test(metricKey)) return [
    { label: T("股票极便宜 ≥95%分位", "Very cheap ≥95%"), mode: "pct", op: "gte", threshold: 95, note: T("股债性价比进入历史极高区，可考虑增配权益", "Equity-bond spread near historical high — consider adding equities") },
    { label: T("股票便宜 ≥90%分位", "Cheap ≥90%"), mode: "pct", op: "gte", threshold: 90, note: T("股债性价比偏高，适合逢低补仓权益", "Attractive equity-bond spread — good time to add equities") },
    { label: T("股票偏贵 ≤5%分位", "Expensive ≤5%"), mode: "pct", op: "lte", threshold: 5, note: T("股债性价比跌入历史极低区，可考虑转向债券/现金防守", "Thin equity-bond spread — consider tilting toward bonds/cash") },
  ];
  return [
    { label: T("历史极贵 ≥95%分位", "Extreme high ≥95%"), mode: "pct", op: "gte", threshold: 95, note: T("估值处于历史高位区间，留意风险并控制权益仓位", "Valuation near historical highs — consider trimming risk") },
    { label: T("历史偏贵 ≥85%分位", "High ≥85%"), mode: "pct", op: "gte", threshold: 85, note: T("估值偏高，不急着追买，留好现金缓冲", "Elevated valuation — keep cash buffer") },
    { label: T("历史极便宜 ≤10%分位", "Cheap ≤10%"), mode: "pct", op: "lte", threshold: 10, note: T("估值进入历史低位击球区，可分批增配权益", "Historically cheap valuation — consider adding equities") },
  ];
}

export function effectiveCashTarget(plan) {
  if (!plan) return null;
  if (Number.isFinite(plan.cash)) return plan.cash;
  const cb = Array.isArray(plan.buckets) ? plan.buckets.find((b) => b.isCash && Number.isFinite(b.target) && b.target > 0) : null;
  return cb ? cb.target : null;
}

// 解析当前采用的各桶目标（基准目标 or 选中的情景配置方案）
export function resolveBucketTargets({ buckets = [], plan = {}, profileId = undefined } = {}) {
  const bList = Array.isArray(buckets) ? buckets : [];
  const profiles = Array.isArray(plan?.profiles) ? plan.profiles : [];
  const pid = profileId === undefined ? (plan?.activeProfileId || null) : profileId;
  const activeProfile = pid ? (profiles.find((p) => p.id === pid) || null) : null;
  const baseTargets = {};
  const effectiveTargets = {};
  for (const b of bList) {
    const base = Number.isFinite(b.target) && b.target > 0 ? b.target : 0;
    const profVal = activeProfile && activeProfile.targets && Number.isFinite(activeProfile.targets[b.id]) ? activeProfile.targets[b.id] : null;
    baseTargets[b.id] = base;
    effectiveTargets[b.id] = profVal !== null ? profVal : base;
  }
  return { baseTargets, effectiveTargets, activeProfile };
}

// ---------- 1. 资产大类（分组桶）汇总 ----------
export function computeBucketSummary({ rows = [], cashValue = 0, total = 0, plan = {}, items = new Map(), profileId = undefined }) {
  const buckets = Array.isArray(plan.buckets) ? plan.buckets : [];
  if (!buckets.length) return { active: false, hasTargets: false, buckets: [], unclassified: null, allocated: 0, offCount: 0, activeProfile: null };

  const resolved = resolveBucketTargets({ buckets, plan, profileId });
  const assetClass = plan.assetClass || {};
  const targets = plan.targets || {};
  const tolPlan = { band: plan.band ?? 5, rel: plan.rel ?? 25 };
  const byId = new Map(buckets.map((b) => {
    const eff = resolved.effectiveTargets[b.id];
    const base = resolved.baseTargets[b.id];
    return [b.id, {
      id: b.id,
      name: b.name,
      isCash: !!b.isCash,
      baseTgt: base > 0 ? base : null,
      tgt: eff > 0 ? eff : null,
      value: 0,
      members: [],
      subTargetSum: 0,
    }];
  }));

  const heldSet = new Set();
  const unclassified = { id: "__unclassified__", name: "", isCash: false, baseTgt: null, tgt: null, value: 0, members: [], subTargetSum: 0 };

  for (const r of rows) {
    heldSet.add(r.symbol);
    const val = Number.isFinite(r.value) && r.value > 0 ? r.value : 0;
    const bid = assetClass[r.symbol];
    const bucket = bid && byId.has(bid) && !byId.get(bid).isCash ? byId.get(bid) : unclassified;
    bucket.value += val;
    const symTgt = Number.isFinite(targets[r.symbol]) && targets[r.symbol] > 0 ? targets[r.symbol] : null;
    if (symTgt) bucket.subTargetSum += symTgt;
    bucket.members.push({
      symbol: r.symbol,
      name: r.boardName || r.name || r.symbol.slice(2).toUpperCase(),
      value: val,
      cur: total > 0 ? val / total * 100 : 0,
      tgt: symTgt,
      zone: r.zone ?? -1,
      allocOnly: isAllocOnly(plan, r.symbol),
      held: true,
    });
  }

  for (const sym of new Set([...Object.keys(assetClass), ...Object.keys(targets)])) {
    if (heldSet.has(sym)) continue;
    const bid = assetClass[sym];
    const symTgt = Number.isFinite(targets[sym]) && targets[sym] > 0 ? targets[sym] : null;
    if (!bid && !symTgt) continue;
    const bucket = bid && byId.has(bid) && !byId.get(bid).isCash ? byId.get(bid) : null;
    if (!bucket) continue;
    if (symTgt) bucket.subTargetSum += symTgt;
    const it = items instanceof Map ? items.get(sym) : items?.[sym];
    bucket.members.push({
      symbol: sym,
      name: (it && (it.name || it.ticker)) || sym.slice(2).toUpperCase(),
      value: 0,
      cur: 0,
      tgt: symTgt,
      zone: -1,
      allocOnly: isAllocOnly(plan, sym),
      held: false,
    });
  }

  const cashBucket = [...byId.values()].find((b) => b.isCash);
  if (cashBucket) {
    cashBucket.value += Number.isFinite(cashValue) ? cashValue : 0;
    if (cashBucket.tgt === null && Number.isFinite(plan.cash) && plan.cash > 0) cashBucket.tgt = plan.cash;
  } else if (cashValue > 0) {
    unclassified.value += cashValue;
  }

  const out = [...byId.values()].map((b) => {
    const cur = total > 0 ? b.value / total * 100 : 0;
    const hasTgt = Number.isFinite(b.tgt) && b.tgt > 0;
    const tol = hasTgt ? driftTolerance(b.tgt, tolPlan) : null;
    const drift = hasTgt ? cur - b.tgt : null;
    const status = !hasTgt ? "none" : (drift > tol ? "over" : drift < -tol ? "under" : "ok");
    const trade = hasTgt ? (b.tgt - cur) / 100 * total : 0;
    b.members.sort((x, y) => y.value - x.value);
    return { ...b, cur, tol, drift, status, trade };
  });

  const allocated = out.reduce((s, b) => s + (b.tgt || 0), 0);
  const hasTargets = allocated > 0;
  const offCount = out.filter((b) => b.status === "over" || b.status === "under").length;
  const unclassOut = unclassified.value > 0 || unclassified.members.length > 0
    ? { ...unclassified, cur: total > 0 ? unclassified.value / total * 100 : 0, status: "none", tol: null, drift: null, trade: 0 }
    : null;

  return { active: true, hasTargets, buckets: out, unclassified: unclassOut, allocated, offCount, activeProfile: resolved.activeProfile };
}

// ---------- 2. 再平衡引擎（标准买卖 & 仅用新增现金流） ----------
export function computeRebalancePlan({
  rows = [],
  cashValue = 0,
  total = 0,
  plan = {},
  items = new Map(),
  quotes = {},
  conv = (v) => v,
  profileId = undefined,
  scope = "auto",
  mode = "standard",
  cashAdded = 0,
  useExcessCash = false,
  useGuardrail = true,
  overrideGuardrailKeys = [],
} = {}) {
  const overrideSet = new Set(Array.isArray(overrideGuardrailKeys) ? overrideGuardrailKeys : []);
  const addCash = Number.isFinite(Number(cashAdded)) && Number(cashAdded) > 0 ? Number(cashAdded) : 0;
  const bucketSum = computeBucketSummary({ rows, cashValue, total, plan, items, profileId });
  const hasSymTargets = Object.keys(plan.targets || {}).length > 0;
  const resolvedScope = scope === "bucket" ? "bucket"
    : scope === "symbol" ? "symbol"
    : (bucketSum.hasTargets ? "bucket" : "symbol");

  const tolPlan = { band: plan.band ?? 5, rel: plan.rel ?? 25 };
  const newTotal = total + addCash;

  const entries = [];
  let cashEntry = null;

  if (resolvedScope === "bucket") {
    for (const b of bucketSum.buckets) {
      if (!(b.tgt > 0)) continue;
      const nonAlloc = b.members.filter((m) => !m.allocOnly && m.zone >= 0 && m.value > 0);
      const nonAllocVal = nonAlloc.reduce((s, m) => s + m.value, 0);
      const allHoldVal = b.members.reduce((s, m) => s + m.value, 0);
      let repZone = -1;
      if (!b.isCash && allHoldVal > 0 && nonAllocVal / allHoldVal >= 0.5) {
        const hotVal = nonAlloc.filter((m) => m.zone >= 3).reduce((s, m) => s + m.value, 0);
        const cheapVal = nonAlloc.filter((m) => m.zone <= 1).reduce((s, m) => s + m.value, 0);
        if (hotVal / nonAllocVal >= 0.6) repZone = 3;
        else if (cheapVal / nonAllocVal >= 0.6) repZone = 1;
        else repZone = 2;
      }
      const e = {
        key: b.id,
        kind: b.isCash ? "cash" : "bucket",
        bucketId: b.id,
        name: b.name,
        curVal: b.value,
        curPct: total > 0 ? b.value / total * 100 : 0,
        tgtPct: b.tgt,
        tol: driftTolerance(b.tgt, tolPlan),
        zone: repZone,
        allocOnly: b.isCash || (b.members.length > 0 && b.members.every((m) => m.allocOnly)),
        pxBase: NaN,
        members: b.members,
      };
      if (b.isCash) cashEntry = e;
      else entries.push(e);
    }
  } else {
    const heldMap = new Map(rows.map((r) => [r.symbol, r]));
    for (const [sym, tgt] of Object.entries(plan.targets || {})) {
      if (!(tgt > 0)) continue;
      const h = heldMap.get(sym);
      const it = items instanceof Map ? items.get(sym) : items?.[sym];
      const curVal = h && Number.isFinite(h.value) ? h.value : 0;
      const price = h ? h.price : quotes[sym];
      const currency = h ? h.currency : (sym.startsWith("us") ? "USD" : sym.startsWith("hk") ? "HKD" : "CNY");
      const pxBase = price > 0 ? conv(price, currency) : NaN;
      entries.push({
        key: sym,
        kind: "symbol",
        symbol: sym,
        name: (it && it.name) || (h && (h.boardName || h.name)) || sym.slice(2).toUpperCase(),
        curVal,
        curPct: total > 0 ? curVal / total * 100 : 0,
        tgtPct: tgt,
        tol: driftTolerance(tgt, tolPlan),
        zone: h ? h.zone : -1,
        allocOnly: isAllocOnly(plan, sym),
        pxBase,
        held: !!h,
      });
    }
    const cTgt = effectiveCashTarget(plan);
    if (Number.isFinite(cTgt) && cTgt >= 0) {
      cashEntry = {
        key: "__cash__",
        kind: "cash",
        name: "Cash",
        curVal: cashValue,
        curPct: total > 0 ? cashValue / total * 100 : 0,
        tgtPct: cTgt,
        tol: cTgt > 0 ? driftTolerance(cTgt, tolPlan) : 0,
        zone: -1,
        allocOnly: true,
        pxBase: NaN,
      };
    }
  }

  const sells = [], buys = [], holds = [];
  const evalGuardrail = (entry, rawDelta) => {
    if (!useGuardrail || entry.allocOnly || entry.zone < 0 || overrideSet.has(entry.key)) return null;
    if (rawDelta < -1e-6 && entry.zone <= 1) return "guard_hold_cheap";
    if (rawDelta > 1e-6 && entry.zone >= 3) return "guard_wait_hot";
    return null;
  };

  if (mode === "cashflow") {
    let pool = addCash;
    if (useExcessCash && cashEntry && newTotal > 0) {
      const targetCashVal = cashEntry.tgtPct / 100 * newTotal;
      pool += Math.max(0, cashValue - targetCashVal);
    }

    const candidates = [];
    for (const e of entries) {
      const targetVal = e.tgtPct / 100 * newTotal;
      const rawDelta = targetVal - e.curVal;
      const guard = evalGuardrail(e, rawDelta);
      if (rawDelta > 1e-6 && !guard) {
        candidates.push({ entry: e, shortfall: rawDelta });
      } else {
        holds.push({
          ...e,
          rawDelta,
          execDelta: 0,
          shares: NaN,
          reason: guard || (rawDelta < -1e-6 ? "no_sell_mode" : "within_target"),
          afterVal: e.curVal,
          afterPct: newTotal > 0 ? e.curVal / newTotal * 100 : 0,
        });
      }
    }

    const sumShortfall = candidates.reduce((s, c) => s + c.shortfall, 0);
    const spend = Math.min(pool, sumShortfall);
    for (const c of candidates) {
      const alloc = sumShortfall > 0 ? spend * (c.shortfall / sumShortfall) : 0;
      const e = c.entry;
      const afterVal = e.curVal + alloc;
      const item = {
        ...e,
        rawDelta: c.shortfall,
        execDelta: alloc,
        shares: Number.isFinite(e.pxBase) && e.pxBase > 0 ? Math.floor(alloc / e.pxBase) : NaN,
        reason: alloc > 0.01 ? "cashflow_buy" : "no_cash",
        afterVal,
        afterPct: newTotal > 0 ? afterVal / newTotal * 100 : 0,
      };
      if (alloc > 0.01) buys.push(item);
      else holds.push(item);
    }

    buys.sort((a, b) => b.execDelta - a.execDelta);
    const totalBuy = buys.reduce((s, x) => s + x.execDelta, 0);
    const afterCash = cashValue + addCash - totalBuy;

    return {
      scope: resolvedScope,
      canSwitchScope: bucketSum.hasTargets && hasSymTargets,
      mode,
      useGuardrail,
      cashAdded: addCash,
      availableCash: pool,
      totalBefore: total,
      totalAfter: newTotal,
      sells,
      buys,
      holds,
      totalSell: 0,
      totalBuy,
      afterCash,
      afterCashPct: newTotal > 0 ? afterCash / newTotal * 100 : 0,
      cashTargetPct: cashEntry ? cashEntry.tgtPct : null,
      activeProfile: bucketSum.activeProfile,
    };
  }

  for (const e of entries) {
    const targetVal = e.tgtPct / 100 * newTotal;
    const rawDelta = targetVal - e.curVal;
    const curDrift = e.curPct - e.tgtPct;
    const guard = evalGuardrail(e, rawDelta);
    const tiny = Math.abs(rawDelta) < Math.max(1, newTotal * 0.0005);

    if (tiny || guard) {
      holds.push({
        ...e,
        rawDelta,
        execDelta: 0,
        shares: NaN,
        reason: guard || "within_target",
        afterVal: e.curVal,
        afterPct: newTotal > 0 ? e.curVal / newTotal * 100 : 0,
      });
      continue;
    }

    const afterVal = e.curVal + rawDelta;
    const shares = Number.isFinite(e.pxBase) && e.pxBase > 0 ? Math.round(rawDelta / e.pxBase) : NaN;
    const status = driftStatus(e.held !== false, e.curPct, e.tgtPct, e.tol);
    const action = e.kind === "symbol" ? driftAction(status, e.zone) : (rawDelta < 0 ? "trim" : "add");
    const rec = {
      ...e,
      drift: curDrift,
      rawDelta,
      execDelta: rawDelta,
      shares,
      reason: action,
      afterVal,
      afterPct: newTotal > 0 ? afterVal / newTotal * 100 : 0,
    };
    if (rawDelta < 0) sells.push(rec);
    else buys.push(rec);
  }

  sells.sort((a, b) => a.execDelta - b.execDelta);
  buys.sort((a, b) => b.execDelta - a.execDelta);

  const totalSell = sells.reduce((s, x) => s + Math.abs(x.execDelta), 0);
  const totalBuy = buys.reduce((s, x) => s + x.execDelta, 0);
  const afterCash = cashValue + addCash + totalSell - totalBuy;

  return {
    scope: resolvedScope,
    canSwitchScope: bucketSum.hasTargets && hasSymTargets,
    mode,
    useGuardrail,
    cashAdded: addCash,
    availableCash: cashValue + addCash + totalSell,
    totalBefore: total,
    totalAfter: newTotal,
    sells,
    buys,
    holds,
    totalSell,
    totalBuy,
    afterCash,
    afterCashPct: newTotal > 0 ? afterCash / newTotal * 100 : 0,
    cashTargetPct: cashEntry ? cashEntry.tgtPct : null,
    activeProfile: bucketSum.activeProfile,
  };
}

// ---------- 3. 定期再平衡复盘日程 ----------
const FREQ_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

function addMonthsIso(isoDay, months) {
  const [y, m, d] = isoDay.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  if (dt.getUTCDate() !== d) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}

export function computeScheduleStatus(schedule, nowIso = new Date().toISOString().slice(0, 10)) {
  const freq = schedule?.freq || "none";
  const months = FREQ_MONTHS[freq];
  if (!months) return { active: false, freq: "none", lastRebalancedAt: schedule?.lastRebalancedAt || null, nextReviewAt: null, daysLeft: null, overdue: false };
  const last = schedule?.lastRebalancedAt || null;
  if (!last) return { active: true, freq, lastRebalancedAt: null, nextReviewAt: nowIso, daysLeft: 0, overdue: true, neverDone: true };
  const next = addMonthsIso(last, months);
  const ms = Date.parse(next + "T00:00:00Z") - Date.parse(nowIso + "T00:00:00Z");
  const daysLeft = Math.round(ms / 86400000);
  return { active: true, freq, lastRebalancedAt: last, nextReviewAt: next, daysLeft, overdue: daysLeft <= 0, neverDone: false };
}

// ---------- 4. 资产曲线保守风控指标 ----------
export function computeRiskMetrics(pts) {
  const valid = (pts || []).filter((p) => Array.isArray(p) && typeof p[0] === "string" && Number.isFinite(p[1]) && p[1] > 0);
  if (valid.length < 2) return null;

  let peakVal = valid[0][1], peakDay = valid[0][0];
  let maxDd = 0, ddPeakDay = valid[0][0], ddTroughDay = valid[0][0];

  for (let i = 1; i < valid.length; i++) {
    const [day, val] = valid[i];
    if (val >= peakVal) { peakVal = val; peakDay = day; }
    else {
      const dd = (val - peakVal) / peakVal;
      if (dd < maxDd) { maxDd = dd; ddPeakDay = peakDay; ddTroughDay = day; }
    }
  }

  const last = valid[valid.length - 1];
  const currentDd = peakVal > 0 ? Math.min(0, (last[1] - peakVal) / peakVal) : 0;

  let annVolPct = null;
  if (valid.length >= 14) {
    const rets = [];
    let gapDaysSum = 0;
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1], cur = valid[i];
      rets.push((cur[1] - prev[1]) / prev[1]);
      gapDaysSum += Math.max(1, Math.round((Date.parse(cur[0] + "T00:00:00Z") - Date.parse(prev[0] + "T00:00:00Z")) / 86400000));
    }
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    const periodsPerYear = Math.min(252, 365 / (gapDaysSum / rets.length));
    annVolPct = Math.sqrt(variance * periodsPerYear) * 100;
  }

  return {
    sampleCount: valid.length,
    maxDrawdownPct: maxDd * 100,
    peakDay: ddPeakDay,
    troughDay: ddTroughDay,
    currentDrawdownPct: currentDd * 100,
    atHigh: currentDd === 0,
    annVolPct,
  };
}
