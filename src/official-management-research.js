import { publicManagementUrl, cleanOfficialSite, sameCompanySite, officialSourceUrl, managementText } from "../public/shared/valuation/management-research.js";

import { signedGet, tencentToLongport } from "./longbridge.js";

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const OUTLOOK = /\b(?:expect|guidance|outlook|forecast|optimistic|will|plans?|potential|ahead|future)\b|预计|預計|展望|指引|预期|預期|未来|未來/i;
const OPERATING = /\b(?:revenue|margin|GMV|EBITDA|monetization|take rate|cost|loan|credit|NPL|bookings|profit|cash|investment|capital|logistics|fulfillment|risk|growth)\b|收入|营收|營收|利润|利潤|成本|资本|資本|现金|現金|增长|增長|毛利|信贷|信貸/i;

async function readBounded(response, limit, signal) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("official_unavailable"); }
  if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel(); throw new Error("official_too_large"); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("official_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function extractOfficialPdf(bytes, { signal } = {}) {
  if (bytes.byteLength > MAX_PDF_BYTES || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("invalid_official_pdf");
  // Lazy-load only when a discovered document is a PDF; do not load remote resources or JS actions.
  const { getDocumentProxy } = await import("unpdf");
  signal?.throwIfAborted();
  const pdf = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: false, cMapUrl: undefined, standardFontDataUrl: undefined });
  try {
    if (pdf.numPages > 40) throw new Error("official_too_many_pages");
    const pages = []; let length = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      signal?.throwIfAborted();
      const docPage = await pdf.getPage(page), content = await docPage.getTextContent();
      const text = content.items.filter((item) => typeof item.str === "string").map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("");
      length += text.length;
      if (length > 200000) throw new Error("official_too_much_text");
      pages.push(text); docPage.cleanup();
    }
    return pages;
  } finally { await pdf.loadingTask.destroy(); }
}

