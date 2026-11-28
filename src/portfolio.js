// Portfolio：每个用户的券商账户 + 持仓 / 现金快照 + 汇总所需的行情与汇率。
// 路由都挂在 /api/my/portfolio 下，复用 /api/my/* 的登录中间件（c.get("uid")），数据严格按 user_id 隔离。
// 凭证只写不读：加密存库（src/crypto.js），接口永远不返回明文，只返回是否已配置 + 末四位提示。
import { encryptJson, decryptJson } from "./crypto.js";
import { utcToday, utcDaysAgo } from "./lib/runtime.js";
import { readHoldings, readCash, replaceSnapshot, readHistory, historyStatement, readStoredPlan, writePlan } from "./portfolio-storage.js";

export const BROKERS = ["longbridge", "ibkr", "tiger", "schwab", "etrade", "webull", "manual"];
const SYMBOL_RE = /^(us|hk|sh|sz)[A-Za-z0-9.]{1,12}$/;
const CUR_RE = /^[A-Z]{3}$/;
const MAX_POSITIONS = 500, MAX_CASH = 20;

// 各券商需要的凭证字段（都是字符串）；OPTIONAL_FIELDS 可留空
const CRED_FIELDS = {
  longbridge: ["appKey", "appSecret", "accessToken"],
  ibkr: ["token", "queryId"],
  tiger: ["tigerId", "account", "privateKey"],
  schwab: ["appKey", "appSecret"],
  etrade: ["consumerKey", "consumerSecret"],
  webull: ["appKey", "appSecret"],
};
const OPTIONAL_FIELDS = { tiger: ["token"], webull: ["accountId", "region"] };
// 需要用户在券商页面授权（OAuth）的券商：建账户时不立即同步，令牌由授权流程写回加密凭证
export const OAUTH_BROKERS = ["schwab", "etrade"];
const BROKER_NAMES = { longbridge: "Longbridge", ibkr: "IBKR", tiger: "Tiger", schwab: "Schwab", etrade: "E*TRADE", webull: "Webull" };
const MAX_CRED_LEN = { privateKey: 8192 }; // RSA 私钥 PEM 比别的凭证长

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

// 目标仓位计划：
//   targets = { 腾讯格式代码: 目标占总资产 % }，cash = 现金目标 %（可空）
//   容忍带按「5/25 规则」：偏离超过 band 个百分点，或超过目标的 rel%，二者先到为准
//   可选两层配置扩展（未设置时省略，保持旧版 JSON 结构兼容）：
//   buckets = [{ id, name, target|null, isCash? }]
//   assetClass = { symbol: bucketId }
//   allocOnly = [symbol, ...]（配置型资产，免个股估值覆盖率扣分）
//   schedule = { freq: monthly|quarterly|semiannual|annual, lastRebalancedAt?: YYYY-MM-DD }
//   guardrail = boolean（再平衡默认是否开启估值护栏）
//   rebalanceLog = [{ date, mode, scope?, cashAdded?, note? }]（最近 24 条）
const SYM_RE = /^(us|hk|sh|sz|bj)[A-Za-z0-9.]{1,12}$/;
const BUCKET_ID_RE = /^[a-z0-9_-]{1,24}$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FREQS = ["none", "monthly", "quarterly", "semiannual", "annual"];
export const PLAN_DEFAULTS = { targets: {}, cash: null, band: 5, rel: 25 };
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

  // 可选：指标条件提醒（如「股债性价比 ≥ 历史 95% 分位 → 触发提醒」，可选关联推荐情景方案）
  const ALERT_METRICS = ["cn_erp", "us_erp", "hk_erp", "cn_level", "us_level", "hk_level", "cn_pe", "hk_pe", "cape", "buffett", "cn10y", "us10y", "us_real10y"];
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
async function readPlan(env, uid) {
  return { ...PLAN_DEFAULTS, ...await readStoredPlan(env, uid) };
}

