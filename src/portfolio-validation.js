// Pure portfolio domain schemas & validation: broker credentials, manual/CSV snapshots,
// and target allocation / bucket / profile / signal-alert / rebalance schedule plans.

export const BROKERS = ["longbridge", "ibkr", "tiger", "schwab", "etrade", "webull", "manual"];
export const OAUTH_BROKERS = ["schwab", "etrade"];
export const BROKER_NAMES = {
  longbridge: "Longbridge",
  ibkr: "IBKR",
  tiger: "Tiger",
  schwab: "Schwab",
  etrade: "E*TRADE",
  webull: "Webull",
};

// 各券商需要的凭证字段（都是字符串）；OPTIONAL_FIELDS 可留空
export const CRED_FIELDS = {
  longbridge: ["appKey", "appSecret", "accessToken"],
  ibkr: ["token", "queryId"],
  tiger: ["tigerId", "account", "privateKey"],
  schwab: ["appKey", "appSecret"],
  etrade: ["consumerKey", "consumerSecret"],
  webull: ["appKey", "appSecret"],
};
const OPTIONAL_FIELDS = { tiger: ["token"], webull: ["accountId", "region"] };
const MAX_CRED_LEN = { privateKey: 8192 }; // RSA 私钥 PEM 比别的凭证长

export const SYMBOL_RE = /^(us|hk|sh|sz)[A-Za-z0-9.]{1,12}$/;
export const SYM_RE = /^(us|hk|sh|sz|bj)[A-Za-z0-9.]{1,12}$/;
export const CUR_RE = /^[A-Z]{3}$/;
export const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_POSITIONS = 500;
const MAX_CASH = 20;
const BUCKET_ID_RE = /^[a-z0-9_-]{1,24}$/;
const FREQS = ["none", "monthly", "quarterly", "semiannual", "annual"];
const ALERT_METRICS = ["cn_erp", "us_erp", "hk_erp", "cn_level", "us_level", "hk_level", "cn_pe", "hk_pe", "cape", "buffett", "cn10y", "us10y", "us_real10y"];

export const PLAN_DEFAULTS = { targets: {}, cash: null, band: 5, rel: 25 };

export function validateCreds(broker, creds) {
  const fields = CRED_FIELDS[broker];
  if (!fields) return { ok: true, value: null };
  if (!creds || typeof creds !== "object") return { ok: false, error: "missing credentials" };
  const out = {};
  for (const f of fields) {
    const v = typeof creds[f] === "string" ? creds[f].trim() : "";
    if (!v || v.length > (MAX_CRED_LEN[f] || 4096)) return { ok: false, error: `invalid ${f}` };
    out[f] = v;
  }
  for (const f of OPTIONAL_FIELDS[broker] || []) {
    const v = typeof creds[f] === "string" ? creds[f].trim() : "";
    if (v.length > 4096) return { ok: false, error: `invalid ${f}` };
    if (v) out[f] = v;
  }
  if (out.region && !["us", "hk"].includes(out.region.toLowerCase())) return { ok: false, error: "invalid region" };
  if (out.region) out.region = out.region.toLowerCase();
  return { ok: true, value: out };
}

// 手动 / CSV 录入的持仓与现金校验；返回清洗后的数组，或 errors
export function validateSnapshot(body) {
  const errors = [];
  const positions = [], cash = [];
  const ps = Array.isArray(body && body.positions) ? body.positions : [];
  const cs = Array.isArray(body && body.cash) ? body.cash : [];
  if (ps.length > MAX_POSITIONS) errors.push(`too many positions (max ${MAX_POSITIONS})`);
  if (cs.length > MAX_CASH) errors.push(`too many cash rows (max ${MAX_CASH})`);
  ps.slice(0, MAX_POSITIONS).forEach((p, i) => {
    const symbol = typeof p.symbol === "string" ? p.symbol.trim() : "";
    const quantity = Number(p.quantity), cost = p.costPrice === null || p.costPrice === "" || p.costPrice === undefined ? NaN : Number(p.costPrice);
    const currency = typeof p.currency === "string" ? p.currency.trim().toUpperCase() : "";
    if (!SYMBOL_RE.test(symbol)) { errors.push(`positions[${i}]: invalid symbol`); return; }
    if (!Number.isFinite(quantity) || quantity === 0) { errors.push(`positions[${i}]: invalid quantity`); return; }
    if (!CUR_RE.test(currency)) { errors.push(`positions[${i}]: invalid currency`); return; }
    positions.push({ symbol, name: String(p.name || "").slice(0, 80), quantity, costPrice: Number.isFinite(cost) ? cost : null, currency, market: String(p.market || "").slice(0, 4).toUpperCase() });
  });
  cs.slice(0, MAX_CASH).forEach((r, i) => {
    const currency = typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "";
    const amount = Number(r.amount);
    if (!CUR_RE.test(currency) || !Number.isFinite(amount)) { errors.push(`cash[${i}]: invalid row`); return; }
    cash.push({ currency, amount });
  });
  return { positions, cash, errors };
}