export function officialDocumentSource(document, pages, { site, format = "pdf" } = {}) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 40) throw new Error("invalid_official_pages");
  const opening = pages.slice(0, 2).join("\n"), all = pages.join("\n");
  // Check the actual heading, not a search snippet or filename.
  const header = managementText(pages[0], 1400);
  const matchesPeriod = officialReportPeriod(header) === document.reportPeriod;
  const matchesIssuer = site?.aliases.some((name) => header.toLowerCase().includes(name.toLowerCase()));
  if (!matchesIssuer || !matchesPeriod || !/earnings|results|financial|业绩|業績|财报|財報|季度/i.test(header)) throw new Error("official_issuer_or_period_mismatch");
  const prepared = /\bprepared\s+remarks\b/i.test(header);
  const qaIncluded = /^\s*(?:Questions?\s*(?:and|&)\s*Answers?|Q\s*&\s*A\s*(?:Session)?|Question-and-Answer Session)\s*:?\s*$/im.test(all);
  const qaCoverage = qaIncluded ? "included" : prepared && /(?:open the call to questions|ready to.*questions)/i.test(pages.at(-1)) ? "not_included" : "unknown";
  const candidates = []; let speaker = "", section = "", index = 0;
  pages.forEach((pageText, pageIndex) => {
    let buffer = "";
    const flush = () => {
      let excerpt = managementText(buffer, 2200); buffer = "";
      if (excerpt.length > 650) {
        const boundary = [...excerpt.slice(0, 650).matchAll(/[.!?。！？](?=\s|$)/g)].at(-1)?.index;
        excerpt = excerpt.slice(0, boundary > 80 ? boundary + 1 : 650);
      }
      if (excerpt.length < 55 || !OPERATING.test(excerpt) || /forward-looking statements|non-GAAP financial measures/i.test(excerpt)) return;
      if (document.documentType === "earnings_call" && !speaker) return;
      const outlook = OUTLOOK.test(excerpt);
      candidates.push({ kind: outlook ? "official_guidance" : speaker ? "official_management" : "official_results",
        excerpt, speaker, section, page: pageIndex + 1, index: index++,
        score: (outlook ? 4 : 0) + (/\d/.test(excerpt) ? 2 : 0) + (/EBITDA|NPL|take rate|cost.per.order|bookings|loan book/i.test(excerpt) ? 3 : 0)
          + (/NPL|take rate|cost.per.order/i.test(excerpt) ? 4 : 0) + (section ? 1 : 0) });
    };
    for (const line of String(pageText).split(/\n/).map((s) => s.trim())) {
      if (!line || /^\d{1,3}$/.test(line)) { flush(); continue; }
      const label = line.match(/^([A-Z][A-Za-z .'-]{0,60}):$/);
      if (label && !/^(?:Note|Table|Source|In summary)$/i.test(label[1])) {
        flush();
        const name = label[1], escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        speaker = opening.match(new RegExp(`\\b${escaped} [A-Z][a-z]{1,24}\\b`))?.[0] || name;
        if (/operator|investor relations/i.test(speaker)) speaker = "";
        continue;
      }
      const business = line.match(/^(?:Starting with|Next,? (?:moving|turning) to|On)\s+([A-Z][A-Za-z0-9&-]*(?: [A-Z][A-Za-z0-9&-]*){0,3})\b/);
      if (business) { flush(); section = business[1]; }
      buffer += (buffer ? " " : "") + line;
      if (/[.!?。！？]$/.test(line) || buffer.length > 1800) flush();
    }
    flush();
  });
  // Keep evidence across businesses rather than letting one long section dominate.
  const ranked = candidates.sort((a, b) => b.score - a.score || a.index - b.index), selected = [];
  for (const section of [...new Set(candidates.map((p) => p.section).filter(Boolean))].slice(0, 3)) {
    const best = ranked.find((p) => p.section === section); if (best) selected.push(best);
  }
  for (const p of ranked) { if (!selected.includes(p)) selected.push(p); if (selected.length >= 6) break; }
  const passages = selected.slice(0, 6).sort((a, b) => a.index - b.index).map(({ score, index, ...p }) => p);
  if (!passages.length) throw new Error("official_no_extractable_passages");
  return { ...document, title: prepared ? document.title + " · Prepared Remarks" : document.title,
    documentType: prepared ? "prepared_remarks" : document.documentType, qaCoverage: document.documentType === "earnings_release" ? "not_included" : qaCoverage,
    format, pageCount: format === "pdf" ? pages.length : null,
    passages: format === "html" ? passages.map((p) => ({ ...p, page: null })) : passages };
}

// Read only explicit report periods. Fiscal years keep their FY prefix so they
// cannot silently become calendar years in valuation assumptions.
export function officialReportPeriod(raw) {
  const s = managementText(raw, 2400);
  const qnum = (s) => ({ first: 1, second: 2, third: 3, fourth: 4, 一: 1, 二: 2, 三: 3, 四: 4 }[s.toLowerCase()] || s);
  let m = s.match(/\b(FY\s*)?(20\d{2})\s*[-–:]?\s*Q([1-4])\b/i);
  if (m) return `${m[1] ? "FY" : ""}${m[2]} Q${m[3]}`;
  m = s.match(/\bQ([1-4])\s*[-–:]?\s*(FY\s*)?(20\d{2})\b/i);
  if (m) return `${m[2] ? "FY" : ""}${m[3]} Q${m[1]}`;
  m = s.match(/\b(first|second|third|fourth)[ -]quarter(?:\s+(?:and\s+(?:full|fiscal)\s+year|of))?\s+(?:(fiscal)(?:\s+year)?\s+)?(20\d{2})\b/i);
  if (m) return `${m[2] ? "FY" : ""}${m[3]} Q${qnum(m[1])}`;
  m = s.match(/\b(?:(fiscal)(?:\s+year)?\s+)?(20\d{2})\s+(first|second|third|fourth)[ -]quarter\b/i);
  if (m) return `${m[1] ? "FY" : ""}${m[2]} Q${qnum(m[3])}`;
  m = s.match(/(20\d{2})\s*(年|财年|財年)\s*第?([1-4一二三四])季(?:度)?/);
  if (m) return `${m[2] === "年" ? "" : "FY"}${m[1]} Q${qnum(m[3])}`;
  return "";
}

const decodeHtml = (s) => String(s).replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[0-9a-f]+);/gi, (entity) => {
  const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
  const n = parseInt(entity.slice(entity[2].toLowerCase() === "x" ? 3 : 2, -1), entity[2].toLowerCase() === "x" ? 16 : 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
});
export function officialHtmlText(html) {
  const clean = String(html).replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const title = clean.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const body = clean.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1] || clean;
  const plain = decodeHtml(body.replace(/<\/(?:p|div|h[1-6]|li|tr)>|<br\s*\/?>/gi, "\n\n").replace(/<[^>]*>/g, " "));
  return managementText(decodeHtml(title.replace(/<[^>]*>/g, " ")), 400) + "\n\n" + plain.replace(/[^\S\n]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
}

export function officialHtmlDate(html) {
  const patterns = [/<meta[^>]*(?:property|name)=["'](?:article:published_time|date|pubdate|datePublished)["'][^>]*content=["']([^"']+)/i,
    /"datePublished"\s*:\s*"([^"]+)"/i, /<time\b[^>]*datetime=["']([^"']+)/i];
  for (const pattern of patterns) {
    const raw = String(html).match(pattern)?.[1];
    if (raw && /^20\d{2}-\d{2}-\d{2}/.test(raw) && Number.isFinite(Date.parse(raw))) return raw.slice(0, 10);
  }
  return "";
}