function credHint(broker, creds) {
  if (!creds) return "";
  const v = { longbridge: creds.appKey, ibkr: creds.queryId, tiger: creds.account, schwab: creds.appKey, etrade: creds.consumerKey, webull: creds.appKey }[broker] || "";
  return v ? "…" + String(v).slice(-4) : "";
}

function rowToAccount(r, hint) {
  return { id: r.id, broker: r.broker, name: r.name, hasCreds: !!r.cred_enc, credHint: hint || "", lastSyncAt: r.last_sync_at, lastError: r.last_error, createdAt: r.created_at };
}

// 持仓股票默认就在自选里：把还没在用户自选（items）里的持仓标的补进去（未估值，安全边际 / 泡沫阈值取用户设置的默认值），排在最后。返回补了几只
export async function ensureOnBoard(env, uid) {
  const db = env.DB;
  const [hs, { results: its }, { results: st }] = await Promise.all([
    readHoldings(env, uid),
    db.prepare("SELECT symbol, sort_order FROM items WHERE user_id=?").bind(uid).all(),
    db.prepare("SELECT key, value FROM settings WHERE user_id=? AND key IN ('default_mos','default_ext')").bind(uid).all(),
  ]);
  const have = new Set((its || []).map((r) => r.symbol));
  const missing = new Map();
  for (const h of hs || []) if (SYM_RE.test(h.symbol) && !have.has(h.symbol) && !missing.has(h.symbol)) missing.set(h.symbol, h.name || "");
  if (!missing.size) return 0;
  const set = Object.fromEntries((st || []).map((r) => [r.key, Number(r.value)]));
  const mos = set.default_mos > 0 ? set.default_mos : 50, ext = set.default_ext > 0 ? set.default_ext : 40;
  let order = Math.max(-1, ...(its || []).map((r) => Number(r.sort_order) || 0)) + 1;
  const now = new Date().toISOString();
  await db.batch([...missing].map(([sym, name]) =>
    db.prepare("INSERT INTO items (user_id,ticker,name,symbol,fair_low,fair_high,mos,ext,sort_order,valuations,selected_valuation_id,updated_at) VALUES (?,?,?,?,0,0,?,?,?,'[]',NULL,?)")
      .bind(uid, sym.slice(2).toUpperCase(), name.slice(0, 60), sym, mos, ext, order++, now)));
  return missing.size;
}

