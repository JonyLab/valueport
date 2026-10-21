import { signedGet, tencentToLongport } from "./longbridge.js";
import { cleanManagementResearch, managementText } from "../public/shared/valuation/management-research.js";
import { fetchOfficialManagementResearch } from "./official-management-research.js";
import { createResearchStore, mergeResearchRefresh, RESEARCH_TTL } from "./management-research-store.js";

const EARNINGS = /财报|財報|法说|法說|业绩会|業績會|earnings|financial results|conference call|\bQ[1-4]\b/i;
const MANAGEMENT = /管理层|管理層|董事长|董事長|首席执行|首席財務|首席财务|\bCEO\b|\bCFO\b|公司(?:预计|預計|表示|维持|維持|指出|称|稱|决定|決定|归因|歸因)|management|chief executive|chief financial|company (?:expects|said|guides)/i;
const GUIDANCE = /指引|展望|预计|預計|预测|預測|规划|規劃|预算|預算|guidance|outlook|forecast|expects|plans/i;
const THIRD_PARTY = /分析师|分析師|研报|研報|投信|基金|法人|德银|德銀|德意志银行|高盛|摩根|analyst|research note|fund manager|Deutsche Bank|Goldman/i;
const MECHANISM = /收入|营收|營收|利润|利潤|毛利|需求|产能|產能|扩产|擴產|资本|資本|成本|价格|價格|订单|訂單|现金|現金|revenue|margin|demand|capacity|capex|cost|cash flow/i;
const COMMENTARY = /我们认为|我們認為|我们预计|我們預計|看来|看來|其实|其實|显然|顯然|换句话说|換句話說|确定性|確定性|从.{0,40}来看|從.{0,40}來看|we (?:believe|think|expect)|in our view|clearly/i;
const text = (s, n = 20000) => managementText(s, n);
const newsId = (s) => /^\d{1,20}$/.test(String(s || "")) ? String(s) : null;

export function earningsNewsScore(item) {
  const title = text(item.title, 300), description = text(item.description, 1500);
  return (EARNINGS.test(title) ? 8 : EARNINGS.test(description) ? 4 : 0)
    + (GUIDANCE.test(title + description) ? 2 : 0) + (MANAGEMENT.test(title + description) ? 2 : 0)
    - (/ETF|基金|期权|期權/.test(title) ? 3 : 0)
    - (/台股|美股|收盘|收盤|开盘|開盤|盘前|盤前|季线|季線|ADR|期交所/.test(title) ? 6 : 0);
}

export function reportedPeriod(body) {
  const source = text(body);
  const m = [...source.matchAll(/(?:FY\s*)?(20\d{2})\s*(?:年\s*)?(?:第\s*([1-4一二三四])\s*季(?:度)?|Q\s*([1-4]))/gi)]
    .find((match) => /财报|財報|业绩|業績|季报|季報|results|earnings|report/i.test(source.slice(Math.max(0, match.index - 30), match.index + match[0].length + 35)));
  if (!m) return "";
  const quarter = m[3] || ({ 一: 1, 二: 2, 三: 3, 四: 4 }[m[2]] || m[2]);
  return `${m[1]} Q${quarter}`;
}

