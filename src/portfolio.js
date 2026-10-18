// Portfolio：每个用户的券商账户 + 持仓 / 现金快照 + 汇总所需的行情与汇率。
// 路由都挂在 /api/my/portfolio 下，复用 /api/my/* 的登录中间件（c.get("uid")），数据严格按 user_id 隔离。
// 凭证只写不读：加密存库（src/crypto.js），接口永远不返回明文，只返回是否已配置 + 末四位提示。
import { encryptJson, decryptJson } from "./crypto.js";

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

// 目标仓位计划：targets = { 腾讯格式代码: 目标占总资产 % }，cash = 现金目标 %（可空），
// 容忍带按「5/25 规则」：偏离超过 band 个百分点，或超过目标的 rel%，二者先到为准
const SYM_RE = /^(us|hk|sh|sz|bj)[A-Za-z0-9.]{1,12}$/;
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
  return { plan: { targets, cash, band, rel } };
}
async function readPlan(db, uid) {
  try {
    const row = await db.prepare("SELECT plan FROM portfolio_plans WHERE user_id=?").bind(uid).first();
    return row ? { ...PLAN_DEFAULTS, ...JSON.parse(row.plan) } : { ...PLAN_DEFAULTS };
  } catch { return { ...PLAN_DEFAULTS }; } // 线上还没跑迁移时不影响资产页
}

function credHint(broker, creds) {
  if (!creds) return "";
  const v = { longbridge: creds.appKey, ibkr: creds.queryId, tiger: creds.account, schwab: creds.appKey, etrade: creds.consumerKey, webull: creds.appKey }[broker] || "";
  return v ? "…" + String(v).slice(-4) : "";
}

function rowToAccount(r, hint) {
  return { id: r.id, broker: r.broker, name: r.name, hasCreds: !!r.cred_enc, credHint: hint || "", lastSyncAt: r.last_sync_at, lastError: r.last_error, createdAt: r.created_at };
}

// 用快照整体替换某账户的持仓与现金（一次 batch，要么全成要么全不成）
async function replaceSnapshot(db, accountId, { positions, cash }) {
  const stmts = [
    db.prepare("DELETE FROM holdings WHERE account_id=?").bind(accountId),
    db.prepare("DELETE FROM cash_balances WHERE account_id=?").bind(accountId),
  ];
  for (const p of positions) {
    stmts.push(db.prepare("INSERT INTO holdings (account_id,symbol,name,quantity,cost_price,currency,market) VALUES (?,?,?,?,?,?,?)")
      .bind(accountId, p.symbol, p.name || "", p.quantity, Number.isFinite(p.costPrice) ? p.costPrice : null, p.currency, p.market || ""));
  }
  // 同币种合并（CSV / 多子账户可能重复）
  const merged = new Map();
  for (const r of cash) merged.set(r.currency, (merged.get(r.currency) || 0) + r.amount);
  for (const [currency, amount] of merged) stmts.push(db.prepare("INSERT INTO cash_balances (account_id,currency,amount) VALUES (?,?,?)").bind(accountId, currency, amount));
  await db.batch(stmts);
}

