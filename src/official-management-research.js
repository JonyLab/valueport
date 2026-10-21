import { publicManagementUrl, cleanOfficialSite, sameCompanySite, officialSourceUrl, regulatorFilingUrl, managementText } from "../public/shared/valuation/management-research.js";

import { signedGet, tencentToLongport } from "./longbridge.js";

const MAX_PDF_BYTES = 4 * 1024 * 1024;
// HKEX results announcements are often larger and longer; only their opening pages are read.
const MAX_HKEX_PDF_BYTES = 12 * 1024 * 1024, HKEX_PDF_PAGES = 15;
const TOTAL_BUDGET_MS = 18000, IR_BUDGET_MS = 9000;
// SEC asks automated clients to declare themselves; SEC_USER_AGENT may add a contact address.
const SEC_USER_AGENT = "ValuePort research bot (contact via site)";
// 不带浏览器请求头时，不少 IR 站点（如 investor.apple.com）的反爬会直接返回 429
const BROWSER_HEADERS = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7", "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8" };
const OUTLOOK = /\b(?:expect|guidance|outlook|forecast|optimistic|will|plans?|potential|ahead|future)\b|预计|預計|展望|指引|预期|預期|未来|未來/i;
const OPERATING = /\b(?:revenue|margin|GMV|EBITDA|monetization|take rate|cost|loan|credit|NPL|bookings|profit|cash|investment|capital|logistics|fulfillment|risk|growth)\b|收入|营收|營收|利润|利潤|成本|资本|資本|现金|現金|增长|增長|毛利|信贷|信貸/i;

async function readBounded(response, limit, signal) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Object.assign(new Error("official_unavailable"), { status: response.status }); }
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

