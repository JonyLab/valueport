// AI 结论旁的迷你图：模型只从下面的白名单里挑一个指标 key，曲线和数字全部来自已加载的财报（模型从不给数字）。
// 服务端（src/ai.js、src/items.js）用同一份白名单剔除未知指标；前端按 key 取序列、算几何，再画成 64×20 的小折线。
// sec = 基本面 tab 里对应分节的编号（点击迷你图跳过去）；unit：money 金额 / pct 百分数 / ps 每股
export const METRICS = {
  revenue: { kind: "IS", field: "OperatingRevenue", unit: "money", sec: "01", zh: "营收", en: "Revenue" },
  netIncome: { kind: "IS", field: "NetProfit", unit: "money", sec: "01", zh: "净利润", en: "Net income" },
  fcf: { kind: "CF", field: "NetFreeCashFlow", unit: "money", sec: "01", zh: "自由现金流", en: "Free cash flow" },
  roe: { kind: "IS", field: "ROE", unit: "pct", sec: "02", zh: "ROE", en: "ROE" },
  grossMargin: { kind: "IS", field: "GrossMgn", unit: "pct", sec: "02", zh: "毛利率", en: "Gross margin" },
  netMargin: { kind: "IS", field: "NetProfitMargin", unit: "pct", sec: "02", zh: "净利率", en: "Net margin" },
  netDebt: { kind: "BS", field: "NetDebt", unit: "money", sec: "03", zh: "净负债", en: "Net debt" },
  eps: { kind: "IS", field: "EPS", unit: "ps", sec: null, zh: "每股收益", en: "EPS" },
  dividends: { kind: "DIV", unit: "ps", sec: "05", zh: "每股股利", en: "Dividend per share" },
};
export const METRIC_KEYS = Object.keys(METRICS);
// 合法的指标 key 原样返回，其余（未知、非字符串、原型链上的名字）一律 null
export const metricKey = (v) => (typeof v === "string" && Object.prototype.hasOwnProperty.call(METRICS, v) ? v : null);

// 指标按年份升序的 {year,value}，最多 n 年；financials 为长桥形状（values 最新在前），dividends 为 {years:[{year,perShare}]}
export function metricSeries(key, financials, dividends, n = 10) {
  const m = METRICS[metricKey(key)];
  if (!m) return [];
  let s;
  if (m.kind === "DIV") s = (dividends && Array.isArray(dividends.years) ? dividends.years : []).map((y) => ({ year: y.year, value: y.perShare }));
  else {
    const a = financials && Array.isArray(financials[m.kind]) && financials[m.kind].find((x) => x && x.field === m.field);
    s = a && Array.isArray(a.values) ? a.values.map((v) => ({ year: v.year, value: v.value })).reverse() : [];
  }
  s = s.filter((v) => v && Number.isFinite(v.value) && v.year != null).sort((a, b) => a.year - b.year);
  return s.slice(-n);
}

// 迷你折线的几何：按自身范围缩放（上下各留一点），跨 0 时给出 0 线位置；少于两个点不画（返回 null）
export function sparkGeom(series, W = 64, H = 20, pad = 2) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const vals = series.map((s) => s.value);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo;
  const r = (x) => Math.round(x * 100) / 100;
  const Y = (v) => r(span ? H - pad - (v - lo) / span * (H - pad * 2) : H / 2);
  const X = (i) => r(i / (series.length - 1) * W);
  const pts = series.map((s, i) => [X(i), Y(s.value)]);
  return {
    line: pts.map((p) => p.join(",")).join(" "),
    area: `0,${H} ${pts.map((p) => p.join(",")).join(" ")} ${W},${H}`,
    last: pts[pts.length - 1],
    zero: lo < 0 && hi > 0 ? Y(0) : null,
    latest: series[series.length - 1],
  };
}
