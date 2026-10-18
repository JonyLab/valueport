// 市场投研数据（长桥 OpenAPI）：分析师评级分布 + 目标价区间 + 一致预期 EPS。
// 给「AI 推荐方法」和「AI 复核」当「市场怎么看」的依据。A 股长桥暂无数据，返回 null。
// 长桥对连续请求有限流（短时间重复请求会返回空），所以结果按标的在 Cache API 里存 6 小时。
import { signedGet, tencentToLongport } from "./longbridge.js";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export function parseRating(json) {
  const d = json && json.data;
  if (!d || !d.evaluate || !(Number(d.evaluate.total) > 0)) return null;
  const e = d.evaluate, t = d.target || {};
  return {
    buy: num(e.buy) || 0, over: num(e.over) || 0, hold: num(e.hold) || 0, under: num(e.under) || 0, sell: num(e.sell) || 0,
    total: num(e.total) || 0,
    targetHigh: num(t.highest_price), targetLow: num(t.lowest_price), prevClose: num(t.prev_close),
    industry: d.industry_name ? { name: d.industry_name, rank: num(d.industry_rank), total: num(d.industry_total) } : null,
  };
}

// forecast-eps 返回按时间排列的一串快照，取最新一条
export function parseForecastEps(json) {
  const items = json && json.data && Array.isArray(json.data.items) ? json.data.items : [];
  const last = items[items.length - 1];
  if (!last || !(num(last.forecast_eps_median) !== null)) return null;
  return { median: num(last.forecast_eps_median), mean: num(last.forecast_eps_mean), low: num(last.forecast_eps_lowest), high: num(last.forecast_eps_highest) };
}

export async function fetchResearch(env, tencentSymbol, get = signedGet) {
  const lp = tencentToLongport(tencentSymbol);
  if (!lp || !env.LONGBRIDGE_APP_KEY || !env.LONGBRIDGE_APP_SECRET || !env.LONGBRIDGE_ACCESS_TOKEN) return null;
  const q = `symbol=${encodeURIComponent(lp)}`;
  // 串行请求，避免触发限流
  let rating = null, forecastEps = null;
  try { rating = parseRating(await get(env, "/v1/quote/institution-rating-latest", q)); } catch { /* 拿不到就算了 */ }
  try { forecastEps = parseForecastEps(await get(env, "/v1/quote/forecast-eps", q)); } catch { /* 拿不到就算了 */ }
  if (!rating && !forecastEps) return null;
  return { rating, forecastEps };
}

const SYM_RE = /^(us|hk|sh|sz|bj)[A-Za-z0-9.]{1,12}$/;
const TTL = 6 * 3600;

export function registerResearch(app, { fetchImpl = fetchResearch } = {}) {
  app.get("/api/research", async (c) => {
    const symbol = (c.req.query("symbol") || "").trim();
    if (!SYM_RE.test(symbol)) return c.json({ error: "bad symbol" }, 400);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request("https://cache.local/research/" + symbol);
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }
    const research = await fetchImpl(c.env, symbol);
    const res = new Response(JSON.stringify({ symbol, research }), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${research ? TTL : 600}` },
    });
    if (cache && research) { try { c.executionCtx.waitUntil(cache.put(key, res.clone())); } catch { await cache.put(key, res.clone()); } }
    return res;
  });
}
