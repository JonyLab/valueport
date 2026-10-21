import { describe, it, expect, vi } from "vitest";
import { fetchOfficialManagementResearch, officialDocumentSource, officialReportPeriod, officialFilingPeriod, officialHtmlText, discoverIrEntrances, discoverOfficialLinks, discoverCatalogDocuments, extractOfficialPdf, secExhibitUrl } from "../src/official-management-research.js";
import { cleanManagementResearch, cleanOfficialSite, managementReferences, officialSourceUrl, publicManagementUrl } from "../public/shared/valuation/management-research.js";
import { officialReasonText } from "../public/shared/valuation/management-research-ui.js";
import { fetchManagementResearch } from "../src/management-research.js";
import { textPdf } from "../test-helpers/pdf.js";

const env = { LONGBRIDGE_APP_KEY: "test", LONGBRIDGE_APP_SECRET: "test", LONGBRIDGE_ACCESS_TOKEN: "test" };
const now = Date.parse("2026-10-21T08:00:00Z");
const site = () => ({ symbol: "usNEW", name: "Example Limited", website: "https://www.example.com/", irUrl: "https://www.example.com/investors/", origin: "longbridge_company_profile", aliases: ["Example"], linkedHosts: [] });
const pages = ["Q2 2026 Earnings Prepared Remarks\nExample Limited welcomes investors. We have CEO Jane Smith on this call.\nJane:\nStarting with Commerce.\nWe expect revenue to grow 20 percent in the full year, while logistics investment will continue to support our customers and improve unit costs.",
  "2\nOur credit loan book reached 1 billion dollars and the NPL ratio was stable at 1 percent, reflecting our risk controls and disciplined lending.\nWe are now ready to open the call to questions."];
const document = { id: "official-example-q2", sourceType: "official", url: "https://www.example.com/investors/q2.pdf", title: "Example earnings call", reportPeriod: "2026 Q2", publishedAt: "2026-08-11", documentType: "earnings_call" };
const profile = async (path) => path === "/v1/quote/comp-overview" ? { code: 0, data: { name: "Example", company_name: "Example Limited", website: "www.example.com" } } : { code: 0, data: { items: [] } };
const html = '<html><head><meta property="article:published_time" content="2026-08-11"></head><body><article><h1>Example Reports Second Quarter 2026 Results</h1><p>Revenue grew 20 percent and operating profit reached 500 million dollars, driven by improvements in customer retention and logistics costs.</p><p>We expect revenue growth to continue for the full year, while capital investment will fund the capacity required to serve our customers.</p></article></body></html>';

