// 估值方法白名单（与 public/shared/valuation/* 的 model.key 一致）
const METHODS = new Set(["fcff", "fcf", "fcfe", "ddm", "pe", "peg", "pb", "ps", "evebitda"]);

// 校验估值卡片数组。返回 { ok, value } 或 { ok:false }。
function validateValuations(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const out = [];
  for (const card of raw) {
    if (!card || typeof card !== "object") return { ok: false };
    if (typeof card.id !== "string" || !card.id) return { ok: false };
    if (!METHODS.has(card.method)) return { ok: false };
    if (!card.inputs || typeof card.inputs !== "object") return { ok: false };
    const low = Number(card.low), high = Number(card.high);
    if (!(low > 0) || !(high > low)) return { ok: false };
    out.push({ id: card.id, method: card.method, inputs: card.inputs, low, high,
      note: typeof card.note === "string" ? card.note.slice(0, 2000) : "",
      derivations: (card.derivations && typeof card.derivations === "object" && !Array.isArray(card.derivations)) ? card.derivations : {},
      segments: (card.segments && typeof card.segments === "object" && !Array.isArray(card.segments)) ? card.segments : {},
      updatedAt: typeof card.updatedAt === "string" ? card.updatedAt : "" });
  }
  return { ok: true, value: out };
}

// 校验后台提交的配置；ok=false 时 errors 描述原因。
export function validateItem(b) {
  const errors = [];
  const mos = Number(b.mos), ext = Number(b.ext);
  // 内在价值区间可选：留空（"" / null / 0）表示「未估值」，存 0。填了才校验低<高。
  const rawLow = b.fairLow, rawHigh = b.fairHigh;
  const lowSet = rawLow !== "" && rawLow != null && Number(rawLow) > 0;
  const highSet = rawHigh !== "" && rawHigh != null && Number(rawHigh) > 0;
  const fairLow = lowSet ? Number(rawLow) : 0;
  const fairHigh = highSet ? Number(rawHigh) : 0;
  const hasFair = lowSet || highSet;
  if (!b.symbol || typeof b.symbol !== "string") errors.push("symbol required");
  if (!b.ticker || typeof b.ticker !== "string") errors.push("ticker required");
  if (hasFair) {
    if (!(fairLow > 0)) errors.push("fairLow must be > 0");
    else if (!(fairHigh > fairLow)) errors.push("fairHigh must be > fairLow");
  }
  if (!(mos > 0 && mos < 100)) errors.push("mos must be in (0,100)");
  if (!(ext > 0)) errors.push("ext must be > 0");

  const vals = validateValuations(b.valuations);
  if (!vals.ok) errors.push("valuations invalid");
  // 未设定区间 ⇒ 不可能有选中的估值卡片
  let selectedValuationId = (hasFair && typeof b.selectedValuationId === "string" && b.selectedValuationId) ? b.selectedValuationId : null;
  if (vals.ok && selectedValuationId && !vals.value.some((c) => c.id === selectedValuationId)) {
    errors.push("selectedValuationId not found");
  }

  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { ticker: b.ticker, name: b.name || "", symbol: b.symbol,
        fairLow, fairHigh, mos, ext, sortOrder: Number(b.sortOrder) || 0,
        valuations: vals.value, selectedValuationId } };
}

export function rowToItem(r) {
  let valuations = [];
  try { const p = r.valuations ? JSON.parse(r.valuations) : []; if (Array.isArray(p)) valuations = p; } catch { /* 坏 JSON 兜底空 */ }
  return {
    id: r.id, ticker: r.ticker, name: r.name, symbol: r.symbol,
    fairLow: r.fair_low, fairHigh: r.fair_high, mos: r.mos, ext: r.ext, sortOrder: r.sort_order,
    valuations, selectedValuationId: r.selected_valuation_id ?? null,
  };
}
