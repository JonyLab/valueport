// Finnhub /stock/metric —— 取美股「调整后 EPS」(剔除非经常项的 normalized EPS,Non-GAAP-ish)。
// 仅美股;需 env.FINNHUB_API_KEY。调用方按日缓存。失败 / 无 key / 非美股一律返回 null,不抛。
// 说明:这是 Finnhub 标准化的口径(剔 extraordinary items),非公司官方 Non-GAAP 对账原文,仅作参考。

// 把本项目标的代码(如 usAAPL)转成 Finnhub ticker(AAPL);非美股返回 null。
export function usTicker(symbol) {
  const m = /^us(.+)$/i.exec(symbol || "");
  return m ? m[1].toUpperCase() : null;
}

// 从 /stock/metric 响应取调整后 EPS:优先 TTM(epsExclExtraItemsTTM),回退年度 normalized。取不到为 null。
export function parseAdjustedEps(json) {
  const m = json && json.metric;
  if (!m || typeof m !== "object") return null;
  for (const key of ["epsExclExtraItemsTTM", "epsNormalizedAnnual"]) {
    const raw = m[key];
    if (raw == null || raw === "") continue; // 空值跳过(Number(null)=0 会误判)
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// 拉取美股调整后 EPS(TTM)。非美股 / 无 key / 失败 → null。
export async function fetchAdjustedEps(env, symbol) {
  const ticker = usTicker(symbol);
  const key = env && env.FINNHUB_API_KEY;
  if (!ticker || !key) return null;
  const url = "https://finnhub.io/api/v1/stock/metric"
    + `?symbol=${encodeURIComponent(ticker)}&metric=all&token=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseAdjustedEps(await res.json());
  } catch { return null; }
}