export function discoverOfficialLinks(html, baseUrl, site) {
  const found = [];
  const clean = String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  for (const m of clean.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url; try { url = linkedDocumentUrl(new URL(decodeHtml(m[1]), baseUrl).href, site); } catch { continue; }
    if (!url || url === baseUrl) continue;
    const label = managementText(decodeHtml(m[2].replace(/<[^>]*>/g, " ")), 300);
    if (/^(?:EN|简|繁|English|中文)$/i.test(label)) continue;
    const key = decodeURIComponent(url) + " " + label;
    if (!/earnings|results|transcript|quarter|press.release|业绩|業績|财报|財報|季度|\.pdf/i.test(key) || /annual.report|20-f|10-k|privacy|contact|subscribe/i.test(key)) continue;
    const context = managementText(decodeHtml(clean.slice(Math.max(0, m.index - 250), m.index + m[0].length + 150).replace(/<[^>]*>/g, " ")), 700);
    const period = officialReportPeriod(label) || officialReportPeriod(context), pm = period.match(/(20\d{2}) Q([1-4])/);
    found.push({ url, title: label, score: (pm ? Number(pm[1]) * 4 + Number(pm[2]) : 0),
      release: /earnings releases?|press.release|results\.pdf|业绩公告|業績公告/i.test(key),
      call: /transcript|prepared.remarks|逐字|发言|發言/i.test(key), context });
    if (found.length >= 150) break;
  }
  return [...new Map(found.map((item) => [item.url, item])).values()].sort((a, b) => b.score - a.score || Number(b.call) - Number(a.call) || Number(b.release) - Number(a.release)).slice(0, 12);
}

// External PDFs are accepted only when directly linked by a fetched company/IR
// page. Their actual issuer and period still have to match the document text.
function linkedDocumentUrl(raw, site) {
  const url = publicManagementUrl(raw); if (!url) return null;
  const known = officialSourceUrl(url, site); if (known) return known;
  if (!/\.pdf(?:$|\?)/i.test(url) || site.linkedHosts.length >= 8) return null;
  site.linkedHosts.push(new URL(url).hostname); return url;
}

export function discoverIrEntrances(html, baseUrl, site) {
  const found = [];
  for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url; try { url = publicManagementUrl(new URL(decodeHtml(m[1]), baseUrl).href); } catch { continue; }
    if (!url) continue;
    const label = managementText(decodeHtml(m[2].replace(/<[^>]*>/g, " ")), 180);
    const same = sameCompanySite(url, site.website) || sameCompanySite(url, site.irUrl);
    // An off-domain IR platform needs an explicit link from the company's site.
    if (!(same ? /investor|quarterly|financial.results|投资者|投資者|投资人|投資人/i.test(url + " " + label) : /investor relations|投资者关系|投資者關係/i.test(label))) continue;
    if (/\.pdf(?:$|\?)/i.test(url) || /login|privacy|subscribe|contact|calendar/i.test(url)) continue;
    const score = /quarterly|quarter.*results|financial.*results|业绩|業績/i.test(url + " " + label) ? 3 : /investor.relations|投资者关系|投資者關係/i.test(label) ? 2 : 1;
    found.push({ url, score });
    if (found.length >= 40) break;
  }
  return [...new Map(found.map((item) => [item.url, item])).values()].sort((a, b) => b.score - a.score).slice(0, 5);
}

