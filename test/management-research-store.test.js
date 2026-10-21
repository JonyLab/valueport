import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { createResearchStore, mergeResearchRefresh, usableStoredResearch } from "../src/management-research-store.js";
import { registerManagementResearch } from "../src/management-research.js";

const now = Date.parse("2026-10-21T08:00:00Z"), symbol = "usSTORE";
const key = new Request(`https://management-research.internal/v3?symbol=${symbol}`);
function snapshot(at = now, quarter = "2026 Q2") {
  return { status: "ok", symbol, fetchedAt: new Date(at).toISOString(), officialStatus: "ok",
    officialSite: { symbol, name: "Example Limited", website: "https://example.com/", irUrl: "https://example.com/investors/", aliases: ["Example"], linkedHosts: [], origin: "longbridge_company_profile" },
    sources: [{ sourceType: "official", id: "official-store-q2", url: "https://example.com/q2.pdf", title: "Example earnings", publisher: "Example Limited", reportPeriod: quarter,
      publishedAt: "2026-08-11", retrievedAt: new Date(at).toISOString(), documentType: "prepared_remarks", qaCoverage: "not_included", pageCount: 1,
      passages: [{ kind: "official_guidance", excerpt: "We expect growth while investment continues.", page: 1, speaker: "Jane", section: "Commerce" }] }] };
}
const news = () => ({ status: "ok", symbol, fetchedAt: new Date(now).toISOString(), officialStatus: "unavailable",
  sources: [{ id: "101", title: "Example earnings news", publishedAt: new Date(now).toISOString(), passages: [{ kind: "reported_guidance", excerpt: "Company expects growth." }] }] });
function application(fetchResearch) {
  const app = new Hono(); registerManagementResearch(app, { fetchResearch, now: () => now }); return app;
}
async function request(app, name = "Example") {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://example.com/api/my/management-research?symbol=${symbol}&name=${name}`), { DB: env.DB }, ctx);
  return { response, data: await response.json(), ctx };
}

beforeEach(async () => {
  const store = createResearchStore(env.DB); await store.load(symbol, now);
  await env.DB.batch([env.DB.prepare("DELETE FROM management_research_snapshots"), env.DB.prepare("DELETE FROM management_research_documents")]);
  await caches.default.delete(key);
});

describe("persistent research snapshots", () => {
  it("survives edge-cache eviction and a new handler/store instance without refetching, regardless of display name", async () => {
    const fetchResearch = vi.fn(async () => snapshot());
    const first = await request(application(fetchResearch)); await waitOnExecutionContext(first.ctx);
    expect(first.data.storage.status).toBe("saved"); expect(first.response.headers.get("Cache-Control")).toBe("no-store");
    await caches.default.delete(key);
    const unused = vi.fn(async () => { throw new Error("must use durable snapshot"); });
    const second = await request(application(unused), "OtherDisplayName"); await waitOnExecutionContext(second.ctx);
    expect(second.data).toEqual(first.data); expect(unused).not.toHaveBeenCalled(); expect(fetchResearch).toHaveBeenCalledTimes(1);
  });

  it("returns old material before refresh resolves and permits only one concurrent background refresh", async () => {
    const store = createResearchStore(env.DB); await store.save(symbol, snapshot(now - 7 * 3600000), now - 7 * 3600000);
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; }), begins = new Promise((resolve) => { started = resolve; });
    const fetchResearch = vi.fn(async (_, __, ___, options) => { expect(options.knownSite.website).toBe("https://example.com/"); started(); await gate; return snapshot(now, "2026 Q3"); });
    const app = application(fetchResearch), first = await request(app);
    expect(first.data.storage.status).toBe("refreshing"); expect(first.data.sources[0].reportPeriod).toBe("2026 Q2");
    await begins;
    const second = await request(app); await waitOnExecutionContext(second.ctx);
    expect(second.data.storage.status).toBe("refreshing"); expect(fetchResearch).toHaveBeenCalledTimes(1);
    release(); await waitOnExecutionContext(first.ctx);
    const saved = await createResearchStore(env.DB).load(symbol, now);
    expect(saved.research.sources[0].reportPeriod).toBe("2026 Q3"); expect(saved.failed).toBe(false);
  });

  it("preserves saved official evidence when a refresh obtains only news and records the update gap", async () => {
    const store = createResearchStore(env.DB); await store.save(symbol, snapshot(now - 7 * 3600000), now - 7 * 3600000);
    const result = await request(application(async () => news())); await waitOnExecutionContext(result.ctx);
    const saved = await store.load(symbol, now);
    expect(saved.failed).toBe(true); expect(saved.research.sources.map((s) => s.id)).toEqual(["official-store-q2", "101"]);
    expect(saved.research.fetchedAt).toBe(new Date(now - 7 * 3600000).toISOString());
    const again = await request(application(vi.fn())); await waitOnExecutionContext(again.ctx);
    expect(again.data.storage.status).toBe("refresh_failed"); expect(again.data.storage.checkedAt).toBe(new Date(now).toISOString());
  });

  it("retains the last successful snapshot and throttles retries when refresh throws", async () => {
    const store = createResearchStore(env.DB); await store.save(symbol, snapshot(now - 7 * 3600000), now - 7 * 3600000);
    const fetchResearch = vi.fn(async () => { throw new Error("upstream blocked"); }), app = application(fetchResearch);
    const first = await request(app); await waitOnExecutionContext(first.ctx);
    const second = await request(app); await waitOnExecutionContext(second.ctx);
    expect(second.data.storage.status).toBe("refresh_failed"); expect(second.data.sources[0].sourceType).toBe("official");
    expect(fetchResearch).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade a saved reporting period or revive expired news", () => {
    const current = snapshot(now, "2026 Q1"); expect(mergeResearchRefresh(snapshot(), current).research.sources[0].reportPeriod).toBe("2026 Q2");
    const raw = news(); raw.sources[0].publishedAt = new Date(now - 121 * 86400000).toISOString();
    expect(usableStoredResearch(raw, symbol, now)).toBeNull(); expect(usableStoredResearch(snapshot(), "usOTHER", now)).toBeNull();
  });
});

describe("persistent source text", () => {
  it("stores original pages across instances and expires documents for correction checks", async () => {
    const store = createResearchStore(env.DB), url = "https://example.com/q2.pdf";
    const document = { url, format: "pdf", pages: ["Page one", "Page two"], fetchedAt: new Date(now).toISOString(), publishedAt: "2026-08-11" };
    expect(await store.putDocument(symbol, url, document, now)).toBe(true);
    expect(await createResearchStore(env.DB).getDocument(symbol, url, now + 1000)).toEqual(document);
    expect(await store.getDocument("usOTHER", url, now)).toBeNull();
    expect(await store.getDocument(symbol, url, now + 24 * 3600000)).toBeNull();
    expect(await store.putDocument(symbol, url, { ...document, pages: Array(41).fill("page") }, now)).toBe(false);
  });

  it("falls back safely if persistent storage is unavailable", async () => {
    const store = createResearchStore({ batch: async () => { throw new Error("offline"); }, prepare: () => ({}) });
    expect(await store.load(symbol, now)).toBeNull(); expect(await store.save(symbol, snapshot(), now)).toBe(false);
    expect(createResearchStore(null)).toBeNull();
  });
});
