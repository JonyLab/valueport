// 市场投研数据（长桥 OpenAPI）：分析师评级分布 + 目标价区间 + 一致预期 EPS，以及公司简介与收入构成（先看懂生意再谈估值）。
// 给「AI 推荐方法」和「AI 复核」当「市场怎么看」的依据。A 股长桥暂无数据：两地上市的借 H 股的公司资料，其余返回 null。
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

// A+H 两地上市：长桥没有 A 股的公司简介与收入构成，但同一家公司的 H 股有。只借公司层面的资料（简介、业务构成），
// 评级与一致预期按各自市场的币种和股价算，不能混用。名单只收常见的两地上市公司，缺了就只是没有资料。
export const A_TO_H = {
  "601318.SH": "2318.HK", "601628.SH": "2628.HK", "601601.SH": "2601.HK", "601336.SH": "1336.HK", "601319.SH": "1339.HK",
  "601398.SH": "1398.HK", "601939.SH": "939.HK", "601288.SH": "1288.HK", "601988.SH": "3988.HK", "601328.SH": "3328.HK",
  "600036.SH": "3968.HK", "601998.SH": "998.HK", "600016.SH": "1988.HK", "601818.SH": "6818.HK", "601658.SH": "1658.HK",
  "600030.SH": "6030.HK", "600837.SH": "6837.HK", "601688.SH": "6886.HK", "601211.SH": "2611.HK", "600958.SH": "3958.HK", "601881.SH": "6881.HK",
  "600028.SH": "386.HK", "601857.SH": "857.HK", "601088.SH": "1088.HK", "600188.SH": "1171.HK", "601898.SH": "1898.HK", "601808.SH": "2883.HK",
  "601899.SH": "2899.HK", "600362.SH": "358.HK", "603993.SH": "3993.HK", "601600.SH": "2600.HK", "600585.SH": "914.HK",
  "601766.SH": "1766.HK", "601390.SH": "390.HK", "601186.SH": "1186.HK", "601800.SH": "1800.HK", "601618.SH": "1618.HK",
  "600011.SH": "902.HK", "600027.SH": "1071.HK", "601991.SH": "991.HK", "600029.SH": "1055.HK", "601111.SH": "753.HK", "600115.SH": "670.HK",
  "601919.SH": "1919.HK", "601866.SH": "2866.HK", "601238.SH": "2238.HK", "601633.SH": "2333.HK", "600660.SH": "3606.HK", "600690.SH": "6690.HK",
  "600276.SH": "1276.HK", "603259.SH": "2359.HK", "600196.SH": "2196.HK", "600332.SH": "874.HK", "601607.SH": "2607.HK",
  "000002.SZ": "2202.HK", "000063.SZ": "763.HK", "002594.SZ": "1211.HK", "000338.SZ": "2338.HK", "000039.SZ": "2039.HK",
  "002460.SZ": "1772.HK", "002352.SZ": "6936.HK", "000333.SZ": "300.HK", "300750.SZ": "3750.HK",
};

export async function fetchResearch(env, tencentSymbol, get = signedGet) {
  const lp = tencentToLongport(tencentSymbol);
  if (!lp || !env.LONGBRIDGE_APP_KEY || !env.LONGBRIDGE_APP_SECRET || !env.LONGBRIDGE_ACCESS_TOKEN) return null;
  // 串行请求，避免触发限流
  const one = async (path, parse, symbol = lp) => { try { return parse(await get(env, path, `symbol=${encodeURIComponent(symbol)}`)); } catch { return null; } };
  const rating = await one("/v1/quote/institution-rating-latest", parseRating);
  const forecastEps = await one("/v1/quote/forecast-eps", parseForecastEps);
  let profile = await one("/v1/quote/comp-overview", parseProfile);
  let segments = await one("/v1/quote/fundamentals/business-segments", parseSegments);
  let companySource = null;
  const h = A_TO_H[lp];
  if (h && !profile && !segments) {
    profile = await one("/v1/quote/comp-overview", parseProfile, h);
    segments = await one("/v1/quote/fundamentals/business-segments", parseSegments, h);
    if (profile || segments) companySource = h;
  }
  if (!rating && !forecastEps && !profile && !segments) return null;
  return { rating, forecastEps, profile, segments, ...(companySource ? { companySource } : {}) };
}

const SYM_RE = /^(us|hk|sh|sz|bj)[A-Za-z0-9.]{1,12}$/;
const TTL = 6 * 3600;

export function registerResearch(app, { fetchImpl = fetchResearch } = {}) {
  app.get("/api/research", async (c) => {
    const symbol = (c.req.query("symbol") || "").trim();
    if (!SYM_RE.test(symbol)) return c.json({ error: "bad symbol" }, 400);
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const key = new Request("https://cache.local/research/v3/" + symbol); // v3：A 股借用 H 股的公司资料
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }
    const research = await fetchImpl(c.env, symbol);
    const res = new Response(JSON.stringify({ symbol, research }), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${research ? TTL : 600}` },
    });
    if (cache && research) { try { c.executionCtx.waitUntil(cache.put(key, res.clone())); } catch { await cache.put(key, res.clone()); } }
    return res;
  });
}
