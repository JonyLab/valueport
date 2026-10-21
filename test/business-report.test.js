import { describe, it, expect, vi } from "vitest";
import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { registerBusinessReports } from "../src/business-report.js";

const snapshot = (symbol) => ({ status: "ok", symbol, reports: [{ kind: "annual", year: 2025, status: "ok" }, { kind: "interim", year: 2026, status: "ok" }] });
const request = async (app, symbol) => {
  const ctx = createExecutionContext(), response = await app.fetch(new Request("https://x/api/my/business-reports?symbol=" + symbol), env, ctx);
  const data = await response.json(); await waitOnExecutionContext(ctx); return { response, data };
};
describe("on-demand periodic revenue tables", () => {
  it("requires authentication before upstream requests", async () => {
    expect((await SELF.fetch("https://x/api/my/business-reports?symbol=sh600001")).status).toBe(401);
  });
  it("rejects invalid symbols and explicitly leaves unsupported markets to existing sources", async () => {
    const app = new Hono(); registerBusinessReports(app);
    expect((await request(app, "../../private")).response.status).toBe(400);
    const result = await request(app, "usTESTBIZ"); expect(result.data.status).toBe("unsupported");
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("persists a successful public snapshot and reuses it after edge eviction and handler restart", async () => {
    const symbol = "sh600091", key = new Request("https://business-reports.internal/v1/" + symbol);
    await caches.default.delete(key);
    const fetchReports = vi.fn(async () => snapshot(symbol)), app = new Hono(); registerBusinessReports(app, { fetchReports });
    const first = await request(app, symbol); expect(first.data.storage.status).toBe("saved");
    await caches.default.delete(key);
    const nextFetch = vi.fn(() => { throw new Error("must not refetch"); }), restarted = new Hono(); registerBusinessReports(restarted, { fetchReports: nextFetch });
    expect((await request(restarted, symbol)).data).toEqual(first.data); expect(nextFetch).not.toHaveBeenCalled();
    expect(fetchReports).toHaveBeenCalledTimes(1); await caches.default.delete(key);
  });
  it("keeps saved data after an expired refresh fails", async () => {
    const symbol = "sh600092", key = new Request("https://business-reports.internal/v1/" + symbol); await caches.default.delete(key);
    let time = Date.parse("2026-10-21T08:00:00Z"); const app = new Hono();
    const fetchReports = vi.fn().mockResolvedValueOnce(snapshot(symbol)).mockResolvedValueOnce({ status: "unavailable", symbol, reports: [] });
    registerBusinessReports(app, { fetchReports, now: () => time }); await request(app, symbol); await caches.default.delete(key);
    time += 21601000; const result = await request(app, symbol);
    expect(result.data.status).toBe("ok"); expect(result.data.reports).toEqual(snapshot(symbol).reports); expect(result.data.storage.status).toBe("refresh_failed");
    expect(fetchReports).toHaveBeenCalledTimes(2);
  });
  it("retains a successful report when only the other period refreshes", async () => {
    const symbol = "sh600093", key = new Request("https://business-reports.internal/v1/" + symbol);
    let time = Date.parse("2026-10-21T08:00:00Z");
    const original = snapshot(symbol), partial = snapshot(symbol);
    partial.reports[0] = { kind: "annual", year: 2025, status: "unavailable" };
    const fetchReports = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(partial);
    const app = new Hono(); registerBusinessReports(app, { fetchReports, now: () => time });
    await request(app, symbol); await caches.default.delete(key); time += 21601000;
    const result = await request(app, symbol);
    expect(result.data.reports).toEqual(original.reports);
    expect(result.data.storage.status).toBe("refresh_failed");
    await caches.default.delete(key);
  });
  it("recovers from malformed durable JSON", async () => {
    const symbol = "sh600094";
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS business_report_snapshots (symbol TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL,saved_at TEXT NOT NULL,refresh_after INTEGER NOT NULL)").run();
    await env.DB.prepare("INSERT INTO business_report_snapshots VALUES(?,?,?,?)").bind(symbol, "broken", "2026-10-21", Date.now() + 999999).run();
    const app = new Hono(), fetchReports = vi.fn(async () => snapshot(symbol)); registerBusinessReports(app, { fetchReports });
    expect((await request(app, symbol)).data.status).toBe("ok"); expect(fetchReports).toHaveBeenCalledTimes(1);
    await caches.default.delete(new Request("https://business-reports.internal/v1/" + symbol));
  });

});