// Extractive summaries keep original wording. Classification is deliberately advisory.
export function extractNewsPassages(body, thirdPartyContext = false) {
  const paragraphs = String(body || "").slice(0, 50000).split(/\n\s*\n|\n(?=[^#\n])/)
    .map((p) => text(p, 3000)).filter((p) => p.length >= 25 && !/^#{1,6}\s|^!\[|^免责声明|^免責聲明/.test(p));
  return paragraphs.map((p, index) => {
    const management = MANAGEMENT.test(p), thirdParty = THIRD_PARTY.test(p);
    const kind = management && (thirdParty || thirdPartyContext || COMMENTARY.test(p)) ? "mixed" : thirdParty ? "third_party"
      : management ? (GUIDANCE.test(p) ? "reported_guidance" : "reported_management")
        : thirdPartyContext && GUIDANCE.test(p) ? "third_party" : "context";
    const score = (management ? 8 : 0) + (GUIDANCE.test(p) ? 3 : 0) + (MECHANISM.test(p) ? 2 : 0) + (EARNINGS.test(p) ? 2 : 0);
    return { kind, excerpt: p.slice(0, 650), score, index };
  }).filter((p) => p.score >= 4).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3).sort((a, b) => a.index - b.index).map(({ kind, excerpt }) => ({ kind, excerpt }));
}

function publishedAt(value) {
  const n = Number(value);
  const date = new Date(Number.isFinite(n) && n > 0 ? n * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

export function relatedNews(markdown) {
  const items = [];
  for (const match of String(markdown).matchAll(/\[([^\]\n]{1,300})\]\(https:\/\/longbridge\.com\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?news\/(\d{1,20})(?:\.md)?\)/g)) {
    items.push({ id: match[2], title: text(match[1], 180), description: "" });
    if (items.length >= 12) break;
  }
  return items;
}

async function boundedText(res, maxBytes) {
  if (!res.ok || !res.body) { await res.body?.cancel(); throw new Error("news_unavailable"); }
  const reader = res.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("news_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function fetchNewsManagementResearch(env, symbol, name = "", options = {}) {
  const lp = tencentToLongport(symbol), now = options.now || Date.now();
  const empty = (status) => ({ status, symbol, fetchedAt: new Date(now).toISOString(), coverage: "recent_news_and_related", sources: [] });
  if (!lp || !env.LONGBRIDGE_APP_KEY || !env.LONGBRIDGE_APP_SECRET || !env.LONGBRIDGE_ACCESS_TOKEN) return empty("not_configured");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  const get = options.get || ((path, query = "") => signedGet(env, path, query, { signal: controller.signal, maxBytes: 256000, fetchImpl: options.fetchImpl }));
  const fetcher = options.fetchImpl || fetch;
  let partialFailure = false;
  try {
    const list = await get(`/v1/content/${lp}/news`);
    if (list?.code !== 0 || !Array.isArray(list.data?.items)) return empty("unavailable");
    let candidates = list.data.items.filter((item) => newsId(item.id) && /\/news\//.test(item.url || "") && earningsNewsScore(item) >= 2)
      .sort((a, b) => earningsNewsScore(b) - earningsNewsScore(a)).slice(0, 2);
    // Search is optional: some gateways currently return an empty result set.
    if (name.trim()) {
      try {
        const search = await get("/v1/search/news", "k=" + encodeURIComponent(text(name, 100)));
        for (const item of search?.code === 0 && Array.isArray(search.data?.news_list) ? search.data.news_list.slice(0, 30) : []) {
          if (newsId(item.id) && earningsNewsScore(item) >= 2) candidates.push(item);
        }
      } catch { partialFailure = true; }
    }
    candidates = [...new Map(candidates.map((item) => [String(item.id), item])).values()]
      .sort((a, b) => earningsNewsScore(b) - earningsNewsScore(a)).slice(0, 2);
    if (!candidates.length) return empty(partialFailure ? "unavailable" : "empty");
    // Public related links are discovery only. Statements always come from signed article detail.
    try {
      const res = await fetcher(`https://longbridge.com/zh-CN/news/${candidates[0].id}.md`, { signal: controller.signal, redirect: "manual" });
      const related = relatedNews(await boundedText(res, 256000));
      candidates.push(...related.filter((item) => earningsNewsScore(item) >= 2));
    } catch { partialFailure = true; }
    candidates = [...new Map(candidates.map((item) => [String(item.id), item])).values()]
      .sort((a, b) => earningsNewsScore(b) - earningsNewsScore(a)).slice(0, 3);
    const results = await Promise.allSettled(candidates.map(async (candidate) => {
      const json = await get(`/v1/content/news/${candidate.id}`), item = json?.data?.item;
      if (json?.code !== 0 || !item || newsId(item.id) !== String(candidate.id)) throw new Error("news_detail_unavailable");
      const published = publishedAt(item.published_at);
      if (!published || Date.parse(published) > now + 86400000 || Date.parse(published) < now - 120 * 86400000) return null;
      // Related/search results can discuss another issuer. Require an explicit ticker or company-name match.
      const inList = list.data.items.some((entry) => String(entry.id) === String(item.id));
      const companyMatch = text(name, 100).length >= 2 && text(item.title).toLowerCase().includes(text(name, 100).toLowerCase());
      if (!inList && !item.tickers?.includes(lp) && !companyMatch) return null;
      const body = item.body || item.description || "";
      const passages = extractNewsPassages(body, THIRD_PARTY.test(text(item.title) + " " + text(body, 500)));
      return passages.length ? { id: String(item.id), title: item.title, publisher: item.author?.name || "", publishedAt: published,
        reportPeriod: reportedPeriod(item.title + " " + body), passages } : null;
    }));
    const sources = results.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
    return cleanManagementResearch({ ...empty(sources.length ? "ok" : results.some((r) => r.status === "rejected") ? "unavailable" : "empty"), sources });
  } catch { return empty("unavailable"); }
  finally { clearTimeout(timer); }
}

export async function fetchManagementResearch(env, symbol, name = "", options = {}) {
  const [official, news] = await Promise.all([
    fetchOfficialManagementResearch(symbol, options, env), fetchNewsManagementResearch(env, symbol, name, options),
  ]);
  if (official.status === "not_configured") return news;
  const sources = [...official.sources, ...news.sources].slice(0, 3);
  return cleanManagementResearch({ ...news, status: sources.length ? "ok" : official.status === "unavailable" || news.status === "unavailable" ? "unavailable" : "empty",
    officialStatus: official.status, ...(official.site ? { officialSite: official.site } : {}), sources });
}

export function registerManagementResearch(app, { fetchResearch = fetchManagementResearch, now = Date.now } = {}) {
  app.get("/api/my/management-research", async (c) => {
    c.header("Cache-Control", "no-store");
    const symbol = c.req.query("symbol") || "", name = c.req.query("name") || "";
    if (!/^(?:us[A-Za-z0-9.-]{1,16}|(?:hk|sh|sz|bj)\d{1,8})$/.test(symbol) || name.length > 100) return c.json({ error: "bad company" }, 400);
    const key = new Request(`https://management-research.internal/v3?symbol=${encodeURIComponent(symbol)}`);
    const cached = await caches.default.match(key);
    if (cached) return c.json(await cached.json());
    const at = now(), store = createResearchStore(c.env.DB), stored = await store?.load(symbol, at);
    const withStorage = (research, status, savedAt, checkedAt) => cleanManagementResearch({ ...research, storage: { status, savedAt, checkedAt } });
    const putCache = (research, seconds = RESEARCH_TTL / 1000) => caches.default.put(key, Response.json(research, { headers: { "Cache-Control": `public, max-age=${Math.max(1, Math.floor(seconds))}` } }));
    if (stored) {
      const expired = at >= stored.refreshAfter;
      const research = withStorage(stored.research, expired ? "refreshing" : stored.failed ? "refresh_failed" : "saved", stored.savedAt, stored.checkedAt);
      if (expired) {
        c.executionCtx.waitUntil((async () => {
          if (!await store.claimRefresh(symbol, at)) return;
          try {
            const current = await fetchResearch(c.env, symbol, name, { knownSite: stored.research.officialSite, documentStore: store });
            const merged = mergeResearchRefresh(stored.research, current), checked = now();
            if (!merged.research || (merged.failed && current?.status !== "ok")) { await store.failRefresh(symbol, checked); return; }
            if (await store.save(symbol, merged.research, checked, merged.failed)) {
              await putCache(withStorage(merged.research, merged.failed ? "refresh_failed" : "saved", new Date(checked).toISOString(), new Date(checked).toISOString()), merged.failed ? 600 : RESEARCH_TTL / 1000);
            }
          } catch { await store.failRefresh(symbol, now()); }
        })());
      } else c.executionCtx.waitUntil(putCache(research, Math.min(RESEARCH_TTL, stored.refreshAfter - at) / 1000));
      return c.json(research);
    }
    const research = await fetchResearch(c.env, symbol, name, { documentStore: store });
    let result = research;
    if (research.status === "ok") {
      const saved = now();
      if (await store?.save(symbol, research, saved)) result = withStorage(research, "saved", new Date(saved).toISOString(), new Date(saved).toISOString());
      c.executionCtx.waitUntil(putCache(result));
    }
    return c.json(result);
  });
}