// JSON directories vary in shape. Keep only actual document URLs, inheriting
// nearby explicit year/quarter metadata as discovery hints, never as evidence.
export function discoverCatalogDocuments(catalog, baseUrl, site, now = Date.now()) {
  const links = []; let visited = 0;
  const walk = (value, context = {}, depth = 0) => {
    if (depth > 8 || ++visited > 2500 || links.length >= 100) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 80)) walk(item, context, depth + 1); return; }
    if (!value || typeof value !== "object") return;
    const year = /^(?:20\d{2})$/.test(String(value.year)) ? String(value.year) : context.year;
    const quarter = /^Q[1-4]$/i.test(value.quarter || "") ? value.quarter.toUpperCase() : context.quarter;
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      if (typeof child === "string" && /\.pdf(?:\s*$|\?)/i.test(child)) {
        let url; try { url = linkedDocumentUrl(new URL(child.trim(), baseUrl).href, site); } catch { continue; }
        if (!url) continue;
        const title = managementText(decodeURIComponent(new URL(url).pathname.split("/").at(-1)).replace(/\.pdf$/i, ""), 240);
        const date = title.match(/\b(20\d{2})[.-](\d{2})[.-](\d{2})\b/);
        const publishedAt = date ? `${date[1]}-${date[2]}-${date[3]}` : "";
        if (publishedAt && (!Number.isFinite(Date.parse(publishedAt)) || Date.parse(publishedAt) > now)) continue;
        if (/annual.report|infographic|20-f|10-k/i.test(key + title)) continue;
        const period = officialReportPeriod(title) || (year && quarter ? `${year} ${quarter}` : ""), m = period.match(/(20\d{2}) Q([1-4])/);
        links.push({ url, title, publishedAt, expectedPeriod: period, score: m ? Number(m[1]) * 4 + Number(m[2]) : 0,
          call: /transcript|prepared.remarks/i.test(key + title), release: /press.release|results/i.test(key + title) });
      } else if (child && typeof child === "object") walk(child, { year, quarter }, depth + 1);
    }
  };
  walk(catalog);
  return links.sort((a, b) => b.score - a.score || Number(b.call) - Number(a.call)).slice(0, 12);
}