describe("on-demand official entry discovery", () => {
  it("discovers a never-registered ticker from its signed profile, reads original HTML and keeps page numbers unknown", async () => {
    const calls = [], fetchImpl = async (url, init) => {
      calls.push(url); expect(init.redirect).toBe("manual"); expect(init.headers?.authorization).toBeUndefined();
      if (url === "https://www.example.com/") return new Response('<a href="/investors/">Investor Relations</a>');
      if (url === "https://www.example.com/investors/") return new Response('<a href="/news/q2">Second Quarter 2026 Results</a>');
      if (url === "https://www.example.com/news/q2") return new Response(html);
      throw new Error("unexpected");
    };
    const result = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl }, env);
    expect(result.status).toBe("ok"); expect(result.site.website).toBe("https://www.example.com/");
    expect(result.sources[0]).toMatchObject({ reportPeriod: "2026 Q2", format: "html", pageCount: null, publishedAt: "2026-08-11" });
    expect(result.sources[0].passages.every((p) => p.page === null && p.speaker === "")).toBe(true);
    expect(calls).toContain("https://www.example.com/news/q2");
  });

  it("discovers public JSON directories from page-specific JS without evaluating scripts or hardcoding the issuer", async () => {
    const calls = [], pdfUrl = "https://cdn.example-assets.com/2026.08.11-Example-Transcript.pdf";
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url === "https://www.example.com/") return new Response('<a href="/investor/quarterlyresults">Investor Relations</a>');
      if (url.endsWith("/investor/quarterlyresults")) return new Response('<script src="/chunks/investor/quarterly/page.js"></script>');
      if (url.endsWith("/page.js")) return new Response('fetch("/api/financial/resource"); throw new Error("must not execute")');
      if (url.endsWith("/api/financial/resource")) return Response.json([{ year: 2026, data: [{ quarter: "Q2", transcript: pdfUrl }] }]);
      if (url === pdfUrl) return new Response("%PDF-test");
      throw new Error("unexpected");
    };
    const result = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl, extractPdf: async () => pages }, env);
    expect(result.status).toBe("ok"); expect(result.sources[0].documentType).toBe("prepared_remarks");
    expect(result.site.linkedHosts).toContain("cdn.example-assets.com"); expect(calls).toContain(pdfUrl);
    expect(result.sources[0].publishedAt).toBe("2026-08-11");
  });

  it("rejects a catalog document whose original report period differs from the selected quarter", async () => {
    const fetchImpl = async (url) => {
      if (url === "https://www.example.com/") return new Response('<script src="/quarterly/page.js"></script>');
      if (url.endsWith("/page.js")) return new Response('fetch("/api/financial/resource")');
      if (url.endsWith("/api/financial/resource")) return Response.json([{ year: 2026, data: [{ quarter: "Q3", transcript: "https://www.example.com/2026.08.11-call.pdf" }] }]);
      return new Response("%PDF-test");
    };
    const result = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl, extractPdf: async () => pages }, env);
    expect(result.status).toBe("unavailable"); expect(result.sources).toEqual([]);
  });

  it("reuses saved IR entries and original page text without downloading or parsing the same PDF again", async () => {
    const documents = new Map(), calls = [];
    const documentStore = { getDocument: async (_, url) => documents.get(url) || null, putDocument: async (_, url, value) => { documents.set(url, value); } };
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url === "https://www.example.com/") return new Response('<a href="/investors/">Investor Relations</a>');
      if (url.endsWith("/investors/")) return new Response('<a href="/q2.pdf">Example Q2 2026 Earnings Call Transcript</a>');
      return new Response("%PDF-test");
    };
    const extractPdf = vi.fn(async () => pages);
    const first = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl, extractPdf, documentStore }, env);
    expect(first.status).toBe("ok"); calls.length = 0;
    const second = await fetchOfficialManagementResearch("usNEW", { now: now + 3600000, get: profile, fetchImpl, extractPdf, documentStore, knownSite: first.site }, env);
    expect(second.status).toBe("ok"); expect(extractPdf).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain("https://www.example.com/q2.pdf"); expect(calls).not.toContain("https://www.example.com/");
    expect(second.sources[0].retrievedAt).toBe(first.sources[0].retrievedAt);
  });

  it("uses search only for discovery, confines results to the registered site and never promotes search snippets", async () => {
    const fetchImpl = async (url, init) => {
      if (url === "https://api.tavily.com/search") {
        const body = JSON.parse(init.body); expect(body.include_domains).toEqual(["example.com"]); expect(body.query).not.toMatch(/holdings|portfolio|secret/i);
        return Response.json({ results: [{ url: "https://www.example.com/news/q2", title: "Example Q2 2026 Results", content: "INVENTED SEARCH GUIDANCE" }, { url: "https://third-party.com/earnings", title: "Example Q3 2026" }] });
      }
      if (url === "https://www.example.com/news/q2") return new Response(html);
      return new Response("blocked", { status: 403 });
    };
    const result = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl }, { ...env, TAVILY_API_KEY: "test-search" });
    expect(result.status).toBe("ok"); expect(JSON.stringify(result)).not.toMatch(/INVENTED|third-party|test-search/);
  });

  it("rejects private hosts and off-site redirects, while allowing a linked PDF CDN and an explicitly linked IR platform", async () => {
    for (const url of ["http://example.com", "https://127.1/", "https://[::1]/", "https://x.local/", "https://u:p@example.com/", "javascript:alert(1)"]) expect(publicManagementUrl(url)).toBeNull();
    const s = site(); expect(officialSourceUrl("https://example.com.evil.org/x", s)).toBeNull();
    expect(discoverIrEntrances('<a href="https://ir-platform.example.org/">Investor Relations</a><a href="https://evil.org/">News</a>', s.website, s)).toEqual([{ url: "https://ir-platform.example.org/", score: 2 }]);
    const links = discoverOfficialLinks('<a href="https://cdn.example-assets.com/q2.pdf">Example Q2 2026 earnings release</a>', s.irUrl, s);
    expect(links).toHaveLength(1); expect(officialSourceUrl(links[0].url, s)).toBe(links[0].url);
    const result = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://private.internal/" } }) }, env);
    expect(result.status).toBe("unavailable");
  });

  it("degrades safely when company metadata, website or source content is absent", async () => {
    const unused = vi.fn();
    expect((await fetchOfficialManagementResearch("usNEW", { get: unused }, {})).status).toBe("not_configured"); expect(unused).not.toHaveBeenCalled();
    expect((await fetchOfficialManagementResearch("usNEW", { get: async () => ({ code: 403 }) }, env)).status).toBe("unavailable");
    expect((await fetchOfficialManagementResearch("usNEW", { get: async () => ({ code: 0, data: { website: "localhost" } }) }, env)).status).toBe("empty");
    for (const response of [new Response("x".repeat(1024001)), new Response("", { status: 403 })]) {
      expect((await fetchOfficialManagementResearch("usNEW", { get: profile, fetchImpl: async () => response }, env)).status).toBe("unavailable");
    }
  });

  it("merges official evidence first and preserves a safe news fallback without changing valuation inputs", async () => {
    const get = async (path) => path === "/v1/quote/comp-overview" ? profile(path)
      : path.endsWith("/NEW.US/news") ? { code: 0, data: { items: [{ id: "101", title: "Example Q2 2026 earnings", url: "https://longbridge.com/news/101" }] } }
      : { code: 0, data: { item: { id: "101", title: "Example Q2 2026 earnings", published_at: String(now / 1000 - 86400), body: "Management expects revenue growth while the company plans to invest in capacity and improve operating cash flow." } } };
    for (const available of [true, false]) {
      const fetchImpl = async (url) => url.includes("longbridge.com") ? new Response("") : url.endsWith("/news/q2") ? new Response(html) : available ? new Response('<a href="/news/q2">Example Q2 2026 earnings results</a>') : new Response("", { status: 403 });
      const result = await fetchManagementResearch(env, "usNEW", "", { now, get, fetchImpl });
      expect(result.status).toBe("ok");
      if (available) { expect(result.sources[0].sourceType).toBe("official"); expect(result.sources[1].id).toBe("101"); expect(result.officialSite.website).toBe("https://www.example.com/"); }
      else { expect(result.officialStatus).toBe("unavailable"); expect(result.sources[0].id).toBe("101"); }
    }
  });
});

