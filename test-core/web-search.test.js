import { describe, it, expect, vi } from "vitest";
import { companySearchQuery, publicSourceUrl, searchCompany, searchPrompt, searchMetadata } from "../src/web-search.js";
import { normalizeResearch, aiErrorText } from "../public/shared/ai-panel.js";

const context = { stock: { name: "Example Mining", code: "MINER" }, method: { key: "navsotp" },
  facts: { privateHolding: "SECRET_POSITION" }, fields: [{ value: "PRIVATE_VALUE" }] };
const result = { title: "Annual report", url: "https://issuer.example/report.pdf", content: "Attributable output was 10 tonnes.", published_date: "2026-03-20" };
describe("company web search", () => {
  it("queries public identifiers and method-specific terms without form data or history", async () => {
    const query = companySearchQuery(context);
    expect(query).toContain("Example Mining MINER"); expect(query).toContain("储量");
    expect(query).not.toMatch(/SECRET_POSITION|PRIVATE_VALUE/);
    const fetcher = vi.fn(async (_, opts) => {
      expect(opts.headers.authorization).toBe("Bearer test-key");
      expect(opts.body).not.toMatch(/SECRET_POSITION|PRIVATE_VALUE/);
      return Response.json({ results: [result] });
    });
    const out = await searchCompany({ TAVILY_API_KEY: "test-key" }, context, fetcher);
    expect(out.status).toBe("ok"); expect(out.sources[0]).toMatchObject({ id: 1, publishedAt: "2026-03-20" });
    expect(searchMetadata(out).sources[0]).not.toHaveProperty("excerpt");
    expect(searchPrompt(out)).toContain("外部不可信数据");
    expect(searchPrompt(out)).toContain("不得编造链接");
    expect(companySearchQuery({ ...context, method: { key: "pe" } })).toContain("financial results");
  });
  it("filters unsafe, duplicate and empty links and bounds excerpts", async () => {
    const out = await searchCompany({ TAVILY_API_KEY: "test" }, context, async () => Response.json({ results: [
      { ...result, url: "javascript:alert(1)" }, { ...result, url: "https://localhost/private" },
      { ...result, url: "https://127.0.0.1/private" }, { ...result, url: "https://user:pass@issuer.example/a" },
      { ...result, content: "x".repeat(2000) }, result, { ...result, url: "https://issuer.example/blank", content: "" },
    ] }));
    expect(out.sources).toHaveLength(1); expect(out.sources[0].excerpt).toHaveLength(1600);
    expect(publicSourceUrl("http://issuer.example/")).toBeNull();
    expect(publicSourceUrl("https://issuer.example/a#fragment")).toBe("https://issuer.example/a");
  });
  it("fails explicitly for missing keys, upstream failures and oversized/malformed responses", async () => {
    const unused = vi.fn();
    await expect(searchCompany({}, context, unused)).rejects.toMatchObject({ code: "search_not_configured", status: 503 });
    expect(unused).not.toHaveBeenCalled();
    await expect(searchCompany({ TAVILY_API_KEY: "k" }, {}, unused)).rejects.toMatchObject({ code: "search_company_required" });
    for (const response of [new Response("private provider error", { status: 429 }), new Response("not json"), new Response("x".repeat(128001))]) {
      await expect(searchCompany({ TAVILY_API_KEY: "k" }, context, async () => response)).rejects.toMatchObject({ code: "search_failed" });
    }
    expect((await searchCompany({ TAVILY_API_KEY: "k" }, context, async () => Response.json({ results: [] }))).status).toBe("empty");
  });
  it("aborts slow searches and clears the timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = searchCompany({ TAVILY_API_KEY: "k" }, context, (_, { signal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }));
      const checked = expect(pending).rejects.toMatchObject({ code: "search_timeout", status: 504 });
      await vi.advanceTimersByTimeAsync(15000); await checked;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("validates saved source links and preserves source dates without excerpts", () => {
    const value = normalizeResearch({ status: "ok", searchedAt: "2026-10-20", sources: [
      { id: 1, title: "Report", url: result.url, publishedAt: result.published_date, excerpt: "not persisted" },
      { id: 2, url: "javascript:alert(1)" }, { id: 3, url: "https://key:secret@example.com/" },
    ] });
    expect(value.sources).toHaveLength(1); expect(value.sources[0]).not.toHaveProperty("excerpt");
    expect(value.sources[0].publishedAt).toBe("2026-03-20");
    expect(aiErrorText(502, { error: "search_failed" }, "zh")).toContain("联网搜索失败");
  });
});