// 目标仓位计划（targets / cash / band / rel / buckets / profiles / signalAlerts / assetClass / allocOnly / schedule / guardrail / rebalanceLog）
export function validatePlan(body) {
  if (!body || typeof body !== "object") return { error: "bad body" };
  const t = body.targets;
  if (!t || typeof t !== "object" || Array.isArray(t)) return { error: "targets must be an object" };
  const entries = Object.entries(t);
  if (entries.length > 200) return { error: "too many targets" };
  const targets = {};
  let sum = 0;
  for (const [sym, v] of entries) {
    if (!SYM_RE.test(sym)) return { error: `bad symbol: ${sym}` };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { error: `bad weight for ${sym}` };
    if (n > 0) { targets[sym] = Math.round(n * 100) / 100; sum += n; }
  }
  let cash = null;
  if (body.cash !== null && body.cash !== undefined && body.cash !== "") {
    cash = Number(body.cash);
    if (!Number.isFinite(cash) || cash < 0 || cash > 100) return { error: "bad cash target" };
    cash = Math.round(cash * 100) / 100;
    sum += cash;
  }
  if (sum > 100.0001) return { error: "targets add up to more than 100%" };
  const band = body.band === undefined ? PLAN_DEFAULTS.band : Number(body.band);
  const rel = body.rel === undefined ? PLAN_DEFAULTS.rel : Number(body.rel);
  if (!Number.isFinite(band) || band < 0.5 || band > 30) return { error: "band must be 0.5-30" };
  if (!Number.isFinite(rel) || rel < 5 || rel > 100) return { error: "rel must be 5-100" };

  const plan = { targets, cash, band, rel };

  // 可选：资产大类（分组桶）
  const bucketIds = new Set();
  const nonCashBucketIds = new Set();
  if (body.buckets !== undefined && body.buckets !== null) {
    if (!Array.isArray(body.buckets)) return { error: "buckets must be an array" };
    if (body.buckets.length > 20) return { error: "too many buckets (max 20)" };
    const buckets = [];
    let bucketSum = 0, cashBucketCount = 0;
    for (const b of body.buckets) {
      if (!b || typeof b !== "object") return { error: "bad bucket" };
      const id = typeof b.id === "string" ? b.id.trim().toLowerCase() : "";
      const name = typeof b.name === "string" ? b.name.replace(/\s+/g, " ").trim().slice(0, 30) : "";
      if (!BUCKET_ID_RE.test(id) || bucketIds.has(id)) return { error: `bad or duplicate bucket id: ${id}` };
      if (!name) return { error: `missing bucket name for ${id}` };
      const isCash = !!b.isCash;
      if (isCash) { cashBucketCount++; if (cashBucketCount > 1) return { error: "at most one cash bucket is allowed" }; }
      let target = null;
      if (b.target !== null && b.target !== undefined && b.target !== "") {
        const tn = Number(b.target);
        if (!Number.isFinite(tn) || tn < 0 || tn > 100) return { error: `bad bucket target for ${id}` };
        if (tn > 0) { target = Math.round(tn * 100) / 100; bucketSum += target; }
      }
      let min, max;
      if (b.min !== null && b.min !== undefined && b.min !== "") {
        const mn = Number(b.min);
        if (!Number.isFinite(mn) || mn < 0 || mn > 100) return { error: `bad bucket min for ${id}` };
        min = Math.round(mn * 100) / 100;
      }
      if (b.max !== null && b.max !== undefined && b.max !== "") {
        const mx = Number(b.max);
        if (!Number.isFinite(mx) || mx < 0 || mx > 100) return { error: `bad bucket max for ${id}` };
        max = Math.round(mx * 100) / 100;
      }
      if (min !== undefined && max !== undefined && min > max) return { error: `bucket min > max for ${id}` };
      bucketIds.add(id);
      if (!isCash) nonCashBucketIds.add(id);
      buckets.push({ id, name, target, ...(isCash ? { isCash: true } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
    }
    if (bucketSum > 100.0001) return { error: "bucket targets add up to more than 100%" };
    if (buckets.length) plan.buckets = buckets;
  }

  // 可选：情景配置方案（Profiles：多套自定义大类目标配方）
  const profileIds = new Set();
  if (body.profiles !== undefined && body.profiles !== null) {
    if (!Array.isArray(body.profiles)) return { error: "profiles must be an array" };
    if (body.profiles.length > 10) return { error: "too many profiles (max 10)" };
    const profiles = [];
    for (const p of body.profiles) {
      if (!p || typeof p !== "object") return { error: "bad profile" };
      const pid = typeof p.id === "string" ? p.id.trim().toLowerCase() : "";
      const pname = typeof p.name === "string" ? p.name.replace(/\s+/g, " ").trim().slice(0, 30) : "";
      if (!BUCKET_ID_RE.test(pid) || profileIds.has(pid)) return { error: `bad or duplicate profile id: ${pid}` };
      if (!pname) return { error: `missing profile name for ${pid}` };
      if (!p.targets || typeof p.targets !== "object" || Array.isArray(p.targets)) return { error: `bad targets in profile ${pid}` };
      const pt = {};
      let psum = 0;
      for (const [bid, v] of Object.entries(p.targets)) {
        if (!bucketIds.has(bid)) return { error: `unknown bucket ${bid} in profile ${pid}` };
        if (v === null || v === undefined || v === "") continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) return { error: `bad weight in profile ${pid}` };
        if (n > 0) { pt[bid] = Math.round(n * 100) / 100; psum += pt[bid]; }
      }
      if (psum > 100.0001) return { error: `profile ${pid} targets exceed 100%` };
      profileIds.add(pid);
      profiles.push({ id: pid, name: pname, targets: pt });
    }
    if (profiles.length) plan.profiles = profiles;
  }
  if (typeof body.activeProfileId === "string" && body.activeProfileId.trim()) {
    const ap = body.activeProfileId.trim().toLowerCase();
    if (!profileIds.has(ap)) return { error: `unknown activeProfileId: ${ap}` };
    plan.activeProfileId = ap;
  }

  // 可选：指标条件提醒
  if (body.signalAlerts !== undefined && body.signalAlerts !== null) {
    if (!Array.isArray(body.signalAlerts)) return { error: "signalAlerts must be an array" };
    if (body.signalAlerts.length > 20) return { error: "too many signalAlerts (max 20)" };
    const alerts = [];
    const alertIds = new Set();
    for (const a of body.signalAlerts) {
      if (!a || typeof a !== "object") return { error: "bad signalAlert" };
      const aid = typeof a.id === "string" ? a.id.trim().toLowerCase() : "";
      if (!BUCKET_ID_RE.test(aid) || alertIds.has(aid)) return { error: `bad or duplicate alert id: ${aid}` };
      const metric = typeof a.metric === "string" ? a.metric.trim().toLowerCase() : "";
      if (!ALERT_METRICS.includes(metric)) return { error: `bad alert metric: ${metric}` };
      const mode = a.mode === "value" ? "value" : a.mode === "pct" ? "pct" : "";
      if (!mode) return { error: `bad alert mode in ${aid}` };
      const op = a.op === "gte" || a.op === "lte" ? a.op : "";
      if (!op) return { error: `bad alert op in ${aid}` };
      const threshold = Number(a.threshold);
      if (!Number.isFinite(threshold)) return { error: `bad alert threshold in ${aid}` };
      if (mode === "pct" && (threshold < 0 || threshold > 100)) return { error: `pct threshold must be 0-100 in ${aid}` };
      if (mode === "value" && (threshold < -100 || threshold > 10000)) return { error: `value threshold out of range in ${aid}` };
      const note = typeof a.note === "string" ? a.note.replace(/\s+/g, " ").trim().slice(0, 120) : "";
      const suggestProfileId = typeof a.suggestProfileId === "string" && a.suggestProfileId.trim() ? a.suggestProfileId.trim().toLowerCase() : "";
      if (suggestProfileId && !profileIds.has(suggestProfileId)) return { error: `unknown suggestProfileId in ${aid}` };
      alertIds.add(aid);
      alerts.push({
        id: aid,
        enabled: a.enabled !== false,
        metric,
        mode,
        op,
        threshold: Math.round(threshold * 100) / 100,
        ...(note ? { note } : {}),
        ...(suggestProfileId ? { suggestProfileId } : {}),
      });
    }
    if (alerts.length) plan.signalAlerts = alerts;
  }

  // 可选：标的归类（symbol -> bucketId）
  if (body.assetClass !== undefined && body.assetClass !== null) {
    if (typeof body.assetClass !== "object" || Array.isArray(body.assetClass)) return { error: "assetClass must be an object" };
    const acEntries = Object.entries(body.assetClass);
    if (acEntries.length > 300) return { error: "too many assetClass entries" };
    const assetClass = {};
    for (const [sym, bidRaw] of acEntries) {
      if (!SYM_RE.test(sym)) return { error: `bad assetClass symbol: ${sym}` };
      const bid = typeof bidRaw === "string" ? bidRaw.trim().toLowerCase() : "";
      if (!bid) continue;
      if (!nonCashBucketIds.has(bid)) return { error: `unknown bucket for ${sym}: ${bid}` };
      assetClass[sym] = bid;
    }
    if (Object.keys(assetClass).length) plan.assetClass = assetClass;
  }

  // 可选：配置型资产标记（免个股估值覆盖率扣分）
  if (body.allocOnly !== undefined && body.allocOnly !== null) {
    if (!Array.isArray(body.allocOnly)) return { error: "allocOnly must be an array" };
    if (body.allocOnly.length > 200) return { error: "too many allocOnly entries" };
    const seen = new Set();
    for (const sym of body.allocOnly) {
      if (typeof sym !== "string" || !SYM_RE.test(sym)) return { error: `bad allocOnly symbol: ${sym}` };
      seen.add(sym);
    }
    if (seen.size) plan.allocOnly = [...seen];
  }

  // 可选：定期复盘日程
  if (body.schedule !== undefined && body.schedule !== null) {
    if (typeof body.schedule !== "object" || Array.isArray(body.schedule)) return { error: "bad schedule" };
    const freq = typeof body.schedule.freq === "string" ? body.schedule.freq.trim().toLowerCase() : "none";
    if (!FREQS.includes(freq)) return { error: `bad schedule freq: ${freq}` };
    const last = typeof body.schedule.lastRebalancedAt === "string" ? body.schedule.lastRebalancedAt.trim() : "";
    if (last && !ISO_DAY_RE.test(last)) return { error: "bad lastRebalancedAt date" };
    if (freq !== "none" || last) plan.schedule = { freq, ...(last ? { lastRebalancedAt: last } : {}) };
  }

  // 可选：再平衡默认护栏开关
  if (typeof body.guardrail === "boolean") plan.guardrail = body.guardrail;

  // 可选：再平衡执行记录（最多 24 条）
  if (body.rebalanceLog !== undefined && body.rebalanceLog !== null) {
    if (!Array.isArray(body.rebalanceLog)) return { error: "rebalanceLog must be an array" };
    const log = [];
    for (const item of body.rebalanceLog.slice(0, 24)) {
      if (!item || typeof item !== "object") return { error: "bad rebalanceLog entry" };
      const date = typeof item.date === "string" ? item.date.trim() : "";
      if (!ISO_DAY_RE.test(date)) return { error: "bad rebalanceLog date" };
      const mode = item.mode === "cashflow" ? "cashflow" : "standard";
      const scope = item.scope === "bucket" || item.scope === "symbol" ? item.scope : undefined;
      const cashAdded = Number.isFinite(Number(item.cashAdded)) && Number(item.cashAdded) > 0 ? Math.round(Number(item.cashAdded) * 100) / 100 : undefined;
      const note = typeof item.note === "string" ? item.note.replace(/\s+/g, " ").trim().slice(0, 120) : "";
      log.push({ date, mode, ...(scope ? { scope } : {}), ...(cashAdded ? { cashAdded } : {}), ...(note ? { note } : {}) });
    }
    if (log.length) plan.rebalanceLog = log;
  }

  return { plan };
}

export function credHint(broker, creds) {
  if (!creds) return "";
  const v = { longbridge: creds.appKey, ibkr: creds.queryId, tiger: creds.account, schwab: creds.appKey, etrade: creds.consumerKey, webull: creds.appKey }[broker] || "";
  return v ? "…" + String(v).slice(-4) : "";
}

export function rowToAccount(r, hint) {
  return { id: r.id, broker: r.broker, name: r.name, hasCreds: !!r.cred_enc, credHint: hint || "", lastSyncAt: r.last_sync_at, lastError: r.last_error, createdAt: r.created_at };
}