async function searchOfficialLinks(env, site, fetcher, signal, now) {
  if (!env.TAVILY_API_KEY?.trim()) return [];
  const root = new URL(site.website).hostname.replace(/^www\./, "");
  const response = await fetcher("https://api.tavily.com/search", { method: "POST", signal, redirect: "manual",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY.trim()}` },
    body: JSON.stringify({ query: `${site.name} ${site.symbol.replace(/^(us|hk|sh|sz|bj)/, "")} ${new Date(now).getUTCFullYear()} quarterly earnings results transcript investor relations`,
      include_domains: [root], max_results: 5, search_depth: "basic", include_answer: false, include_raw_content: false }) });
  const data = JSON.parse(new TextDecoder().decode(await readBounded(response, 128000, signal)));
  return (Array.isArray(data.results) ? data.results.slice(0, 5) : []).map((item) => {
    const url = officialSourceUrl(item.url, site); if (!url) return null;
    const title = managementText(item.title, 300), period = officialReportPeriod(title), m = period.match(/(20\d{2}) Q([1-4])/);
    return { url, title, score: m ? Number(m[1]) * 4 + Number(m[2]) : 0, call: /transcript|prepared.remarks/i.test(title) };
  }).filter(Boolean);
}

export async function fetchOfficialManagementResearch(symbol, options = {}, env = {}) {
  if (!env.LONGBRIDGE_APP_KEY || !env.LONGBRIDGE_APP_SECRET || !env.LONGBRIDGE_ACCESS_TOKEN) return { status: "not_configured", sources: [] };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 18000);
  const fetcher = options.fetchImpl || fetch, signal = controller.signal, now = options.now || Date.now();
  let site = null, requests = 0;
  const finish = (status, sources = []) => ({ status, sources, ...(site ? { site: cleanOfficialSite(site, symbol) } : {}) });
  try {
    const get = options.get || ((path, query) => signedGet(env, path, query, { signal, maxBytes: 256000, fetchImpl: options.fetchImpl }));
    const lp = tencentToLongport(symbol); if (!lp) return finish("empty");
    const profile = await get("/v1/quote/comp-overview", `symbol=${encodeURIComponent(lp)}`);
    if (profile?.code !== 0) return finish("unavailable");
    const d = profile.data || {}, rawWebsite = typeof d.website === "string" ? d.website.trim() : "";
    const website = publicManagementUrl(rawWebsite.replace(/^http:/i, "https:").replace(/^(?!https?:\/\/)/i, "https://"));
    if (!website) return finish("empty");
    const name = managementText(d.company_name || d.name, 100); if (!name) return finish("empty");
    const stem = new URL(website).hostname.replace(/^www\./, "").split(".")[0];
    const shortName = name.replace(/,?\s+\b(?:Limited|Ltd\.?|Inc\.?|Corporation|Corp\.?|Holdings?|Group|Company|Co\.?)\b\.?/gi, "").trim();
    site = { symbol, website, irUrl: website, name, origin: "longbridge_company_profile", linkedHosts: [],
      aliases: [...new Set([name, shortName, managementText(d.name, 100), stem.length >= 3 ? stem : ""].filter((s) => s.length >= 2))].slice(0, 5) };
    const knownSite = cleanOfficialSite(options.knownSite, symbol);
    if (knownSite?.website === website) { site.irUrl = knownSite.irUrl; site.linkedHosts = knownSite.linkedHosts; }
    const request = async (initialUrl, limit) => {
      let url = officialSourceUrl(initialUrl, site); if (!url) throw new Error("official_host_rejected");
      for (let hop = 0; hop <= 2; hop++) {
        signal.throwIfAborted(); if (++requests > 18) throw new Error("official_request_limit");
        const response = await fetcher(url, { signal, redirect: "manual" });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location"); await response.body?.cancel();
          const next = location && officialSourceUrl(new URL(location, url).href, site);
          if (!next) throw new Error("official_redirect_rejected"); url = next; continue;
        }
        return { bytes: await readBounded(response, limit, signal), url };
      }
      throw new Error("official_redirect_limit");
    };
    const searchP = searchOfficialLinks(env, site, fetcher, signal, now).catch(() => []);
    const candidates = [], visited = new Set(), pages = [...new Set([site.irUrl, website])]; let failed = false, scriptsRead = 0;
    // Follow a small number of actual IR links. Nothing is executed from a page.
    for (let pageIndex = 0; pageIndex < pages.length && pageIndex < 4; pageIndex++) {
      const current = pages[pageIndex]; if (visited.has(current)) continue; visited.add(current);
      try {
        const { bytes, url } = await request(current, 1024000), html = new TextDecoder().decode(bytes);
        candidates.push(...discoverOfficialLinks(html, url, site));
        const entrances = discoverIrEntrances(html, url, site);
        for (const entrance of entrances) {
          if (!officialSourceUrl(entrance.url, site)) {
            if (site.irUrl !== site.website) continue;
            site.irUrl = entrance.url;
          } else if (site.irUrl === site.website) site.irUrl = entrance.url;
          if (!pages.includes(entrance.url)) pages.push(entrance.url);
        }
        // Some IR directories render from a public JSON API referenced by their
        // page-specific JS. Read URLs only; never evaluate downloaded JavaScript.
        if (!candidates.some((c) => c.call) && scriptsRead < 2) {
          for (const m of html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)) {
            const script = new URL(decodeHtml(m[1]), url).href;
            if (!/investor|quarter|financial|results/i.test(script) || !officialSourceUrl(script, site) || scriptsRead >= 2) continue;
            scriptsRead++;
            try {
              const js = new TextDecoder().decode((await request(script, 512000)).bytes);
              const apiPath = js.match(/["'](\/api\/(?:financial|investor|earnings|results)[a-z0-9/_-]*)["']/i)?.[1];
              if (!apiPath) continue;
              const apiUrl = new URL(apiPath, url).href, json = JSON.parse(new TextDecoder().decode((await request(apiUrl, 512000)).bytes));
              candidates.push(...discoverCatalogDocuments(json, apiUrl, site, now));
            } catch { /* Other static IR links remain usable. */ }
          }
        }
        if (candidates.some((c) => c.call && c.score > 0)) break;
      } catch { failed = true; }
      if (signal.aborted) break;
    }
    candidates.push(...await searchP);
    const rank = (a, b) => b.score - a.score || Number(b.call) - Number(a.call) || Number(b.release) - Number(a.release);
    const queue = [...new Map(candidates.map((item) => [item.url, item])).values()].sort(rank).slice(0, 5), sources = [], read = new Set();
    for (let index = 0; index < queue.length && index < 5; index++) {
      const candidate = queue[index]; if (read.has(candidate.url)) continue; read.add(candidate.url);
      try {
        let cached = await options.documentStore?.getDocument(symbol, candidate.url, now);
        if (cached && !officialSourceUrl(cached.url, site)) cached = null;
        let url, pdf, html = "", textPages, retrievedAt;
        if (cached && officialSourceUrl(cached.url, site)) {
          url = cached.url; pdf = cached.format === "pdf"; textPages = cached.pages; retrievedAt = cached.fetchedAt;
        } else {
          const response = await request(candidate.url, /\.pdf(?:$|\?)/i.test(candidate.url) ? MAX_PDF_BYTES : 1024000);
          url = response.url; pdf = new TextDecoder().decode(response.bytes.slice(0, 5)) === "%PDF-";
          html = pdf ? "" : new TextDecoder().decode(response.bytes);
          textPages = pdf ? await (options.extractPdf || extractOfficialPdf)(response.bytes, { signal }) : [officialHtmlText(html)];
          retrievedAt = new Date(now).toISOString();
        }
        const header = managementText(textPages[0], 1400), reportPeriod = officialReportPeriod(header);
        if (!reportPeriod) {
          if (!pdf && queue.length < 8) queue.splice(index + 1, 0, ...discoverOfficialLinks(html, url, site).sort(rank).slice(0, 3));
          continue;
        }
        if (candidate.expectedPeriod && candidate.expectedPeriod.replace(/^FY/, "") !== reportPeriod.replace(/^FY/, "")) { failed = true; continue; }
        const publishedAt = cached?.publishedAt || (pdf ? candidate.publishedAt || "" : officialHtmlDate(html));
        if (publishedAt && Date.parse(publishedAt) > now) continue;
        if (/will (?:announce|release|report)|to (?:announce|release|report).*results|earnings (?:date|schedule)/i.test(header.slice(0, 400))) continue;
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
        const id = "official-" + [...new Uint8Array(hash).slice(0, 12)].map((n) => n.toString(16).padStart(2, "0")).join("");
        const document = { id, url, title: `${site.name} ${reportPeriod} · ${candidate.title || "Results"}`, sourceType: "official",
          publisher: site.name, reportPeriod, publishedAt, retrievedAt, documentType: candidate.call || /prepared remarks|earnings call transcript/i.test(header) ? "earnings_call" : "earnings_release" };
        const source = officialDocumentSource(document, textPages, { site, format: pdf ? "pdf" : "html" });
        signal.throwIfAborted(); sources.push(source);
        if (!cached) await options.documentStore?.putDocument(symbol, candidate.url, { url, pages: textPages, format: pdf ? "pdf" : "html", fetchedAt: retrievedAt, publishedAt }, now);
        // A current, explicitly dated catalog call needs no older fallback reads.
        if (candidate.call && candidate.score > 0) break;
      } catch { failed = true; }
      if (signal.aborted) break;
    }
    sources.sort((a, b) => b.reportPeriod.replace("FY", "").localeCompare(a.reportPeriod.replace("FY", "")) || b.publishedAt.localeCompare(a.publishedAt));
    return finish(sources.length ? "ok" : failed || signal.aborted ? "unavailable" : "empty", sources.slice(0, 1));
  } catch { return finish("unavailable"); }
  finally { clearTimeout(timer); }
}
