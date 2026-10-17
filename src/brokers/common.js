// 券商适配器共用小工具：数字解析、市场 ↔ 币种、腾讯符号 → 市场。

// "1,200" / " 3.5 " / 12 → Number；空或非法 → NaN
export function toNum(v) {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  const s = String(v).trim().replace(/[,\s]/g, "");
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export const MARKET_CURRENCY = { US: "USD", HK: "HKD", CN: "CNY" };

// 腾讯符号 → 市场（us→US, hk→HK, sh/sz→CN；其它 null）
export function marketOfSymbol(sym) {
  const p = String(sym || "").slice(0, 2).toLowerCase();
  if (p === "us") return "US";
  if (p === "hk") return "HK";
  if (p === "sh" || p === "sz") return "CN";
  return null;
}

// 按币种累加现金 → [{currency, amount}]（保持首次出现顺序）
export function sumCash(pairs) {
  const m = new Map();
  for (const [cur, amt] of pairs) {
    if (!cur || !Number.isFinite(amt)) continue;
    m.set(cur, (m.get(cur) || 0) + amt);
  }
  return [...m].map(([currency, amount]) => ({ currency, amount }));
}

// 同符号持仓合并：数量累加，成本按数量加权（任一成本未知 → NaN）
export function mergePositions(list) {
  const m = new Map();
  for (const p of list) {
    const prev = m.get(p.symbol);
    if (!prev) { m.set(p.symbol, { ...p }); continue; }
    const q = prev.quantity + p.quantity;
    prev.costPrice = q && Number.isFinite(prev.costPrice) && Number.isFinite(p.costPrice)
      ? (prev.costPrice * prev.quantity + p.costPrice * p.quantity) / q : NaN;
    prev.quantity = q;
    if (!prev.name && p.name) prev.name = p.name;
  }
  return [...m.values()];
}
