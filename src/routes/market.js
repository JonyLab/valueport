// Public market data proxy routes: quotes, symbol names/statics, stock & broker logos, financials, and search hints.
import { parseTencentQuotes, parseTencentHints, parseTencentStatics, parseTencentPrevClose, logoTicker, lbLogoPath } from "../quotes.js";
import { hasLongbridgeCreds, fetchLongbridgeQuotes, fetchLongbridgeNames, fetchLongbridgeFinancials, pickLatestAnnual, fetchValuationRefs } from "../longbridge.js";
import { fetchDeductedNetIncome } from "../eastmoney.js";
import { fetchAdjustedEps } from "../finnhub.js";
import { fetchDividendHistory } from "../dividends.js";
import { fetchEastmoneyFinancials } from "../financials-em.js";

const LB_MIN_BYTES = 5000;
const BROKER_LOGO_DOMAINS = {
  longbridge: "longbridge.com",
  ibkr: "interactivebrokers.com",
  tiger: "itiger.com",
  schwab: "schwab.com",
  etrade: "etrade.com",
  webull: "webull.com",
};

async function fetchGbk(url) {
  const res = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return new TextDecoder("gbk").decode(await res.arrayBuffer());
}

// 一次请求同时取现价与昨收（昨收用于前端算当日涨跌）
async function tencentQuotes(symbols) {
  if (!symbols.length) return { quotes: {}, prevClose: {} };
  try {
    const text = await fetchGbk("https://qt.gtimg.cn/q=" + symbols.join(","));
    return { quotes: parseTencentQuotes(text, symbols), prevClose: parseTencentPrevClose(text, symbols) };
  } catch { return { quotes: {}, prevClose: {} }; }
}

// 现价：有长桥凭据则优先用其实时行情，失败或缺漏的退回腾讯延时；腾讯总要请求一次，补缺漏并提供昨收（长桥行情接口不返回昨收）
export async function getQuotes(env, symbols) {
  let quotes = {}, source = "tencent";
  if (hasLongbridgeCreds(env)) {
    try { quotes = await fetchLongbridgeQuotes(env, symbols); source = "longbridge"; }
    catch (e) { console.error("longbridge failed, fall back to tencent:", e && e.message); quotes = {}; source = "tencent"; }
  }
  const tc = await tencentQuotes(symbols);
  for (const s of symbols) if (!(s in quotes) && s in tc.quotes) quotes[s] = tc.quotes[s];
  return { quotes, prevClose: tc.prevClose, source };
}

async function fetchLogo(url, minBytes = 0) {
  const res = await fetch(url, { cf: { cacheTtl: 604800, cacheEverything: true } });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.startsWith("image/")) return null;
  const buf = await res.arrayBuffer();
  return buf.byteLength >= minBytes ? { buf, type } : null;
}