export async function extractOfficialPdf(bytes, { signal, maxBytes = MAX_PDF_BYTES, firstPages = 0 } = {}) {
  if (bytes.byteLength > maxBytes) throw new Error("official_pdf_too_large");
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("invalid_official_pdf");
  // Lazy-load only when a discovered document is a PDF; do not load remote resources or JS actions.
  const { getDocumentProxy } = await import("unpdf");
  signal?.throwIfAborted();
  const pdf = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: false, cMapUrl: undefined, standardFontDataUrl: undefined, verbosity: 0 });
  try {
    // firstPages reads a long filing's opening pages (management discussion) instead of rejecting it.
    if (pdf.numPages > 40 && !firstPages) throw new Error("official_too_many_pages");
    const pages = []; let length = 0;
    for (let page = 1; page <= Math.min(pdf.numPages, firstPages || 40); page++) {
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

// Regulator paths pass issuerVerified: the filing came from the regulator's own index
// for this issuer (SEC CIK / HKEX stock id), so a logo-only heading is acceptable.
export function officialDocumentSource(document, pages, { site, format = "pdf", periodFromBody = false, issuerVerified = false } = {}) {
  if (!Array.isArray(pages) || !pages.length || pages.length > 40) throw new Error("invalid_official_pages");
  const opening = pages.slice(0, 2).join("\n"), all = pages.join("\n");
  // Check the actual heading, not a search snippet or filename. Regulator filings
  // may state the period in the opening body text instead.
  const header = managementText(pages[0], 1400);
  const matchesPeriod = (periodFromBody ? officialFilingPeriod(all) : officialReportPeriod(header)) === document.reportPeriod;
  const matchesIssuer = issuerVerified || site?.aliases.some((name) => header.toLowerCase().includes(name.toLowerCase()));
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
  // HK results titles: "THREE (AND SIX) MONTHS ENDED 30 JUNE 2026". The end date is a
  // calendar date, so this is a calendar quarter (no FY prefix), whatever the fiscal year.
  const months = { march: 1, june: 2, september: 3, december: 4 };
  m = s.match(/\bthree(?: and (?:six|nine|twelve))? months(?: and (?:the )?year)? ended (?:(\d{1,2}) (march|june|september|december),? (20\d{2})|(march|june|september|december) (\d{1,2}),? (20\d{2}))\b/i);
  if (m && Number(m[1] || m[5]) >= 28) return `${m[3] || m[6]} Q${months[(m[2] || m[4]).toLowerCase()]}`;
  m = s.match(/截至\s*(20\d{2})\s*年\s*(3|6|9|12)\s*月\s*3[01]\s*日止?(?:三個月|三个月)/);
  if (m) return `${m[1]} Q${Number(m[2]) / 3}`;
  return "";
}

// Regulator filings may name the period only in the body (e.g. "fourth quarter of
// fiscal year 2026"). Use the heading first, then the first explicit period whose
// quarter agrees with any ordinal quarter in the heading.
export function officialFilingPeriod(text) {
  const all = String(text || ""), header = managementText(all, 1400), direct = officialReportPeriod(header);
  const ordinal = header.match(/\b(first|second|third|fourth)[ -]quarter\b/i)?.[1].toLowerCase();
  const want = ordinal ? { first: 1, second: 2, third: 3, fourth: 4 }[ordinal] : 0;
  if (direct && (!want || direct.endsWith(`Q${want}`))) return direct;
  let checked = 0;
  for (const m of all.slice(0, 120000).matchAll(/\b(?:first|second|third|fourth)[ -]quarter\b|\bQ[1-4]\b|\bthree months\b/gi)) {
    if (++checked > 60) break;
    const period = officialReportPeriod(all.slice(Math.max(0, m.index - 40), m.index + 160));
    if (period && (!want || period.endsWith(`Q${want}`))) return period;
  }
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

// Machine reasons are short, stage-prefixed codes (see OFFICIAL_REASONS); never messages or URLs.
const REASON_RANK = ["blocked", "timeout", "pdf_too_large", "pdf_parse_failed", "documents_rejected", "no_documents", "no_filings", "not_found", "not_listed", "unavailable"];
const pickReason = (codes) => [...codes].sort((a, b) => REASON_RANK.findIndex((r) => a.includes(r)) - REASON_RANK.findIndex((r) => b.includes(r)))[0] || "";
function failureReason(error, stage, { pdf = false } = {}) {
  const message = String(error?.message || ""), status = Number(error?.status);
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  if (/pdf_too_large/.test(message) || (pdf && /official_too_large/.test(message))) return "pdf_too_large";
  if ([401, 403, 429].includes(status)) return `${stage}_blocked_${status}`;
  if (/mismatch|no_extractable|invalid_official_pages/.test(message)) return `${stage}_documents_rejected`;
  if (pdf && !(error instanceof TypeError && /fetch|network/i.test(message)) && !/official_unavailable|request_limit|host_rejected|redirect/.test(message)) return "pdf_parse_failed";
  return `${stage}_unavailable`;
}
const officialId = async (url) => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return "official-" + [...new Uint8Array(hash).slice(0, 12)].map((n) => n.toString(16).padStart(2, "0")).join("");
};
const issuerAlias = (raw) => managementText(raw, 100).replace(/,?\s+\b(?:Limited|Ltd\.?|Inc\.?|Corporation|Corp\.?|Holdings?|Group|Company|Co\.?|PLC|N\.?V\.?|S\.?A\.?)\b\.?/gi, "").replace(/-[A-Z]{1,3}$/, "").trim();
function addAlias(site, raw) {
  const alias = issuerAlias(raw);
  if (alias.length >= 3 && !site.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) site.aliases = [...site.aliases.slice(0, 5), alias];
}

// Regulator endpoints are fixed hosts; redirects are refused rather than followed.
const REGULATOR_HOSTS = new Set(["www.sec.gov", "data.sec.gov", "www1.hkexnews.hk"]);
async function regulatorFetch(fetcher, url, limit, signal, headers) {
  const u = new URL(url); if (u.protocol !== "https:" || !REGULATOR_HOSTS.has(u.hostname)) throw new Error("official_host_rejected");
  signal.throwIfAborted();
  const response = await fetcher(u.href, { signal, redirect: "manual", headers });
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw Object.assign(new Error("official_redirect_rejected"), { status: response.status }); }
  return readBounded(response, limit, signal);
}
const utf8 = (bytes) => new TextDecoder().decode(bytes);

// company_tickers.json (~0.8 MB) is reduced to ticker -> [cik, title] and cached
// per isolate, plus the Cache API when running in Workers with the real fetch.
const secTickerMemo = new WeakMap(), SEC_TICKER_KEY = "https://sec-tickers.internal/v1", SEC_TICKER_TTL = 7 * 86400000;
async function secTickerMap(fetcher, get, now) {
  const memo = secTickerMemo.get(fetcher); if (memo && now - memo.at < SEC_TICKER_TTL) return memo.map;
  const cache = fetcher === globalThis.fetch ? globalThis.caches?.default : null;
  let map = null;
  try { const hit = await cache?.match(SEC_TICKER_KEY); if (hit) map = await hit.json(); } catch { map = null; }
  if (!map || typeof map !== "object") {
    const raw = JSON.parse(utf8(await get("https://www.sec.gov/files/company_tickers.json", 3 * 1024 * 1024)));
    map = {};
    for (const item of Object.values(raw || {}).slice(0, 30000)) {
      if (typeof item?.ticker === "string" && /^[A-Z0-9.-]{1,16}$/i.test(item.ticker) && Number.isInteger(item.cik_str) && item.cik_str > 0) map[item.ticker.toUpperCase()] = [item.cik_str, managementText(item.title, 100)];
    }
    await cache?.put(SEC_TICKER_KEY, Response.json(map, { headers: { "cache-control": `public, max-age=${SEC_TICKER_TTL / 1000}` } })).catch(() => {});
  }
  secTickerMemo.set(fetcher, { at: now, map });
  return map;
}

// The filing index names each document's type; take the 8-K's EX-99.1 press release.
export function secExhibitUrl(indexHtml, site) {
  let fallback = null;
  for (const row of String(indexHtml).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => managementText(decodeHtml(c[1].replace(/<[^>]*>/g, " ")), 80));
    const type = cells.find((c) => /^EX-99(?:\.\d+)?$/i.test(c)); if (!type) continue;
    const href = row[1].match(/href=["'](\/Archives\/edgar\/data\/[^"'?#]+\.html?)["']/i)?.[1];
    const url = href && regulatorFilingUrl("https://www.sec.gov" + href, site); if (!url) continue;
    if (/^EX-99\.1$/i.test(type)) return url;
    fallback ||= url;
  }
  return fallback;
}

