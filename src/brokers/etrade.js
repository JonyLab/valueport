// E*TRADE API：OAuth 1.0a（HMAC-SHA1，用户自己的 Consumer Key / Secret，oob 验证码），
// 访问令牌在美东午夜失效、闲置 2 小时需续期——所以每天要重新授权一次；
// 账户列表 /v1/accounts/list.json → 每个经纪账户的 portfolio.json + balance.json。

import { toNum, sumCash, mergePositions } from "./common.js";

export const ETRADE_API = "https://api.etrade.com";
export const ETRADE_AUTHORIZE = "https://us.etrade.com/e/t/etws/authorize";

/* ---------- OAuth 1.0a ---------- */
// RFC 3986 百分号编码
export const pct = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function hmacSha1(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 签名基串：METHOD&url&排序后的参数（查询参数 + oauth_*）
export function oauthBaseString(method, url, params) {
  const enc = Object.entries(params).map(([k, v]) => [pct(k), pct(v)]);
  enc.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return [method.toUpperCase(), pct(url), pct(enc.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
}

// 生成 Authorization: OAuth … 头。o = { consumerKey, consumerSecret, token?, tokenSecret?, extra? }
export async function oauthHeader(method, url, query, o, { nonce, timestamp } = {}) {
  const oauth = {
    oauth_consumer_key: o.consumerKey,
    oauth_nonce: nonce || crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(o.token ? { oauth_token: o.token } : {}),
    ...(o.extra || {}),
  };
  const base = oauthBaseString(method, url, { ...query, ...oauth });
  oauth.oauth_signature = await hmacSha1(`${pct(o.consumerSecret)}&${pct(o.tokenSecret || "")}`, base);
  return "OAuth " + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(",");
}

function authError(msg) { const e = new Error(msg); e.needsAuth = true; return e; }

async function oauthGet(path, query, o, { fetchImpl = fetch, nonce, timestamp } = {}) {
  const url = ETRADE_API + path;
  const qs = new URLSearchParams(query).toString();
  const headers = { Authorization: await oauthHeader("GET", url, query, o, { nonce, timestamp }), Accept: "application/json" };
  try { return await fetchImpl(qs ? `${url}?${qs}` : url, { headers }); }
  catch (e) { throw new Error(`etrade ${path}: network error (${e.message})`); }
}

async function tokenCall(path, o, opts) {
  const res = await oauthGet(path, {}, o, opts);
  const text = await res.text();
  if (res.status === 401) throw authError(`etrade: authorization rejected — check the consumer key / verification code and reconnect`);
  if (!res.ok) throw new Error(`etrade ${path}: HTTP ${res.status}`);
  const f = new URLSearchParams(text);
  if (!f.get("oauth_token") || !f.get("oauth_token_secret")) throw new Error(`etrade ${path}: invalid response`);
  return { token: f.get("oauth_token"), secret: f.get("oauth_token_secret") };
}

// 第一步：取 request token，返回授权页地址 + 需暂存的 request token
export async function etradeStart(creds, opts = {}) {
  const t = await tokenCall("/oauth/request_token", { consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, extra: { oauth_callback: "oob" } }, opts);
  return { url: `${ETRADE_AUTHORIZE}?key=${pct(creds.consumerKey)}&token=${pct(t.token)}`, requestToken: t.token, requestSecret: t.secret };
}

// 第二步：用户在 E*TRADE 授权页拿到的验证码换 access token，返回新凭证
export async function etradeFinish(creds, verifier, opts = {}) {
  if (!creds.requestToken || !creds.requestSecret) throw new Error("etrade: start the authorization first");
  const t = await tokenCall("/oauth/access_token", {
    consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret,
    token: creds.requestToken, tokenSecret: creds.requestSecret, extra: { oauth_verifier: String(verifier).trim() },
  }, opts);
  return { consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, accessToken: t.token, accessSecret: t.secret, authorizedAt: opts.now || Date.now() };
}

/* ---------- 解析 ---------- */
const STOCK_TYPES = new Set(["EQ", "ETF"]);

export function parseEtradeAccounts(json) {
  const accs = (((json || {}).AccountListResponse || {}).Accounts || {}).Account;
  const list = Array.isArray(accs) ? accs : accs ? [accs] : [];
  return list.filter((a) => a && a.accountIdKey && String(a.accountStatus || "ACTIVE").toUpperCase() !== "CLOSED"
    && String(a.institutionType || "BROKERAGE").toUpperCase() === "BROKERAGE");
}

// PortfolioResponse → { rows, unsupported, totalPages }
export function parseEtradePortfolio(json) {
  const rows = [], unsupported = [];
  let totalPages = 1;
  for (const ap of ((json || {}).PortfolioResponse || {}).AccountPortfolio || []) {
    if (ap && Number(ap.totalPages) > totalPages) totalPages = Number(ap.totalPages);
    for (const p of (ap && ap.Position) || []) {
      const prod = (p && p.Product) || {};
      const type = String(prod.securityType || "").toUpperCase();
      const raw = `${prod.symbol || p.symbolDescription || "?"}(${type || "?"})`;
      if (!STOCK_TYPES.has(type)) { unsupported.push({ raw, reason: "security type " + (type || "?") }); continue; }
      const t = String(prod.symbol || "").trim().toUpperCase().replace(/[/\s]+/g, ".");
      if (!/^[A-Z][A-Z0-9.\-]*$/.test(t)) { unsupported.push({ raw, reason: "bad US ticker" }); continue; }
      let qty = toNum(p.quantity);
      if (String(p.positionType || "").toUpperCase() === "SHORT" && qty > 0) qty = -qty;
      if (!Number.isFinite(qty) || qty === 0) { unsupported.push({ raw, reason: "invalid quantity" }); continue; }
      const cost = [p.costPerShare, p.pricePaid].map(toNum).find((v) => Number.isFinite(v) && v > 0);
      rows.push({ symbol: "us" + t, name: String(p.symbolDescription || "").slice(0, 80), quantity: qty, costPrice: cost ?? NaN, currency: "USD", market: "US" });
    }
  }
  return { rows, unsupported, totalPages };
}

export function parseEtradeBalance(json) {
  const c = (((json || {}).BalanceResponse || {}).Computed) || {};
  const v = [c.cashBalance, c.cashAvailableForInvestment].map(toNum).find(Number.isFinite);
  return Number.isFinite(v) ? v : NaN;
}

/* ---------- 主入口 ---------- */
export async function fetchEtradeAssets(creds, opts = {}) {
  if (!creds || !creds.consumerKey || !creds.consumerSecret) throw new Error("etrade: missing credentials");
  if (!creds.accessToken || !creds.accessSecret) throw authError("etrade: not authorized yet — click Authorize to connect the account");
  const o = { consumerKey: creds.consumerKey, consumerSecret: creds.consumerSecret, token: creds.accessToken, tokenSecret: creds.accessSecret };
  const getJson = async (path, query = {}) => {
    const res = await oauthGet(path, query, o, opts);
    if (res.status === 204) return null; // 空持仓
    if (res.status === 401) throw authError("etrade: authorization expired (E*TRADE tokens expire at midnight US Eastern) — reconnect the account");
    if (!res.ok) throw new Error(`etrade ${path}: HTTP ${res.status}`);
    try { return await res.json(); } catch { throw new Error(`etrade ${path}: invalid response`); }
  };
  // 闲置超过 2 小时的令牌需要续期；续期失败多半是已过午夜失效
  const renew = await oauthGet("/oauth/renew_access_token", {}, o, opts);
  if (renew.status === 401) throw authError("etrade: authorization expired (E*TRADE tokens expire at midnight US Eastern) — reconnect the account");

  const accounts = parseEtradeAccounts(await getJson("/v1/accounts/list.json"));
  const rows = [], unsupported = [], pairs = [];
  for (const a of accounts) {
    const key = encodeURIComponent(a.accountIdKey);
    for (let page = 1, pages = 1; page <= pages && page <= 20; page++) {
      const r = parseEtradePortfolio(await getJson(`/v1/accounts/${key}/portfolio.json`, { count: "100", pageNumber: String(page), view: "QUICK" }));
      rows.push(...r.rows); unsupported.push(...r.unsupported); pages = r.totalPages;
    }
    pairs.push(["USD", parseEtradeBalance(await getJson(`/v1/accounts/${key}/balance.json`, { instType: "BROKERAGE", realTimeNAV: "true" }))]);
  }
  return { positions: mergePositions(rows), cash: sumCash(pairs), unsupported };
}
