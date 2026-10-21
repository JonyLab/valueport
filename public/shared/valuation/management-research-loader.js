import { cleanManagementResearch } from "./management-research.js";

// Keep cited snapshots stable, but an unsuccessful attempt is not saved evidence.
export function recoverManagementResearch(current, incoming) {
  const saved = cleanManagementResearch(current);
  return saved?.sources.length ? saved : cleanManagementResearch(incoming) || saved;
}

export function createManagementResearchLoader({ initial, symbol, name = "", onChange, fetchImpl = fetch, now = Date.now }) {
  let data = cleanManagementResearch(initial), pending = null, attemptedAt = null;
  return async function load({ retry = false } = {}) {
    if (!symbol || data?.sources.length) return data;
    if (pending) return pending;
    if (!retry && attemptedAt !== null && now() - attemptedAt < 60000) return data;
    attemptedAt = now();
    pending = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
      let next = null;
      try {
        const query = new URLSearchParams({ symbol, name: name.slice(0, 100) });
        const response = await fetchImpl("/api/my/management-research?" + query, { signal: controller.signal });
        if (response.ok) next = cleanManagementResearch(await response.json());
      } catch { /* Research failure must not block valuation or discard the draft. */ }
      finally { clearTimeout(timer); }
      data = next || cleanManagementResearch({ status: "unavailable", symbol });
      onChange?.(data);
      return data;
    })();
    try { return await pending; }
    finally { pending = null; }
  };
}
