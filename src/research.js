// 市场投研数据（长桥 OpenAPI）：分析师评级分布 + 目标价区间 + 一致预期 EPS，以及公司简介与收入构成（先看懂生意再谈估值）。
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

// 公司简介：经营范围 / 业务描述（截断），员工数
export function parseProfile(json) {
  const d = json && json.data;
  if (!d || !(d.profile || d.name)) return null;
  const text = String(d.profile || "").replace(/\s+/g, " ").trim();
  return { name: d.company_name || d.name || "", profile: text.length > 600 ? text.slice(0, 600) + "…" : text, employees: num(d.employees), founded: d.founded || "" };
}
// 收入构成：按业务、按地区（去掉「部门间冲销」这类没有占比的项）
export function parseSegments(json) {
  const d = json && json.data;
  if (!d) return null;
  const items = (arr) => (Array.isArray(arr) ? arr : []).map((x) => ({ name: String(x.name || ""), percent: num(x.percent), yoy: num(x.yoy) })).filter((x) => x.name && x.percent !== null && x.percent > 0).slice(0, 8);
  const business = items(d.business), regions = items(d.regionals);
  if (!business.length && !regions.length) return null;
  return { period: d.report_txt || "", business, regions };
}

export async function fetchResearch(env, tencentSymbol, get = signedGet) {
  const lp = tencentToLongport(tencentSymbol);
  if (!lp || !env.LONGBRIDGE_APP_KEY || !env.LONGBRIDGE_APP_SECRET || !env.LONGBRIDGE_ACCESS_TOKEN) return null;
  const q = `symbol=${encodeURIComponent(lp)}`;
  // 串行请求，避免触发限流
  const one = async (path, parse) => { try { return parse(await get(env, path, q)); } catch { return null; } };
  const rating = await one("/v1/quote/institution-rating-latest", parseRating);
  const forecastEps = await one("/v1/quote/forecast-eps", parseForecastEps);
  const profile = await one("/v1/quote/comp-overview", parseProfile);
  const segments = await one("/v1/quote/fundamentals/business-segments", parseSegments);
  if (!rating && !forecastEps && !profile && !segments) return null;
  return { rating, forecastEps, profile, segments };
}

const SYM_RE = /^(us|hk|sh|sz|bj)[A-Za-z0-9.]{1,12}$/;
const TTL = 6 * 3600;

export function registerResearch(app, { fetchImpl = fetchResearch } = {}) {
  app.get("/api/research", async (c) => {
    const symbol = (c.req.query("symbol") || "").trim();
    if (!SYM_RE.test(symbol)) return c.json({ error: "bad symbol" }, 400);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request("https://cache.local/research/v2/" + symbol); // v2：加了公司简介与收入构成
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }
    const research = await fetchImpl(c.env, symbol);
    const res = new Response(JSON.stringify({ symbol, research }), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${research ? TTL : 600}` },
    });
    if (cache && research) { try { c.executionCtx.waitUntil(cache.put(key, res.clone())); } catch { await cache.put(key, res.clone()); } }
    return res;
  });
}