describe("official provenance, document boundaries and period semantics", () => {
  it("preserves exact speaker, page and outlook attribution and identifies prepared remarks without Q&A", () => {
    const source = officialDocumentSource(document, pages, { site: site() });
    expect(source).toMatchObject({ documentType: "prepared_remarks", qaCoverage: "not_included", pageCount: 2 });
    expect(source.passages[0]).toMatchObject({ speaker: "Jane Smith", page: 1, kind: "official_guidance", section: "Commerce" });
    expect(source.passages[1]).toMatchObject({ speaker: "Jane Smith", page: 2 });
    const snapshot = cleanManagementResearch({ status: "ok", symbol: "usNEW", officialSite: site(), sources: [source] });
    expect(cleanManagementResearch(snapshot)).toEqual(snapshot);
    expect(managementReferences(snapshot)[0]).toMatch(/官方资料 M1.*Jane Smith.*p\.1.*#page=1/);
    expect(snapshot.sources[0].passages[0].excerpt).toBe(source.passages[0].excerpt);
  });

  it("does not label an announced Q&A as included, and rejects mismatched company or report period", () => {
    expect(officialDocumentSource(document, [pages[0] + "\nThis will be followed by a Q&A session."], { site: site() }).qaCoverage).toBe("unknown");
    expect(officialDocumentSource(document, [...pages, "Questions and Answers\nJane:\nRevenue expectations for the current year remain subject to market demand and continued investment in our logistics network."], { site: site() }).qaCoverage).toBe("included");
    expect(() => officialDocumentSource({ ...document, reportPeriod: "2026 Q3" }, pages, { site: site() })).toThrow(/mismatch/);
    expect(() => officialDocumentSource(document, pages, { site: { ...site(), aliases: ["Other Company"] } })).toThrow(/mismatch/);
  });

  it("keeps fiscal years explicit, ignores guidance-only years, and strips executable HTML", () => {
    expect(officialReportPeriod("First Quarter of Fiscal 2027 Results")).toBe("FY2027 Q1");
    expect(officialReportPeriod("Microsoft FY2026 Q4 Earnings")).toBe("FY2026 Q4");
    expect(officialReportPeriod("2026年第二季度业绩")).toBe("2026 Q2");
    expect(officialReportPeriod("Expected revenue growth in 2027")).toBe("");
    expect(officialHtmlText('<script>INJECT</script><nav>MENU</nav><article><h1>Example Q2 2026</h1><p>Revenue &amp; margin</p></article>')).not.toMatch(/INJECT|MENU/);
  });

  it("discovers catalogs generically, orders by explicit quarter and rejects future publication dates", () => {
    const s = site();
    const docs = discoverCatalogDocuments([{ year: 2026, data: [{ quarter: "Q1", transcript: "https://cdn.example-assets.com/2026.05.12-call.pdf" }, { quarter: "Q2", transcript: "https://cdn.example-assets.com/2026.08.11-call.pdf" }, { quarter: "Q3", transcript: "https://cdn.example-assets.com/2026.11.12-call.pdf" }] }], s.irUrl, s, now);
    expect(docs.map((d) => d.score)).toEqual([8106, 8105]);
    expect(docs[0].publishedAt).toBe("2026-08-11");
  });

  it("requires a discovered website before restoring official labels and bounds page numbers and speaker text", () => {
    const source = officialDocumentSource(document, pages, { site: site() });
    expect(cleanManagementResearch({ status: "ok", symbol: "usNEW", sources: [source] }).sources).toEqual([]);
    const clean = cleanManagementResearch({ status: "ok", symbol: "usNEW", officialSite: site(), sources: [{ ...source, passages: [{ kind: "official_guidance", excerpt: "Company outlook", page: 999, speaker: "<b>Jane</b>" }] }] });
    expect(clean.sources[0].passages[0]).toMatchObject({ page: null, speaker: "Jane" });
  });

  it("parses original PDF fixtures page by page and rejects excessive pages, non-PDF data and aborted extraction", async () => {
    const output = await extractOfficialPdf(textPdf(pages.map((page) => page.split("\n"))));
    expect(output).toHaveLength(2); expect(output[0]).toContain("Jane:"); expect(output[1]).toContain("NPL");
    await expect(extractOfficialPdf(textPdf(Array.from({ length: 41 }, () => ["Too many pages"])))).rejects.toThrow(/too_many_pages/);
    await expect(extractOfficialPdf(new TextEncoder().encode("<html>not a PDF</html>"))).rejects.toThrow(/invalid/);
    const controller = new AbortController(); controller.abort();
    await expect(extractOfficialPdf(textPdf([["Example"]]), { signal: controller.signal })).rejects.toThrow();
  });
});

describe("regulator fallbacks (SEC EDGAR / HKEXnews) and diagnosable reasons", () => {
  const secIndex = (doc) => `<table><tr><td>1</td><td>8-K</td><td><a href="/ix?doc=/Archives/edgar/data/1234567/000123456726000018/new-20260730.htm">new-20260730.htm</a></td><td>8-K</td></tr>
    <tr class="evenRow"><td>2</td><td>EX-99.1</td><td><a href="/Archives/edgar/data/1234567/000123456726000018/${doc}">${doc}</a></td><td>EX-99.1</td></tr></table>`;
  const exhibit = '<html><body><p>Exhibit 99.1</p><p>Example reports fourth quarter results</p><p>Example Corp. today announced results for the quarter ended June 30, 2026.</p>'
    + "<p>Revenue was 90 billion dollars and increased 18 percent in the fourth quarter of fiscal year 2026, while operating income and cash flow grew with cloud demand.</p>"
    + "<p>We expect capital investment to continue growing in the next fiscal year to support capacity for customer demand and revenue growth.</p></body></html>";
  const submissions = { filings: { recent: { form: ["10-K", "8-K", "8-K"], items: ["", "5.07", "2.02,9.01"],
    accessionNumber: ["0001234567-26-000020", "0001234567-26-000019", "0001234567-26-000018"], filingDate: ["2026-08-01", "2026-07-31", "2026-07-30"], reportDate: ["", "", "2026-07-30"] } } };
  const secFetch = (calls, overrides = {}) => async (url, init) => {
    calls.push({ url, ua: init.headers?.["user-agent"] });
    if (url.startsWith("https://www.example.com/")) return new Response("Too Many Requests", { status: 429 });
    if (url === "https://www.sec.gov/files/company_tickers.json") return Response.json({ 0: { cik_str: 1234567, ticker: "NEW", title: "EXAMPLE CORP" }, 1: { cik_str: 7654321, ticker: "OTHER", title: "Other Inc" } });
    if (url === "https://data.sec.gov/submissions/CIK0001234567.json") return Response.json(overrides.submissions || submissions);
    if (url.endsWith("/000123456726000018/0001234567-26-000018-index.htm")) return new Response(secIndex("ex991.htm"));
    if (url.endsWith("/000123456726000018/ex991.htm")) return new Response(exhibit);
    throw new Error("unexpected " + url);
  };

  it("falls back to the SEC 8-K Item 2.02 Exhibit 99.1 when the IR site blocks automated access", async () => {
    const calls = [], result = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl: secFetch(calls) }, env);
    expect(result.status).toBe("ok"); expect(result.reason).toBeUndefined();
    expect(result.sources[0]).toMatchObject({ url: "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000018/ex991.htm", reportPeriod: "FY2026 Q4",
      publishedAt: "2026-07-30", documentType: "earnings_release", sourceType: "official", publisher: "Example Limited", format: "html", qaCoverage: "not_included" });
    expect(result.site.secCik).toBe("1234567");
    // SEC requests declare an automated client; IR pages keep browser-like headers.
    expect(calls.filter((c) => /sec\.gov/.test(c.url)).every((c) => /^ValuePort research bot/.test(c.ua))).toBe(true);
    expect(calls.find((c) => c.url.startsWith("https://www.example.com/")).ua).toMatch(/Mozilla/);
    const clean = cleanManagementResearch({ status: "ok", symbol: "usNEW", officialSite: result.site, sources: result.sources });
    expect(clean.sources[0].url).toBe(result.sources[0].url);
  });

  it("reports stage reasons when neither IR nor SEC yields a document, and they survive cleaning and merging", async () => {
    const empty = { filings: { recent: { form: ["8-K"], items: ["5.07"], accessionNumber: ["0001234567-26-000019"], filingDate: ["2026-07-31"] } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl: secFetch([], { submissions: empty }) }, env);
    expect(result).toMatchObject({ status: "unavailable", reason: "ir_blocked_429,sec_no_filings", sources: [] });
    expect(warn.mock.calls.some(([line]) => /usNEW .*reason=ir_blocked_429,sec_no_filings/.test(line))).toBe(true);
    warn.mockRestore();
    const merged = await fetchManagementResearch(env, "usNEW", "", { now, get: profile, fetchImpl: secFetch([], { submissions: empty }) });
    expect(merged.officialReason).toBe("ir_blocked_429,sec_no_filings");
    expect(cleanManagementResearch({ status: "empty", symbol: "usNEW", officialReason: "ir_blocked_429,<script>,timeout_999,sec_no_filings" }).officialReason).toBe("ir_blocked_429,sec_no_filings");
    expect(officialReasonText("ir_blocked_429,sec_no_filings")).toBe("公司投资者关系网站拒绝了自动访问（429）；已尝试 SEC 公告，暂未找到业绩公告。");
    expect(officialReasonText("ir_no_documents,hkex_unavailable", "en")).toMatch(/^The IR page .*tried HKEXnews, but it could not be reached\.$/);
    expect(officialReasonText("bogus")).toBe("");
  });

  it("caps the IR phase so a hanging IR site still leaves time for the SEC fallback", async () => {
    const base = secFetch([]), fetchImpl = (url, init) => url.startsWith("https://www.example.com/")
      ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })) : base(url, init);
    const result = await fetchOfficialManagementResearch("usNEW", { now, get: profile, fetchImpl, irTimeoutMs: 30 }, env);
    expect(result.status).toBe("ok"); expect(result.sources[0].url).toMatch(/^https:\/\/www\.sec\.gov\//);
    const noFilings = { filings: { recent: { form: [], items: [], accessionNumber: [], filingDate: [] } } }, base2 = secFetch([], { submissions: noFilings });
    const slow = await fetchOfficialManagementResearch("usNEW", { now, get: profile, irTimeoutMs: 30, fetchImpl: (url, init) => url.startsWith("https://www.example.com/")
      ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })) : base2(url, init) }, env);
    expect(slow).toMatchObject({ status: "unavailable", reason: "timeout,sec_no_filings" });
  });

  it("falls back to HKEXnews results announcements for HK symbols, reading only the opening pages", async () => {
    const calls = [], pdfUrl = "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0818/2026081801014.pdf";
    const rows = [{ LONG_TEXT: "Announcements and Notices - [Date of Board Meeting]", STOCK_CODE: "09999", TITLE: "DATE OF BOARD MEETING", FILE_LINK: "/listedco/listconews/sehk/2026/0717/2026071700987.pdf", FILE_INFO: "490KB", DATE_TIME: "17/07/2026 19:00" },
      { LONG_TEXT: "Announcements and Notices - [Interim Results]", STOCK_CODE: "09999", TITLE: "RESULTS ANNOUNCEMENT FOR THE THREE AND SIX MONTHS ENDED JUNE 30, 2026", FILE_LINK: "/listedco/listconews/sehk/2026/0818/2026081801014.pdf", FILE_INFO: "6.5MB", DATE_TIME: "18/08/2026 17:25" }];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url === "https://www.example.com/") return new Response("<p>No investor links here</p>");
      if (url.startsWith("https://www1.hkexnews.hk/search/prefix.do")) { expect(url).toContain("name=09999"); return new Response('callback({"more":"1","stockInfo":[{"stockId":190371,"code":"09999","name":"EXAMPLE-W"}]});'); }
      if (url.startsWith("https://www1.hkexnews.hk/search/titleSearchServlet.do")) { expect(url).toContain("stockId=190371"); return Response.json({ result: JSON.stringify(rows) }); }
      if (url === pdfUrl) return new Response("%PDF-hkex");
      throw new Error("unexpected " + url);
    };
    // The announcement heading carries only a logo; issuer identity comes from the HKEX index.
    const hkPages = ["Hong Kong Exchanges and Clearing Limited take no responsibility for the contents of this announcement.\nRESULTS ANNOUNCEMENT FOR THE THREE AND SIX MONTHS ENDED JUNE 30, 2026\nRevenue grew 20 percent to 100 billion and gross profit margin improved, driven by smartphone shipments and lower component costs.",
      "We expect investment in research and capacity to continue growing in the second half, supporting revenue growth in new businesses."];
    const extractPdf = vi.fn(async () => hkPages);
    const result = await fetchOfficialManagementResearch("hk09999", { now, get: profile, fetchImpl, extractPdf }, env);
    expect(result.status).toBe("ok");
    expect(result.sources[0]).toMatchObject({ url: pdfUrl, reportPeriod: "2026 Q2", publishedAt: "2026-08-18", documentType: "earnings_release", format: "pdf", pageCount: 2 });
    expect(extractPdf.mock.calls[0][1]).toMatchObject({ firstPages: 15, maxBytes: 12 * 1024 * 1024 });
    expect(calls).not.toContain("https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0717/2026071700987.pdf");
    expect(cleanManagementResearch({ status: "ok", symbol: "hk09999", officialSite: result.site, sources: result.sources }).sources).toHaveLength(1);
  });

  it("reports hkex_no_filings and ir_not_found when nothing is listed", async () => {
    const fetchImpl = async (url) => url === "https://www.example.com/" ? new Response("<p>Home</p>")
      : url.includes("prefix.do") ? new Response('callback({"stockInfo":[{"stockId":1,"code":"09999","name":"EXAMPLE"}]});')
        : url.includes("titleSearchServlet") ? Response.json({ result: "null" }) : new Response("", { status: 404 });
    const result = await fetchOfficialManagementResearch("hk09999", { now, get: profile, fetchImpl }, env);
    expect(result).toMatchObject({ status: "empty", reason: "ir_not_found,hkex_no_filings" });
  });

  it("only accepts exact regulator document paths bound to the issuer", () => {
    const us = { ...site(), secCik: "1234567" }, hk = { ...site(), symbol: "hk09999" };
    expect(officialSourceUrl("https://www.sec.gov/Archives/edgar/data/1234567/000123456726000018/ex991.htm", us)).toBeTruthy();
    expect(officialSourceUrl("https://www.sec.gov/Archives/edgar/data/0001234567/000123456726000018/ex991.htm", us)).toBeTruthy();
    for (const url of ["https://www.sec.gov/Archives/edgar/data/7654321/000123456726000018/ex991.htm", "https://www.sec.gov/cgi-bin/browse-edgar?CIK=1234567",
      "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000018/ex991.htm?x=1", "https://sec.gov.evil.org/Archives/edgar/data/1234567/000123456726000018/ex991.htm",
      "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0818/2026081801014.pdf"]) expect(officialSourceUrl(url, us)).toBeNull();
    expect(officialSourceUrl("https://www.sec.gov/Archives/edgar/data/1234567/000123456726000018/ex991.htm", site())).toBeNull();
    expect(officialSourceUrl("https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0818/2026081801014.pdf", hk)).toBeTruthy();
    expect(officialSourceUrl("https://www1.hkexnews.hk/search/titlesearch.xhtml", hk)).toBeNull();
    expect(cleanOfficialSite({ ...us, symbol: "usNEW" }, "usNEW").secCik).toBe("1234567");
    expect(cleanOfficialSite({ ...hk, secCik: "1234567" }, "hk09999").secCik).toBeUndefined();
    expect(cleanOfficialSite({ ...us, secCik: "12ab" }, "usNEW").secCik).toBeUndefined();
    expect(secExhibitUrl(secIndex("ex991.htm"), us)).toBe("https://www.sec.gov/Archives/edgar/data/1234567/000123456726000018/ex991.htm");
    expect(secExhibitUrl(secIndex("ex991.htm").replace(/1234567/g, "7654321"), us)).toBeNull();
  });

  it("reads HK calendar-quarter titles and body-stated fiscal periods without guessing", () => {
    expect(officialReportPeriod("ANNOUNCEMENT OF THE RESULTS FOR THE THREE AND SIX MONTHS ENDED 30 JUNE 2026")).toBe("2026 Q2");
    expect(officialReportPeriod("RESULTS FOR THE THREE MONTHS ENDED MARCH 31, 2026")).toBe("2026 Q1");
    expect(officialReportPeriod("FOR THE SIX MONTHS ENDED 30 JUNE 2026")).toBe("");
    expect(officialReportPeriod("three months ended June 15, 2026")).toBe("");
    expect(officialFilingPeriod("Example reports fourth quarter results\n\nfor the quarter ended June 30, 2026. Growth in the fourth quarter of fiscal year 2026 was strong.")).toBe("FY2026 Q4");
    expect(officialFilingPeriod("Example reports fourth quarter results\n\nIn the third quarter of fiscal year 2026 we grew.")).toBe("");
  });

  it("checks HKEX for a newer filing when the IR directory only offers a stale quarter", async () => {
    const stalePdf = "https://www.example.com/q1-2025.pdf", newPdf = "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0818/2026081801014.pdf";
    const fetchImpl = async (url) => {
      if (url === "https://www.example.com/") return new Response('<a href="/q1-2025.pdf">Example Q1 2025 Results</a>');
      if (url === stalePdf || url === newPdf) return new Response("%PDF-x");
      if (url.includes("prefix.do")) return new Response('callback({"stockInfo":[{"stockId":1,"code":"09999","name":"EXAMPLE"}]});');
      if (url.includes("titleSearchServlet")) return Response.json({ result: JSON.stringify([{ LONG_TEXT: "[Interim Results]", STOCK_CODE: "09999", TITLE: "RESULTS FOR THE THREE AND SIX MONTHS ENDED 30 JUNE 2026", FILE_LINK: "/listedco/listconews/sehk/2026/0818/2026081801014.pdf", FILE_INFO: "700KB", DATE_TIME: "18/08/2026 17:25" }]) });
      throw new Error("unexpected " + url);
    };
    const body = "\nRevenue grew 20 percent and operating profit margin improved, driven by smartphone shipments and lower component costs.";
    const extractPdf = async (bytes, opts) => opts?.firstPages ? ["Example RESULTS FOR THE THREE AND SIX MONTHS ENDED 30 JUNE 2026" + body] : ["Example Q1 2025 Results" + body];
    const result = await fetchOfficialManagementResearch("hk09999", { now, get: profile, fetchImpl, extractPdf }, env);
    expect(result.sources[0]).toMatchObject({ url: newPdf, reportPeriod: "2026 Q2" });
  });
});
