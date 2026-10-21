import { describe, it, expect, vi } from "vitest";
import { createManagementResearchLoader, recoverManagementResearch } from "../public/shared/valuation/management-research-loader.js";

const empty = (status = "unavailable") => ({ status, symbol: "usTEST", sources: [] });
const evidence = { status: "ok", symbol: "usTEST", sources: [{ id: "123", title: "Company earnings",
  passages: [{ kind: "reported_guidance", excerpt: "Management expects revenue growth with continued investment in capacity." }] }] };

describe("recovering earnings evidence without losing a valuation draft", () => {
  it.each(["unavailable", "empty", "not_configured", "ok"])("refetches a restored %s snapshot with no sources", async (status) => {
    const fetchImpl = vi.fn(async () => Response.json(evidence)), onChange = vi.fn();
    const load = createManagementResearchLoader({ initial: empty(status), symbol: "usTEST", fetchImpl, onChange });
    expect((await load()).sources).toHaveLength(1);
    await load();
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent calls, throttles failures and allows an immediate explicit retry", async () => {
    let resolve, time = 0;
    const fetchImpl = vi.fn(() => new Promise((r) => { resolve = r; }));
    const load = createManagementResearchLoader({ initial: empty(), symbol: "usTEST", fetchImpl, now: () => time });
    const first = load(), second = load();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolve(Response.json(empty())); await Promise.all([first, second]);
    await load(); expect(fetchImpl).toHaveBeenCalledTimes(1);
    const retry = load({ retry: true }); expect(fetchImpl).toHaveBeenCalledTimes(2);
    resolve(new Response("failed", { status: 503 })); await retry;
    time = 60001;
    const automaticRetry = load(); expect(fetchImpl).toHaveBeenCalledTimes(3);
    resolve(Response.json(evidence)); expect((await automaticRetry).sources).toHaveLength(1);
  });

  it("recovers after a rejected fetch instead of memoizing the failure forever", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(Response.json(evidence));
    const load = createManagementResearchLoader({ symbol: "usTEST", fetchImpl });
    expect((await load()).status).toBe("unavailable");
    expect((await load({ retry: true })).sources).toHaveLength(1);
  });

  it("replaces failed guide evidence but freezes successful cited snapshots", async () => {
    const recovered = recoverManagementResearch(empty(), evidence);
    expect(recovered.sources).toHaveLength(1);
    expect(recoverManagementResearch(recovered, empty())).toEqual(recovered);
    const fetchImpl = vi.fn();
    const load = createManagementResearchLoader({ initial: recovered, symbol: "usTEST", fetchImpl });
    expect(await load({ retry: true })).toEqual(recovered); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