export function registerMarketRoutes(app) {
  app.get("/api/quotes", async (c) => {
    const symbols = (c.req.query("symbols") || "").split(",").map((s) => s.trim()).filter((s) => s && s.length <= 16).slice(0, 50);
    if (!symbols.length) return c.json({ quotes: {}, ts: new Date().toISOString() });
    const { quotes, prevClose, source } = await getQuotes(c.env, symbols);
    c.header("Cache-Control", "no-store"); // 实时行情不缓存
    if (!Object.keys(quotes).length) return c.json({ quotes: {}, error: "upstream unreachable", ts: new Date().toISOString() }, 502);
    return c.json({ quotes, prevClose, source, ts: new Date().toISOString() });
  });

  // 标的中英文名 + 静态信息（总股本、TTM EPS 等，估值计算器要用）。优先长桥；长桥未配置或缺项的，用腾讯行情串补
  app.get("/api/names", async (c) => {
    const symbols = (c.req.query("symbols") || "").split(",").map((s) => s.trim()).filter((s) => s && s.length <= 16).slice(0, 50);
    if (!symbols.length) return c.json({ names: {} });
    let names = {};
    if (hasLongbridgeCreds(c.env)) {
      try { names = await fetchLongbridgeNames(c.env, symbols); }
      catch (e) { console.error("longbridge names failed:", e && e.message); names = {}; }
    }
    const missing = symbols.filter((s) => !(names[s] && names[s].en && Number(names[s].totalShares) > 0 && Number(names[s].high52) > 0));
    if (missing.length) {
      let tc = {};
      try { tc = parseTencentStatics(await fetchGbk("https://qt.gtimg.cn/q=" + missing.join(",")), missing); } catch { tc = {}; }
      for (const s of missing) {
        if (!tc[s]) continue;
        const cur = names[s] || {};
        const pick = (k) => (cur[k] !== undefined && cur[k] !== null && cur[k] !== "" && !(typeof cur[k] === "number" && !Number.isFinite(cur[k])) ? cur[k] : tc[s][k]);
        names[s] = {
          ...cur, cn: pick("cn"), en: pick("en"), currency: pick("currency"),
          totalShares: Number(cur.totalShares) > 0 ? cur.totalShares : tc[s].totalShares, epsTtm: pick("epsTtm"),
          peTtm: pick("peTtm"), high52: pick("high52"), low52: pick("low52"),
        };
      }
    }
    c.header("Cache-Control", "public, max-age=86400"); // 名称基本不变，可缓存一天
    return c.json({ names });
  });

  // 标的 logo：先长桥图标库（小于 LB_MIN_BYTES 的占位图丢掉），再退到 FinancialModelingPrep（没有就 404）
  app.get("/api/logo", async (c) => {
    const sym = (c.req.query("symbol") || "").trim();
    const t = logoTicker(sym), lb = lbLogoPath(sym);
    if (!t && !lb) return c.body(null, 404);
    try {
      const img = (lb && await fetchLogo(`https://assets.lbkrs.com/ticker/ST/${lb}.png`, LB_MIN_BYTES).catch(() => null))
        || (t && await fetchLogo(`https://financialmodelingprep.com/image-stock/${encodeURIComponent(t)}.png`).catch(() => null));
      if (!img) return c.body(null, 404, { "Cache-Control": "public, max-age=86400" });
      return new Response(img.buf, { headers: { "Content-Type": img.type, "Cache-Control": "public, max-age=604800" } });
    } catch {
      return c.body(null, 404);
    }
  });

  // 券商 logo：只认白名单里的券商，经本站代理
  app.get("/api/broker-logo/:broker", async (c) => {
    const domain = BROKER_LOGO_DOMAINS[c.req.param("broker")];
    if (!domain) return c.body(null, 404);
    try {
      const res = await fetch(`https://www.google.com/s2/favicons?domain=${domain}&sz=128`, { cf: { cacheTtl: 2592000, cacheEverything: true } });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.startsWith("image/")) return c.body(null, 404, { "Cache-Control": "public, max-age=86400" });
      return new Response(res.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=2592000" } });
    } catch {
      return c.body(null, 404);
    }
  });

  // 财报（Fundamental）：按需取 + 缓存一天。长桥（需凭据）优先；长桥无凭据/失败/空 → 东财 F10 免费兜底（A/港/美）。
  app.get("/api/financials", async (c) => {
    const symbol = (c.req.query("symbol") || "").trim();
    const isAnnual = c.req.query("period") !== "quarter";
    const report = isAnnual ? "af" : "qf";
    const haveCreds = hasLongbridgeCreds(c.env);
    const hasData = (f) => !!(f && (f.IS || f.BS || f.CF));
    let financials = null, valuationRefs = null, deducted = null, adjEps = null, dividends = null, financialsSource = null;
    if (symbol) {
      try {
        if (isAnnual) {
          // 扣非(东财·A股)、调整后EPS(Finnhub·美股)、逐年派息(东财·全市场)均与长桥并行拉取;免费、各自失败不影响其余
          const [f, vr, dni, aeps, div] = await Promise.all([
            haveCreds ? fetchLongbridgeFinancials(c.env, symbol, report) : null,
            haveCreds ? fetchValuationRefs(c.env, symbol) : null,
            fetchDeductedNetIncome(symbol),
            fetchAdjustedEps(c.env, symbol),
            fetchDividendHistory(symbol),
          ]);
          financials = f; valuationRefs = vr; deducted = dni; adjEps = aeps; dividends = div;
        } else if (haveCreds) {
          financials = await fetchLongbridgeFinancials(c.env, symbol, report);
        }
      } catch (e) { console.error("financials failed:", e && e.message); financials = null; }
      if (hasData(financials)) financialsSource = "longbridge";
      else {
        financials = await fetchEastmoneyFinancials(symbol, report);
        if (hasData(financials)) financialsSource = "eastmoney";
      }
    }
    const latest = pickLatestAnnual(financials);
    if (Number.isFinite(deducted)) latest.deductedNetIncome = deducted;
    if (Number.isFinite(adjEps)) latest.adjustedEps = adjEps;
    const ok = hasData(financials);
    const divMissing = isAnnual && /^(sh|sz|bj|hk|us)/i.test(symbol) && !dividends;
    const maxAge = !ok ? 0 : (divMissing || financialsSource !== "longbridge" ? 3600 : 86400);
    c.header("Cache-Control", maxAge ? `public, max-age=${maxAge}` : "no-store");
    return c.json({ financials, latest, valuationRefs, dividends, financialsSource });
  });

  app.get("/api/hints", async (c) => {
    const q = c.req.query("q") || "";
    if (!q) return c.json({ hints: [] });
    try { const text = await fetchGbk("https://smartbox.gtimg.cn/s3/?v=2&t=all&q=" + encodeURIComponent(q)); return c.json({ hints: parseTencentHints(text) }); }
    catch { return c.json({ hints: [] }); }
  });
}