// 汇率：Frankfurter（欧洲央行参考汇率，免 key），换成 1 单位外币 = ? 单位 base。拿不到就返回 null（前端提示）
async function fxRates(base, currencies) {
  const need = [...new Set(currencies.filter((c) => c && c !== base))];
  const rates = { [base]: 1 };
  if (!need.length) return rates;
  try {
    const res = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(base)}&to=${need.map(encodeURIComponent).join(",")}`, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    for (const c of need) if (j.rates && j.rates[c] > 0) rates[c] = 1 / j.rates[c];
  } catch (e) { console.error("fx failed:", e && e.message); }
  return rates;
}

/**
 * 注册 Portfolio 路由。
 * @param app       Hono 实例（/api/my/* 的登录中间件需已挂好）
 * @param adapters  { longbridge(creds), ibkr(creds), tiger(creds), schwab(creds), etrade(creds), webull(creds), csv(text) }
 *                  → { positions, cash, unsupported, errors?, creds? }（creds：刷新过的令牌，会重新加密保存）
 *                  adapters.oauth[broker] = { start(creds, {redirectUri, state}) → {url, verifier?, pending?}, finish(creds, input, {redirectUri}) → creds }
 * @param getQuotes async (env, symbols) → { quotes: {sym: price}, prevClose: {sym: price}, source }
 */
export function registerPortfolio(app, { adapters, getQuotes }) {
  app.use("/api/my/portfolio", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.use("/api/my/portfolio/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  const own = async (c, id) => c.env.DB.prepare("SELECT * FROM broker_accounts WHERE id=? AND user_id=?").bind(id, c.get("uid")).first();
  const key = (c) => c.env.CREDENTIALS_KEY;

  // 账户列表（不含凭证明文）
  app.get("/api/my/portfolio/accounts", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT * FROM broker_accounts WHERE user_id=? ORDER BY id ASC").bind(c.get("uid")).all();
    const out = [];
    for (const r of results || []) {
      let hint = "";
      if (r.cred_enc) { try { hint = credHint(r.broker, await decryptJson(key(c), r.cred_enc)); } catch { hint = ""; } }
      out.push(rowToAccount(r, hint));
    }
    return c.json({ accounts: out });
  });

  // 新建账户：长桥 / IBKR / 老虎需带凭证（加密后入库，随后立即尝试同步一次）；manual 不需要
  app.post("/api/my/portfolio/accounts", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const broker = String(body.broker || "");
    if (!BROKERS.includes(broker)) return c.json({ ok: false, error: "unknown broker" }, 400);
    const name = String(body.name || "").trim().slice(0, 40) || (BROKER_NAMES[broker] || "Manual");
    const v = validateCreds(broker, body.creds);
    if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
    let enc = null;
    if (v.value) {
      try { enc = await encryptJson(key(c), v.value); }
      catch (e) { return c.json({ ok: false, error: "credential storage is not configured on the server" }, 500); }
    }
    const { meta } = await c.env.DB.prepare("INSERT INTO broker_accounts (user_id,broker,name,cred_enc,created_at) VALUES (?,?,?,?,?)")
      .bind(c.get("uid"), broker, name, enc, new Date().toISOString()).run();
    const id = meta.last_row_id;
    const needsAuth = OAUTH_BROKERS.includes(broker);
    const sync = broker === "manual" || needsAuth ? null : await syncAccount(c, id);
    return c.json({ ok: true, id, sync, needsAuth }, 201);
  });

  // 改名 / 换凭证
  app.put("/api/my/portfolio/accounts/:id", async (c) => {
    const acc = await own(c, c.req.param("id"));
    if (!acc) return c.json({ ok: false }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name === "string") await c.env.DB.prepare("UPDATE broker_accounts SET name=? WHERE id=?").bind(body.name.trim().slice(0, 40), acc.id).run();
    if (body.creds !== undefined && CRED_FIELDS[acc.broker]) {
      const v = validateCreds(acc.broker, body.creds);
      if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
      await c.env.DB.prepare("UPDATE broker_accounts SET cred_enc=?, last_error=NULL WHERE id=?").bind(await encryptJson(key(c), v.value), acc.id).run();
    }
    return c.json({ ok: true });
  });

  app.delete("/api/my/portfolio/accounts/:id", async (c) => {
    const acc = await own(c, c.req.param("id"));
    if (!acc) return c.json({ ok: false }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM holdings WHERE account_id=?").bind(acc.id),
      c.env.DB.prepare("DELETE FROM cash_balances WHERE account_id=?").bind(acc.id),
      c.env.DB.prepare("DELETE FROM broker_accounts WHERE id=?").bind(acc.id),
    ]);
    return c.json({ ok: true });
  });

  // 从券商拉取最新持仓 / 现金，整体替换快照（请求里和每日定时任务里共用，所以只依赖 env + uid）
  async function syncAccountFor(env, uid, id) {
    const acc = await env.DB.prepare("SELECT * FROM broker_accounts WHERE id=? AND user_id=?").bind(id, uid).first();
    if (!acc) return { ok: false, error: "not found", status: 404 };
    const fn = adapters[acc.broker];
    if (!fn || !acc.cred_enc) return { ok: false, error: "this account has nothing to sync", status: 400 };
    const now = new Date().toISOString();
    try {
      const creds = await decryptJson(env.CREDENTIALS_KEY, acc.cred_enc);
      const snap = await fn(creds);
      if (snap.creds) await env.DB.prepare("UPDATE broker_accounts SET cred_enc=? WHERE id=?").bind(await encryptJson(env.CREDENTIALS_KEY, snap.creds), acc.id).run(); // 刷新过的令牌
      await replaceSnapshot(env, uid, acc.id, snap);
      await ensureOnBoard(env, uid);
      await env.DB.prepare("UPDATE broker_accounts SET last_sync_at=?, last_error=NULL WHERE id=?").bind(now, acc.id).run();
      return { ok: true, positions: snap.positions.length, cash: snap.cash.length, unsupported: (snap.unsupported || []).length };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      await env.DB.prepare("UPDATE broker_accounts SET last_error=? WHERE id=?").bind(msg, acc.id).run();
      return { ok: false, error: msg, status: 502 };
    }
  }
  const syncAccount = (c, id) => syncAccountFor(c.env, c.get("uid"), id);
  app.post("/api/my/portfolio/accounts/:id/sync", async (c) => {
    const r = await syncAccount(c, c.req.param("id"));
    return c.json(r, r.ok ? 200 : (r.status || 500));
  });

  // ---------- OAuth 授权（嘉信 / E*TRADE）----------
  // 回调地址固定为本站 /api/my/portfolio/oauth/callback（嘉信要求在开发者应用里登记完全一致的地址）
  const callbackUrl = (c) => new URL(c.req.url).origin + "/api/my/portfolio/oauth/callback";
  async function finishAuth(c, acc, creds, input) {
    const next = await adapters.oauth[acc.broker].finish(creds, input, { redirectUri: callbackUrl(c) });
    await c.env.DB.prepare("UPDATE broker_accounts SET cred_enc=?, last_error=NULL WHERE id=?").bind(await encryptJson(key(c), next), acc.id).run();
    return syncAccount(c, acc.id);
  }
  app.post("/api/my/portfolio/accounts/:id/oauth/start", async (c) => {
    const acc = await own(c, c.req.param("id"));
    if (!acc) return c.json({ ok: false }, 404);
    const flow = adapters.oauth && adapters.oauth[acc.broker];
    if (!flow || !acc.cred_enc) return c.json({ ok: false, error: "this account does not use authorization" }, 400);
    try {
      const creds = await decryptJson(key(c), acc.cred_enc);
      const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const r = await flow.start(creds, { redirectUri: callbackUrl(c), state });
      const { oauthState, requestToken, requestSecret, ...base } = creds; // 清掉上一次没完成的授权
      await c.env.DB.prepare("UPDATE broker_accounts SET cred_enc=? WHERE id=?").bind(await encryptJson(key(c), { ...base, oauthState: state, ...(r.pending || {}) }), acc.id).run();
      return c.json({ ok: true, url: r.url, verifier: !!r.verifier, redirectUri: callbackUrl(c) });
    } catch (e) {
      return c.json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 502);
    }
  });
  // E*TRADE：用户把授权页给的验证码交回来
  app.post("/api/my/portfolio/accounts/:id/oauth/finish", async (c) => {
    const acc = await own(c, c.req.param("id"));
    if (!acc) return c.json({ ok: false }, 404);
    if (!(adapters.oauth && adapters.oauth[acc.broker]) || !acc.cred_enc) return c.json({ ok: false, error: "this account does not use authorization" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const verifier = typeof body.verifier === "string" ? body.verifier.trim() : "";
    if (!verifier || verifier.length > 64) return c.json({ ok: false, error: "missing verification code" }, 400);
    try {
      const sync = await finishAuth(c, acc, await decryptJson(key(c), acc.cred_enc), { verifier });
      return c.json({ ok: true, sync });
    } catch (e) {
      return c.json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 502);
    }
  });
  // 嘉信：浏览器从授权页跳回这里（带 code 与 state），换令牌、同步，再回到资产页
  app.get("/api/my/portfolio/oauth/callback", async (c) => {
    const code = c.req.query("code") || "", state = c.req.query("state") || "";
    const back = (q) => c.redirect("/portfolio?" + new URLSearchParams(q));
    if (!code || !/^[0-9a-f]{32}$/.test(state)) return back({ oauth_error: c.req.query("error_description") || c.req.query("error") || "missing code" });
    const { results } = await c.env.DB.prepare("SELECT * FROM broker_accounts WHERE user_id=? AND cred_enc IS NOT NULL").bind(c.get("uid")).all();
    for (const acc of results || []) {
      if (!(adapters.oauth && adapters.oauth[acc.broker])) continue;
      let creds;
      try { creds = await decryptJson(key(c), acc.cred_enc); } catch { continue; }
      if (creds.oauthState !== state) continue;
      try {
        const sync = await finishAuth(c, acc, creds, { code });
        return back(sync && sync.ok ? { connected: acc.id } : { connected: acc.id, oauth_error: (sync && sync.error) || "sync failed" });
      } catch (e) {
        await c.env.DB.prepare("UPDATE broker_accounts SET last_error=? WHERE id=?").bind(String((e && e.message) || e).slice(0, 300), acc.id).run();
        return back({ oauth_error: String((e && e.message) || e).slice(0, 200) });
      }
    }
    return back({ oauth_error: "authorization session not found — start again from the account menu" });
  });

  // 手动账户：直接提交持仓 / 现金（整体替换）
  app.put("/api/my/portfolio/accounts/:id/holdings", async (c) => {
    const acc = await own(c, c.req.param("id"));
    if (!acc) return c.json({ ok: false }, 404);
    if (acc.broker !== "manual") return c.json({ ok: false, error: "only manual accounts can be edited" }, 400);
    const v = validateSnapshot(await c.req.json().catch(() => ({})));
    if (v.errors.length) return c.json({ ok: false, errors: v.errors }, 400);
    await replaceSnapshot(c.env, c.get("uid"), acc.id, v);
    await ensureOnBoard(c.env, c.get("uid"));
    await c.env.DB.prepare("UPDATE broker_accounts SET last_sync_at=? WHERE id=?").bind(new Date().toISOString(), acc.id).run();
    return c.json({ ok: true });
  });

  // 手动账户：导入券商导出的 CSV 对账单（整体替换持仓，现金保留）
  app.post("/api/my/portfolio/accounts/:id/import", async (c) => {
    const acc = await own(c, c.req.param("id"));
    if (!acc) return c.json({ ok: false }, 404);
    if (acc.broker !== "manual") return c.json({ ok: false, error: "only manual accounts can import" }, 400);
    const { text } = await c.req.json().catch(() => ({}));
    if (typeof text !== "string" || !text.trim() || text.length > 1_000_000) return c.json({ ok: false, error: "empty or too large" }, 400);
    const parsed = adapters.csv(text);
    const results = await readCash(c.env, c.get("uid"), acc.id);
    const v = validateSnapshot({ positions: parsed.positions, cash: results || [] });
    await replaceSnapshot(c.env, c.get("uid"), acc.id, v);
    await ensureOnBoard(c.env, c.get("uid"));
    await c.env.DB.prepare("UPDATE broker_accounts SET last_sync_at=? WHERE id=?").bind(new Date().toISOString(), acc.id).run();
    return c.json({ ok: true, imported: v.positions.length, unsupported: parsed.unsupported || [], errors: [...(parsed.errors || []), ...v.errors] });
  });

  // 汇总所需的全部原始数据：账户 + 持仓 + 现金 + 现价 + 汇率（折算到 base）+ 本人看板上的估值区间
  // 金额汇总、区间归类在前端用 /shared/core.js 算（与看板同一套逻辑）
  app.get("/api/my/portfolio", async (c) => {
    const uid = c.get("uid");
    const base = CUR_RE.test(c.req.query("base") || "") ? c.req.query("base") : "USD";
    const db = c.env.DB;
    await ensureOnBoard(c.env, uid); // 兜底：之前的持仓也补进自选
    const [{ results: accs }, hs, cs, { results: its }] = await Promise.all([
      db.prepare("SELECT * FROM broker_accounts WHERE user_id=? ORDER BY id ASC").bind(uid).all(),
      readHoldings(c.env, uid),
      readCash(c.env, uid),
      db.prepare("SELECT ticker,name,symbol,fair_low,fair_high,mos,ext FROM items WHERE user_id=?").bind(uid).all(),
    ]);
    const holdings = (hs || []).map((h) => ({ accountId: h.account_id, symbol: h.symbol, name: h.name, quantity: h.quantity, costPrice: h.cost_price, currency: h.currency, market: h.market }));
    const cash = (cs || []).map((r) => ({ accountId: r.account_id, currency: r.currency, amount: r.amount }));
    const plan = await readPlan(c.env, uid);
    // 计划建仓的标的（有目标、还没持有）也要报价，用来算「约需买入多少股」
    const symbols = [...new Set([...holdings.map((h) => h.symbol), ...Object.keys(plan.targets)])];
    const q = symbols.length ? await getQuotes(c.env, symbols) : { quotes: {}, prevClose: {} };
    const planCur = Object.keys(plan.targets).map((sym) => sym.startsWith("us") ? "USD" : sym.startsWith("hk") ? "HKD" : "CNY");
    const fx = await fxRates(base, [...holdings.map((h) => h.currency), ...cash.map((r) => r.currency), ...planCur]);
    // 顺手记下今天的快照（不阻塞响应；同一天重复打开只会覆盖当天那一行）
    try { c.executionCtx.waitUntil(recordSnapshot(c.env, uid).catch((e) => console.error("snapshot failed:", e && e.message))); } catch { /* 测试环境可能没有 executionCtx */ }
    c.header("Cache-Control", "no-store");
    return c.json({
      base, fx,
      accounts: (accs || []).map((r) => rowToAccount(r, "")),
      holdings, cash,
      quotes: q.quotes || {}, prevClose: q.prevClose || {}, source: q.source || "tencent",
      items: (its || []).map((r) => ({ ticker: r.ticker, name: r.name, symbol: r.symbol, fairLow: r.fair_low, fairHigh: r.fair_high, mos: r.mos, ext: r.ext })),
      plan,
      ts: new Date().toISOString(),
    });
  });

  // ---------- 目标仓位 ----------
  app.get("/api/my/portfolio/plan", async (c) => c.json({ plan: await readPlan(c.env, c.get("uid")) }));
  app.put("/api/my/portfolio/plan", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { error, plan } = validatePlan(body);
    if (error) return c.json({ error }, 400);
    await writePlan(c.env, c.get("uid"), plan);
    return c.json({ ok: true, plan });
  });
  // 记录一次已完成再平衡（更新上次复盘日期并追加加密日志，最多保留 24 条）
  app.post("/api/my/portfolio/rebalance/mark", async (c) => {
    const uid = c.get("uid");
    const body = await c.req.json().catch(() => ({}));
    const cur = await readPlan(c.env, uid);
    const today = typeof body.date === "string" && ISO_DAY_RE.test(body.date.trim()) ? body.date.trim() : utcToday();
    const mode = body.mode === "cashflow" ? "cashflow" : "standard";
    const scope = body.scope === "bucket" || body.scope === "symbol" ? body.scope : undefined;
    const cashAdded = Number.isFinite(Number(body.cashAdded)) && Number(body.cashAdded) > 0 ? Math.round(Number(body.cashAdded) * 100) / 100 : undefined;
    const note = typeof body.note === "string" ? body.note.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    const entry = { date: today, mode, ...(scope ? { scope } : {}), ...(cashAdded ? { cashAdded } : {}), ...(note ? { note } : {}) };
    const nextSchedule = { freq: cur.schedule?.freq || "none", lastRebalancedAt: today };
    const nextLog = [entry, ...(Array.isArray(cur.rebalanceLog) ? cur.rebalanceLog : [])].slice(0, 24);
    const next = { ...cur, schedule: nextSchedule, rebalanceLog: nextLog };
    const v = validatePlan(next);
    if (v.error) return c.json({ error: v.error }, 400);
    await writePlan(c.env, uid, v.plan);
    return c.json({ ok: true, plan: v.plan });
  });

  // ---------- 资产曲线：每日快照 ----------
  // 按当前持仓 × 现价 + 现金算出每个账户与合计的价值，按当天汇率折成 USD / HKD / CNY 各存一份
  async function recordSnapshot(env, uid) {
    const db = env.DB;
    const [{ results: accs }, hs, cs] = await Promise.all([
      db.prepare("SELECT id FROM broker_accounts WHERE user_id=?").bind(uid).all(),
      readHoldings(env, uid),
      readCash(env, uid),
    ]);
    if (!(accs || []).length) return null;
    const symbols = [...new Set((hs || []).map((h) => h.symbol))];
    const q = symbols.length ? await getQuotes(env, symbols) : { quotes: {} };
    const fx = await fxRates("USD", ["HKD", "CNY", ...(hs || []).map((h) => h.currency), ...(cs || []).map((r) => r.currency)]);
    if (!(fx.HKD > 0 && fx.CNY > 0)) return null; // 没有汇率就不记，避免写进错误数据
    const per = new Map((accs || []).map((a) => [a.id, 0]));
    for (const h of hs || []) { const p = q.quotes[h.symbol], r = fx[h.currency]; if (p > 0 && r > 0) per.set(h.account_id, per.get(h.account_id) + h.quantity * p * r); }
    for (const c of cs || []) { const r = fx[c.currency]; if (r > 0) per.set(c.account_id, per.get(c.account_id) + c.amount * r); }
    const day = utcToday();
    const rows = [...per.entries(), [0, [...per.values()].reduce((a, v) => a + v, 0)]];
    await db.batch(await Promise.all(rows.map(([aid, usd]) => historyStatement(env, uid, day, aid,
      { USD: usd, HKD: usd / fx.HKD, CNY: usd / fx.CNY }))));
    // 删除了的账户：去掉它当天的旧快照行，避免曲线里残留
    await db.prepare(`DELETE FROM portfolio_snapshots WHERE user_id=? AND day=? AND account_id<>0 AND account_id NOT IN (${[...per.keys()].map(() => "?").join(",") || "NULL"})`).bind(uid, day, ...per.keys()).run();
    return { day, total: rows[rows.length - 1][1] };
  }

  // 资产曲线数据：合计与各账户，按日期升序；cur 选 USD / HKD / CNY
  app.get("/api/my/portfolio/history", async (c) => {
    const days = Math.max(7, Math.min(3660, parseInt(c.req.query("days"), 10) || 365));
    const since = utcDaysAgo(days);
    const points = await readHistory(c.env, c.get("uid"), since);
    c.header("Cache-Control", "no-store");
    return c.json({ points });
  });

  // 每日定时任务：同步所有用户的券商账户，再给每个有账户的用户记一笔快照
  async function runDaily(env) {
    const { results: accs } = await env.DB.prepare("SELECT id, user_id, broker FROM broker_accounts").all();
    const users = new Set();
    for (const a of accs || []) {
      users.add(a.user_id);
      if (a.broker !== "manual") { try { await syncAccountFor(env, a.user_id, a.id); } catch (e) { console.error("daily sync failed:", a.id, e && e.message); } }
    }
    for (const uid of users) { try { await recordSnapshot(env, uid); } catch (e) { console.error("daily snapshot failed:", uid, e && e.message); } }
  }

  return { recordSnapshot, runDaily };
}
