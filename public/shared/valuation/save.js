export function valuationChange(cfg, cardId, value, id = crypto.randomUUID(), at = new Date().toISOString()) {
  if (!Number.isFinite(value.low) || !Number.isFinite(value.high) || value.low <= 0 || (value.scenarioMode === "single" ? value.high !== value.low : value.high <= value.low)) throw new Error("Invalid valuation range");
  const cards = Array.isArray(cfg.valuations) ? cfg.valuations : [];
  if (cardId && !cards.some((card) => card.id === cardId)) throw new Error("Valuation no longer exists");
  const nextCard = { ...(cardId ? cards.find((card) => card.id === cardId) : {}), ...value, id: cardId || id, updatedAt: at };
  delete nextCard.review; delete nextCard.reviewedAt;
  const valuations = cardId ? cards.map((card) => card.id === cardId ? nextCard : card) : [...cards, nextCard];
  const selected = cfg.selectedValuationId || nextCard.id;
  return { valuations, selectedValuationId: selected,
    fairLow: selected === nextCard.id ? Math.round(value.low * 100) / 100 : cfg.fairLow,
    fairHigh: selected === nextCard.id ? Math.round(value.high * 100) / 100 : cfg.fairHigh };
}

export async function persistValuation(item, cardId, value, fetchImpl = fetch) {
  const change = valuationChange(item.cfg, cardId, value), cfg = { ...item.cfg, ...change };
  const payload = { ticker: cfg.ticker, name: cfg.name, symbol: cfg.symbol, fairLow: cfg.fairLow, fairHigh: cfg.fairHigh,
    mos: cfg.mos, ext: cfg.ext, sortOrder: cfg.sortOrder || 0, valuations: cfg.valuations, selectedValuationId: cfg.selectedValuationId };
  // Commit to the live card only after a successful server response.
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(item.id ? `/api/my/items/${item.id}` : "/api/my/items", { method: item.id ? "PUT" : "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!item.id && !result.id) throw new Error("Missing saved item ID");
    return { change, id: item.id || result.id };
  } finally { clearTimeout(timeout); }
}
