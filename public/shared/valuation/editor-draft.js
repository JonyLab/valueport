// Research drafts are local, scoped to one user, stock and valuation card.
export function valuationDraftStore(key, sourceVersion = "", storage) {
  const storageKey = key ? `valuation-research-v1:${key}` : "";
  const backend = () => storage || localStorage;
  return {
    read() {
      if (!storageKey) return null;
      try {
        const raw = backend().getItem(storageKey); if (!raw || raw.length > 180000) return null;
        const value = JSON.parse(raw);
        if (value.version !== 1 || value.sourceVersion !== sourceVersion || !value.state || typeof value.state !== "object" || Array.isArray(value.state)
          || !Number.isFinite(value.at) || Date.now() - value.at > 30 * 86400000) return null;
        return value;
      } catch { return null; }
    },
    write(state) {
      if (!storageKey) return false;
      try {
        const raw = JSON.stringify({ version: 1, sourceVersion, at: Date.now(), state });
        if (raw.length > 180000) return false;
        backend().setItem(storageKey, raw); return true;
      } catch { return false; }
    },
    clear() { if (storageKey) { try { backend().removeItem(storageKey); } catch { /* Keep the in-memory form usable. */ } } },
  };
}