async function cachedOrFetched(ctx, url, load) {
  const { symbol, now, documentStore, site } = ctx;
  const cached = await documentStore?.getDocument(symbol, url, now);
  if (cached && officialSourceUrl(cached.url, site) === cached.url) return { ...cached, cached: true };
  const loaded = await load();
  return { ...loaded, url, fetchedAt: new Date(now).toISOString(), cached: false };
}

async function secFilingSources(site, ctx) {
  const { fetcher, signal, now, env, symbol } = ctx;
  const headers = { "user-agent": managementText(env.SEC_USER_AGENT, 200) || SEC_USER_AGENT, accept: "application/json,text/html;q=0.9,*/*;q=0.5" };
  const get = (url, limit) => regulatorFetch(fetcher, url, limit, signal, headers);
  const ticker = symbol.slice(2).toUpperCase().replace(/\./g, "-");
  const entry = (await secTickerMap(fetcher, get, now))[ticker];
  if (!Array.isArray(entry)) return { sources: [], reason: "sec_not_listed" };
  const [cik, title] = entry; site.secCik = String(cik); addAlias(site, title);
  const submissions = JSON.parse(utf8(await get(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, 4 * 1024 * 1024)));
  const recent = submissions?.filings?.recent || {}, filings = [], today = new Date(now).toISOString().slice(0, 10);
  for (let i = 0; i < Math.min(recent.form?.length || 0, 1000) && filings.length < 2; i++) {
    const accession = String(recent.accessionNumber?.[i] || ""), filingDate = String(recent.filingDate?.[i] || "");
    if (recent.form[i] !== "8-K" || !/(?:^|,)\s*2\.02\b/.test(String(recent.items?.[i] || "")) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)
      || !/^20\d{2}-\d{2}-\d{2}$/.test(filingDate) || filingDate > today) continue;
    filings.push({ accession, filingDate });
  }
  if (!filings.length) return { sources: [], reason: "sec_no_filings" };
  const reasons = new Set();
  for (const filing of filings) {
    try {
      const folder = `https://www.sec.gov/Archives/edgar/data/${cik}/${filing.accession.replace(/-/g, "")}/`;
      const exhibit = secExhibitUrl(utf8(await get(folder + filing.accession + "-index.htm", 512000)), site);
      if (!exhibit) { reasons.add("sec_documents_rejected"); continue; }
      const doc = await cachedOrFetched({ ...ctx, site }, exhibit, async () => ({ format: "html", publishedAt: filing.filingDate,
        pages: [officialHtmlText(utf8(await get(exhibit, 4 * 1024 * 1024)))] }));
      const reportPeriod = officialFilingPeriod(doc.pages[0]);
      if (!reportPeriod) { reasons.add("sec_documents_rejected"); continue; }
      const document = { id: await officialId(exhibit), url: exhibit, title: `${site.name} ${reportPeriod} · Earnings release (SEC Form 8-K, Exhibit 99)`, sourceType: "official",
        publisher: site.name, reportPeriod, publishedAt: doc.publishedAt || filing.filingDate, retrievedAt: doc.fetchedAt, documentType: "earnings_release" };
      const source = officialDocumentSource(document, doc.pages, { site, format: "html", periodFromBody: true, issuerVerified: true });
      if (!doc.cached) await ctx.documentStore?.putDocument(symbol, exhibit, { url: exhibit, pages: doc.pages, format: "html", fetchedAt: doc.fetchedAt, publishedAt: document.publishedAt }, now);
      return { sources: [source] };
    } catch (error) { reasons.add(failureReason(error, "sec")); if (signal.aborted) break; }
  }
  return { sources: [], failed: [...reasons].some((r) => !/documents_rejected/.test(r)), reason: pickReason(reasons) || "sec_documents_rejected" };
}