// 持仓股票默认就在自选里：把还没在用户自选（items）里的持仓标的补进去（未估值，安全边际 / 泡沫阈值取用户设置的默认值），排在最后。返回补了几只
export async function ensureOnBoard(db, uid) {
  const [{ results: hs }, { results: its }, { results: st }] = await Promise.all([
    db.prepare("SELECT h.symbol, h.name FROM holdings h JOIN broker_accounts a ON a.id=h.account_id WHERE a.user_id=?").bind(uid).all(),
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
      await replaceSnapshot(env.DB, acc.id, snap);
      await ensureOnBoard(env.DB, uid);
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
    await replaceSnapshot(c.env.DB, acc.id, v);
    await ensureOnBoard(c.env.DB, c.get("uid"));
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
    const { results } = await c.env.DB.prepare("SELECT currency, amount FROM cash_balances WHERE account_id=?").bind(acc.id).all();
    const v = validateSnapshot({ positions: parsed.positions, cash: results || [] });
    await replaceSnapshot(c.env.DB, acc.id, v);
    await ensureOnBoard(c.env.DB, c.get("uid"));
    await c.env.DB.prepare("UPDATE broker_accounts SET last_sync_at=? WHERE id=?").bind(new Date().toISOString(), acc.id).run();
    return c.json({ ok: true, imported: v.positions.length, unsupported: parsed.unsupported || [], errors: [...(parsed.errors || []), ...v.errors] });
  });

  // 汇总所需的全部原始数据：账户 + 持仓 + 现金 + 现价 + 汇率（折算到 base）+ 本人看板上的估值区间
  // 金额汇总、区间归类在前端用 /shared/core.js 算（与看板同一套逻辑）
  app.get("/api/my/portfolio", async (c) => {
    const uid = c.get("uid");
    const base = CUR_RE.test(c.req.query("base") || "") ? c.req.query("base") : "USD";
    const db = c.env.DB;
    await ensureOnBoard(db, uid); // 兜底：之前的持仓也补进自选
    const [{ results: accs }, { results: hs }, { results: cs }, { results: its }] = await Promise.all([
      db.prepare("SELECT * FROM broker_accounts WHERE user_id=? ORDER BY id ASC").bind(uid).all(),
      db.prepare("SELECT h.* FROM holdings h JOIN broker_accounts a ON a.id=h.account_id WHERE a.user_id=?").bind(uid).all(),
      db.prepare("SELECT b.* FROM cash_balances b JOIN broker_accounts a ON a.id=b.account_id WHERE a.user_id=?").bind(uid).all(),
      db.prepare("SELECT ticker,name,symbol,fair_low,fair_high,mos,ext FROM items WHERE user_id=?").bind(uid).all(),
    ]);
    const holdings = (hs || []).map((h) => ({ accountId: h.account_id, symbol: h.symbol, name: h.name, quantity: h.quantity, costPrice: h.cost_price, currency: h.currency, market: h.market }));
    const cash = (cs || []).map((r) => ({ accountId: r.account_id, currency: r.currency, amount: r.amount }));
    const plan = await readPlan(db, uid);
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
  app.get("/api/my/portfolio/plan", async (c) => c.json({ plan: await readPlan(c.env.DB, c.get("uid")) }));
  app.put("/api/my/portfolio/plan", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { error, plan } = validatePlan(body);
    if (error) return c.json({ error }, 400);
    await c.env.DB.prepare("INSERT INTO portfolio_plans (user_id, plan, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan, updated_at=excluded.updated_at")
      .bind(c.get("uid"), JSON.stringify(plan), new Date().toISOString()).run();
    return c.json({ ok: true, plan });
  });

  // ---------- 资产曲线：每日快照 ----------
  // 按当前持仓 × 现价 + 现金算出每个账户与合计的价值，按当天汇率折成 USD / HKD / CNY 各存一份
  async function recordSnapshot(env, uid) {
    const db = env.DB;
    const [{ results: accs }, { results: hs }, { results: cs }] = await Promise.all([
      db.prepare("SELECT id FROM broker_accounts WHERE user_id=?").bind(uid).all(),
      db.prepare("SELECT h.* FROM holdings h JOIN broker_accounts a ON a.id=h.account_id WHERE a.user_id=?").bind(uid).all(),
      db.prepare("SELECT b.* FROM cash_balances b JOIN broker_accounts a ON a.id=b.account_id WHERE a.user_id=?").bind(uid).all(),
    ]);
    if (!(accs || []).length) return null;
    const symbols = [...new Set((hs || []).map((h) => h.symbol))];
    const q = symbols.length ? await getQuotes(env, symbols) : { quotes: {} };
    const fx = await fxRates("USD", ["HKD", "CNY", ...(hs || []).map((h) => h.currency), ...(cs || []).map((r) => r.currency)]);
    if (!(fx.HKD > 0 && fx.CNY > 0)) return null; // 没有汇率就不记，避免写进错误数据
    const per = new Map((accs || []).map((a) => [a.id, 0]));
    for (const h of hs || []) { const p = q.quotes[h.symbol], r = fx[h.currency]; if (p > 0 && r > 0) per.set(h.account_id, per.get(h.account_id) + h.quantity * p * r); }
    for (const c of cs || []) { const r = fx[c.currency]; if (r > 0) per.set(c.account_id, per.get(c.account_id) + c.amount * r); }
    const day = new Date().toISOString().slice(0, 10);
    const rows = [...per.entries(), [0, [...per.values()].reduce((a, v) => a + v, 0)]];
    await db.batch(rows.map(([aid, usd]) => db.prepare(
      "INSERT INTO portfolio_snapshots (user_id,day,account_id,v_usd,v_hkd,v_cny) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,day,account_id) DO UPDATE SET v_usd=excluded.v_usd, v_hkd=excluded.v_hkd, v_cny=excluded.v_cny"
    ).bind(uid, day, aid, usd, usd / fx.HKD, usd / fx.CNY)));
    // 删除了的账户：去掉它当天的旧快照行，避免曲线里残留
    await db.prepare(`DELETE FROM portfolio_snapshots WHERE user_id=? AND day=? AND account_id<>0 AND account_id NOT IN (${[...per.keys()].map(() => "?").join(",") || "NULL"})`).bind(uid, day, ...per.keys()).run();
    return { day, total: rows[rows.length - 1][1] };
  }

  // 资产曲线数据：合计与各账户，按日期升序；cur 选 USD / HKD / CNY
  app.get("/api/my/portfolio/history", async (c) => {
    const days = Math.max(7, Math.min(3660, parseInt(c.req.query("days"), 10) || 365));
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const { results } = await c.env.DB.prepare("SELECT day, account_id, v_usd, v_hkd, v_cny FROM portfolio_snapshots WHERE user_id=? AND day>=? ORDER BY day ASC")
      .bind(c.get("uid"), since).all();
    c.header("Cache-Control", "no-store");
    return c.json({ points: (results || []).map((r) => ({ day: r.day, accountId: r.account_id, USD: r.v_usd, HKD: r.v_hkd, CNY: r.v_cny })) });
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
