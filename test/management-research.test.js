import { describe, it, expect } from "vitest";
import { SELF, createExecutionContext, waitOnExecutionContext, fetchMock } from "cloudflare:test";
import { Hono } from "hono";
import { signedGet } from "../src/longbridge.js";
import { registerManagementResearch } from "../src/management-research.js";
import { extractOfficialPdf } from "../src/official-management-research.js";
import { textPdf } from "../test-helpers/pdf.js";

const credentials = { LONGBRIDGE_APP_KEY: "fake-key", LONGBRIDGE_APP_SECRET: "fake-secret", LONGBRIDGE_ACCESS_TOKEN: "fake-token" };

describe("bounded signed news requests", () => {
  it("signs the fixed upstream, supplies cancellation and rejects oversized or redirected responses", async () => {
    const signal = new AbortController().signal;
    const good = await signedGet(credentials, "/v1/content/TEST.US/news", "", { signal, maxBytes: 1000,
      fetchImpl: async (url, options) => {
        expect(url).toBe("https://openapi.longportapp.com/v1/content/TEST.US/news");
        expect(options.redirect).toBe("manual"); expect(options.signal).toBe(signal);
        expect(options.headers["x-api-signature"]).toMatch(/^HMAC-SHA256 /);
        return Response.json({ code: 0, data: { items: [] } });
      } });
    expect(good.code).toBe(0);
    for (const response of [new Response("x".repeat(1001)), new Response("", { status: 302, headers: { location: "https://evil.test" } }), new Response("invalid json")]) {
      await expect(signedGet(credentials, "/v1/content/TEST.US/news", "", { maxBytes: 1000, fetchImpl: async () => response })).rejects.toThrow();
    }
  });
});

describe("management research HTTP route", () => {
  it("extracts PDF text in the actual Workers runtime", async () => {
    const pages = await extractOfficialPdf(textPdf([["Example Q2 2026 Earnings Prepared Remarks", "Jane:", "Revenue grew 20 percent, while operating costs improved."], ["Second page credit risk disclosure"]]));
    expect(pages).toHaveLength(2); expect(pages[0]).toContain("Revenue grew 20 percent"); expect(pages[1]).toContain("credit risk");
  });
  it("requires login before any upstream request", async () => {
    const response = await SELF.fetch("https://example.com/api/my/management-research?symbol=usTEST");
    expect(response.status).toBe(401);
  });

  it("rejects malformed companies and exposes a safe unconfigured state without credentials", async () => {
    const app = new Hono(); registerManagementResearch(app);
    const bad = await app.request("https://example.com/api/my/management-research?symbol=../../private", {}, {});
    expect(bad.status).toBe(400);
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request("https://example.com/api/my/management-research?symbol=usTESTUNCONFIGURED"), {}, ctx);
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const data = await response.json(); expect(data.status).toBe("not_configured"); expect(data.sources).toEqual([]);
    expect(JSON.stringify(data)).not.toMatch(/token|secret|api.key/i);
    await waitOnExecutionContext(ctx);
  });

  it("returns source excerpts with no-store and reuses a bounded server snapshot without refetching", async () => {
    const key = new Request("https://management-research.internal/v3?symbol=usTESTCACHE");
    await caches.default.delete(key);
    fetchMock.activate(); fetchMock.disableNetConnect();
    const published_at = String(Math.floor(Date.now() / 1000));
    const item = { id: "901", title: "Company 2026 Q3 earnings results", description: "Management guidance", url: "https://longbridge.com/news/901", published_at };
    fetchMock.get("https://openapi.longportapp.com").intercept({ path: "/v1/content/TESTCACHE.US/news" }).reply(200, { code: 0, data: { items: [item] } });
    fetchMock.get("https://longbridge.com").intercept({ path: "/zh-CN/news/901.md" }).reply(200, "No related sources");
    fetchMock.get("https://openapi.longportapp.com").intercept({ path: "/v1/content/news/901" }).reply(200, { code: 0, data: { item: { ...item, body: "Management expects revenue growth, while the company plans capacity investment. Cash generation depends on utilization.", tickers: ["TESTCACHE.US"] } } });
    const app = new Hono(); registerManagementResearch(app);
    const url = "https://example.com/api/my/management-research?symbol=usTESTCACHE";
    const ctx = createExecutionContext(), response = await app.fetch(new Request(url), credentials, ctx);
    const data = await response.json(); await waitOnExecutionContext(ctx);
    expect(data.status).toBe("ok"); expect(data.sources[0].id).toBe("901");
    expect(data.sources[0].passages[0].excerpt).toContain("capacity investment");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const secondCtx = createExecutionContext(), cached = await app.fetch(new Request(url), credentials, secondCtx);
    expect(await cached.json()).toEqual(data); await waitOnExecutionContext(secondCtx);
    fetchMock.assertNoPendingInterceptors(); await caches.default.delete(key);
  });
});