const hkexDate = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, "");
async function hkexFilingSources(site, ctx) {
  const { fetcher, signal, now, symbol } = ctx;
  const headers = { ...BROWSER_HEADERS, accept: "application/json,text/javascript,application/pdf,*/*;q=0.5", referer: "https://www1.hkexnews.hk/search/titlesearch.xhtml" };
  const get = (url, limit) => regulatorFetch(fetcher, url, limit, signal, headers);
  const code = symbol.slice(2).replace(/^0+(?=\d)/, "").padStart(5, "0");
  if (!/^\d{5}$/.test(code)) return { sources: [], reason: "hkex_not_listed" };
  const prefix = utf8(await get(`https://www1.hkexnews.hk/search/prefix.do?callback=callback&lang=EN&type=A&name=${code}&market=SEHK`, 64000));
  const stock = JSON.parse(prefix.trim().replace(/^callback\(/, "").replace(/\);?$/, ""))?.stockInfo?.find?.((item) => item?.code === code);
  if (!Number.isInteger(stock?.stockId)) return { sources: [], reason: "hkex_not_listed" };
  addAlias(site, stock.name);
  const list = JSON.parse(utf8(await get(`https://www1.hkexnews.hk/search/titleSearchServlet.do?sortDir=0&sortByOptions=DateTime&category=0&market=SEHK&stockId=${stock.stockId}`
    + `&documentType=-1&fromDate=${hkexDate(now - 400 * 86400000)}&toDate=${hkexDate(now)}&title=&searchType=1&t1code=10000&t2Gcode=3&t2code=-2&rowRange=40&lang=E`, 512000)));
  const rows = typeof list?.result === "string" && list.result !== "null" ? JSON.parse(list.result) : [];
  const filings = (Array.isArray(rows) ? rows.slice(0, 40) : []).filter((row) => /\[(?:Final|Interim|Quarterly) Results\]/i.test(row?.LONG_TEXT || "")
    && String(row.STOCK_CODE || "").includes(code) && /^\/listedco\/listconews\/(?:sehk|gem)\/20\d{2}\/\d{4}\/[A-Za-z0-9_]+\.pdf$/i.test(row.FILE_LINK || "")).slice(0, 2);
  if (!filings.length) return { sources: [], reason: "hkex_no_filings" };
  const reasons = new Set();
  for (const filing of filings) {
    try {
      const url = regulatorFilingUrl("https://www1.hkexnews.hk" + filing.FILE_LINK, site); if (!url) { reasons.add("hkex_documents_rejected"); continue; }
      const size = String(filing.FILE_INFO || "").match(/([\d.]+)\s*(KB|MB)/i), bytes = size ? Number(size[1]) * (size[2].toUpperCase() === "MB" ? 1048576 : 1024) : 0;
      if (bytes > MAX_HKEX_PDF_BYTES) { reasons.add("pdf_too_large"); continue; }
      const date = String(filing.DATE_TIME || "").match(/^(\d{2})\/(\d{2})\/(20\d{2})/), publishedAt = date ? `${date[3]}-${date[2]}-${date[1]}` : "";
      const title = managementText(decodeHtml(filing.TITLE || ""), 160), expected = officialReportPeriod(title);
      const doc = await cachedOrFetched({ ...ctx, site }, url, async () => {
        const pdf = await get(url, MAX_HKEX_PDF_BYTES).catch((error) => { throw /too_large/.test(error?.message) ? new Error("official_pdf_too_large") : error; });
        try { return { format: "pdf", publishedAt, pages: await (ctx.extractPdf || extractOfficialPdf)(pdf, { signal, maxBytes: MAX_HKEX_PDF_BYTES, firstPages: HKEX_PDF_PAGES }) }; }
        catch (error) { throw Object.assign(error, { pdf: true }); }
      });
      const reportPeriod = officialFilingPeriod(doc.pages.join("\n"));
      if (!reportPeriod || (expected && expected !== reportPeriod)) { reasons.add("hkex_documents_rejected"); continue; }
      const document = { id: await officialId(url), url, title: `${site.name} ${reportPeriod} · ${title || "Results announcement"}`, sourceType: "official",
        publisher: site.name, reportPeriod, publishedAt: doc.publishedAt || publishedAt, retrievedAt: doc.fetchedAt, documentType: "earnings_release" };
      const source = officialDocumentSource(document, doc.pages, { site, format: "pdf", periodFromBody: true, issuerVerified: true });
      if (!doc.cached) await ctx.documentStore?.putDocument(symbol, url, { url, pages: doc.pages, format: "pdf", fetchedAt: doc.fetchedAt, publishedAt: document.publishedAt }, now);
      return { sources: [source] };
    } catch (error) { reasons.add(failureReason(error, "hkex", { pdf: !!error?.pdf })); if (signal.aborted) break; }
  }
  return { sources: [], failed: [...reasons].some((r) => !/documents_rejected/.test(r)), reason: pickReason(reasons) || "hkex_documents_rejected" };
}

