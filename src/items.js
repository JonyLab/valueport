// 校验后台提交的配置；ok=false 时 errors 描述原因。
export function validateItem(b) {
  const errors = [];
  const fairLow = Number(b.fairLow), fairHigh = Number(b.fairHigh);
  const mos = Number(b.mos), ext = Number(b.ext);
  if (!b.symbol || typeof b.symbol !== "string") errors.push("symbol required");
  if (!b.ticker || typeof b.ticker !== "string") errors.push("ticker required");
  if (!(fairLow > 0)) errors.push("fairLow must be > 0");
  if (!(fairHigh > fairLow)) errors.push("fairHigh must be > fairLow");
  if (!(mos > 0 && mos < 100)) errors.push("mos must be in (0,100)");
  if (!(ext > 0)) errors.push("ext must be > 0");
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { ticker: b.ticker, name: b.name || "", symbol: b.symbol,
        fairLow, fairHigh, mos, ext, sortOrder: Number(b.sortOrder) || 0 } };
}

export function rowToItem(r) {
  return {
    id: r.id, ticker: r.ticker, name: r.name, symbol: r.symbol,
    fairLow: r.fair_low, fairHigh: r.fair_high, mos: r.mos, ext: r.ext, sortOrder: r.sort_order,
  };
}
