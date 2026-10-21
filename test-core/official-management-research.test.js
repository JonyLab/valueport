import { describe, it, expect, vi } from "vitest";
import { fetchOfficialManagementResearch, officialDocumentSource, officialReportPeriod, officialHtmlText, discoverIrEntrances, discoverOfficialLinks, discoverCatalogDocuments, extractOfficialPdf } from "../src/official-management-research.js";
import { cleanManagementResearch, managementReferences, officialSourceUrl, publicManagementUrl } from "../public/shared/valuation/management-research.js";
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