export async function fetchOfficialManagementResearch(symbol, options = {}, env = {}) {
  if (!env.LONGBRIDGE_APP_KEY || !env.LONGBRIDGE_APP_SECRET || !env.LONGBRIDGE_ACCESS_TOKEN) return { status: "not_configured", sources: [] };
  // The company IR phase gets its own shorter budget so regulator fallbacks still have time.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TOTAL_BUDGET_MS);
  const irController = new AbortController(), irTimer = setTimeout(() => irController.abort(), options.irTimeoutMs ?? IR_BUDGET_MS);
  const stopIr = () => irController.abort(); controller.signal.addEventListener("abort", stopIr, { once: true });
  const fetcher = options.fetchImpl || fetch, signal = controller.signal, irSignal = irController.signal, now = options.now || Date.now();
  let site = null, requests = 0; const stageReasons = [];
  const finish = (status, sources = []) => {
    const reason = sources.length ? "" : [...new Set(stageReasons.filter(Boolean))].slice(0, 3).join(",");
    if (!sources.length) console.warn(`[official-research] ${symbol} status=${status} reason=${reason || "none"}`);
    return { status, sources, ...(reason ? { reason } : {}), ...(site ? { site: cleanOfficialSite(site, symbol) } : {}) };
  };
  try {
    const get = options.get || ((path, query) => signedGet(env, path, query, { signal, maxBytes: 256000, fetchImpl: options.fetchImpl }));
    const lp = tencentToLongport(symbol); if (!lp) return finish("empty");
    const profile = await get("/v1/quote/comp-overview", `symbol=${encodeURIComponent(lp)}`);
    if (profile?.code !== 0) return finish("unavailable");
    const d = profile.data || {}, rawWebsite = typeof d.website === "string" ? d.website.trim() : "";
    const website = publicManagementUrl(rawWebsite.replace(/^http:/i, "https:").replace(/^(?!https?:\/\/)/i, "https://"));
    if (!website) { stageReasons.push("no_company_website"); return finish("empty"); }
    const name = managementText(d.company_name || d.name, 100); if (!name) return finish("empty");
    const stem = new URL(website).hostname.replace(/^www\./, "").split(".")[0];
    const shortName = name.replace(/,?\s+\b(?:Limited|Ltd\.?|Inc\.?|Corporation|Corp\.?|Holdings?|Group|Company|Co\.?)\b\.?/gi, "").trim();
    site = { symbol, website, irUrl: website, name, origin: "longbridge_company_profile", linkedHosts: [],
      aliases: [...new Set([name, shortName, managementText(d.name, 100), stem.length >= 3 ? stem : ""].filter((s) => s.length >= 2))].slice(0, 5) };
    const knownSite = cleanOfficialSite(options.knownSite, symbol);
    if (knownSite?.website === website) { site.irUrl = knownSite.irUrl; site.linkedHosts = knownSite.linkedHosts; }
    const request = async (initialUrl, limit, phaseSignal = irSignal) => {
      let url = officialSourceUrl(initialUrl, site); if (!url) throw new Error("official_host_rejected");
      for (let hop = 0; hop <= 2; hop++) {
        phaseSignal.throwIfAborted(); if (++requests > 18) throw new Error("official_request_limit");
        const response = await fetcher(url, { signal: phaseSignal, redirect: "manual", headers: BROWSER_HEADERS });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location"); await response.body?.cancel();
          const next = location && officialSourceUrl(new URL(location, url).href, site);
          if (!next) throw new Error("official_redirect_rejected"); url = next; continue;
        }
        return { bytes: await readBounded(response, limit, phaseSignal), url };
      }
      throw new Error("official_redirect_limit");
    };
    const irReasons = new Set();
    const searchP = searchOfficialLinks(env, site, fetcher, irSignal, now).catch(() => []);
    const candidates = [], visited = new Set(), pages = [...new Set([site.irUrl, website])]; let failed = false, scriptsRead = 0, pagesLoaded = 0;
    // Follow a small number of actual IR links. Nothing is executed from a page.
    for (let pageIndex = 0; pageIndex < pages.length && pageIndex < 4; pageIndex++) {
      const current = pages[pageIndex]; if (visited.has(current)) continue; visited.add(current);
      try {
        const { bytes, url } = await request(current, 1024000), html = new TextDecoder().decode(bytes); pagesLoaded++;
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
      } catch (error) { failed = true; irReasons.add(failureReason(error, "ir")); }
      if (irSignal.aborted) break;
    }
    candidates.push(...await searchP);
    const rank = (a, b) => b.score - a.score || Number(b.call) - Number(a.call) || Number(b.release) - Number(a.release);
    const queue = [...new Map(candidates.map((item) => [item.url, item])).values()].sort(rank).slice(0, 5), read = new Set();
    let sources = [];
    for (let index = 0; index < queue.length && index < 5 && !irSignal.aborted; index++) {
      const candidate = queue[index]; if (read.has(candidate.url)) continue; read.add(candidate.url);
      let pdf = /\.pdf(?:$|\?)/i.test(candidate.url);
      try {
        let cached = await options.documentStore?.getDocument(symbol, candidate.url, now);
        if (cached && !officialSourceUrl(cached.url, site)) cached = null;
        let url, html = "", textPages, retrievedAt;
        if (cached && officialSourceUrl(cached.url, site)) {
          url = cached.url; pdf = cached.format === "pdf"; textPages = cached.pages; retrievedAt = cached.fetchedAt;
        } else {
          const response = await request(candidate.url, pdf ? MAX_PDF_BYTES : 1024000);
          url = response.url; pdf = new TextDecoder().decode(response.bytes.slice(0, 5)) === "%PDF-";
          html = pdf ? "" : new TextDecoder().decode(response.bytes);
          textPages = pdf ? await (options.extractPdf || extractOfficialPdf)(response.bytes, { signal: irSignal }) : [officialHtmlText(html)];
          retrievedAt = new Date(now).toISOString();
        }
        const header = managementText(textPages[0], 1400), reportPeriod = officialReportPeriod(header);
        if (!reportPeriod) {
          if (!pdf && queue.length < 8) queue.splice(index + 1, 0, ...discoverOfficialLinks(html, url, site).sort(rank).slice(0, 3));
          continue;
        }
        if (candidate.expectedPeriod && candidate.expectedPeriod.replace(/^FY/, "") !== reportPeriod.replace(/^FY/, "")) { failed = true; irReasons.add("ir_documents_rejected"); continue; }
        const publishedAt = cached?.publishedAt || (pdf ? candidate.publishedAt || "" : officialHtmlDate(html));
        if (publishedAt && Date.parse(publishedAt) > now) continue;
        if (/will (?:announce|release|report)|to (?:announce|release|report).*results|earnings (?:date|schedule)/i.test(header.slice(0, 400))) continue;
        const document = { id: await officialId(url), url, title: `${site.name} ${reportPeriod} · ${candidate.title || "Results"}`, sourceType: "official",
          publisher: site.name, reportPeriod, publishedAt, retrievedAt, documentType: candidate.call || /prepared remarks|earnings call transcript/i.test(header) ? "earnings_call" : "earnings_release" };
        const source = officialDocumentSource(document, textPages, { site, format: pdf ? "pdf" : "html" });
        irSignal.throwIfAborted(); sources.push(source);
        if (!cached) await options.documentStore?.putDocument(symbol, candidate.url, { url, pages: textPages, format: pdf ? "pdf" : "html", fetchedAt: retrievedAt, publishedAt }, now);
        // A current, explicitly dated catalog call needs no older fallback reads.
        if (candidate.call && candidate.score > 0) break;
      } catch (error) { failed = true; irReasons.add(failureReason(error, "ir", { pdf })); }
    }
    // A calendar-quarter IR document more than two quarters old is likely a stale
    // directory entry; the regulator filing list is then checked for a newer one.
    const nowDate = new Date(now), currentQuarter = nowDate.getUTCFullYear() * 4 + Math.floor(nowDate.getUTCMonth() / 3) + 1;
    const stale = sources.length > 0 && sources.every((source) => {
      const m = /^(20\d{2}) Q([1-4])$/.exec(source.reportPeriod); return m && currentQuarter - (Number(m[1]) * 4 + Number(m[2])) > 2;
    });
    if (!sources.length || stale) {
      if (!sources.length) {
        if (irSignal.aborted) { failed = true; irReasons.add("timeout"); }
        if (!irReasons.size) irReasons.add(queue.length ? "ir_documents_rejected" : !pagesLoaded ? "ir_unavailable" : site.irUrl !== site.website || pages.length > 2 ? "ir_no_documents" : "ir_not_found");
        stageReasons.push(pickReason(irReasons));
      }
      // Regulator fallbacks: SEC EDGAR 8-K Item 2.02 press releases (US), HKEXnews results announcements (HK).
      const fallback = /^us/.test(symbol) ? secFilingSources : /^hk/.test(symbol) ? hkexFilingSources : null;
      if (fallback && !signal.aborted) {
        const ctx = { fetcher, signal, now, env, symbol, documentStore: options.documentStore, extractPdf: options.extractPdf };
        const stage = fallback === secFilingSources ? "sec" : "hkex";
        const result = await fallback(site, ctx).catch((error) => ({ sources: [], failed: true, reason: failureReason(error, stage) }));
        if (!sources.length) { if (result.failed) failed = true; if (!result.sources.length) stageReasons.push(result.reason); }
        sources = [...sources, ...result.sources];
      }
    }
    sources.sort((a, b) => b.reportPeriod.replace("FY", "").localeCompare(a.reportPeriod.replace("FY", "")) || b.publishedAt.localeCompare(a.publishedAt));
    return finish(sources.length ? "ok" : failed || signal.aborted ? "unavailable" : "empty", sources.slice(0, 1));
  } catch (error) { stageReasons.push(failureReason(error, "ir")); return finish("unavailable"); }
  finally { clearTimeout(timer); clearTimeout(irTimer); controller.signal.removeEventListener("abort", stopIr); }
}
