// Webull OpenAPI（v1）：App Key / App Secret 做 HMAC-SHA1 签名（与官方 webull-python-sdk 一致），无需令牌。
// 账户 /app/subscriptions/list → 持仓 /account/positions（holdings，翻页）+ 余额 /account/balance。

import { toNum, sumCash, mergePositions } from "./common.js";

export const WEBULL_HOSTS = { us: "api.webull.com", hk: "api.webull.hk" };

// Python quote(s, safe='')：只保留 A-Za-z0-9-._~
const quote = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function hmacSha1B64(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 签名串：path & 排序后的 k=v（签名头 + host + 查询参数，原值不编码）[& 大写 md5(body)]，整体 quote 一次
export function webullSignString(path, signParams) {
  const parts = Object.keys(signParams).sort().map((k) => `${k}=${signParams[k]}`);
  return quote(`${path}&${parts.join("&")}`);
}

// 生成请求头（GET，无 body）
export async function webullHeaders(creds, host, path, query, { now = Date.now(), nonce } = {}) {
  const sign = {
    "x-app-key": creds.appKey,
    "x-timestamp": new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-signature-version": "1.0",
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-nonce": nonce || crypto.randomUUID(),
  };
  const params = { ...sign, host };
  for (const [k, v] of Object.entries(query)) params[k] = params[k] !== undefined ? `${params[k]}&${v}` : String(v);
  const signature = await hmacSha1B64(`${creds.appSecret}&`, webullSignString(path, params));
  return { ...sign, "x-signature": signature, "x-version": "v1", Accept: "application/json" };
}

async function webullGet(creds, host, path, query, opts) {
  const { fetchImpl = fetch } = opts;
  const qs = new URLSearchParams(query).toString();
  let res;
  try { res = await fetchImpl(`https://${host}${path}${qs ? "?" + qs : ""}`, { headers: await webullHeaders(creds, host, path, query, opts) }); }
  catch (e) { throw new Error(`webull ${path}: network error (${e.message})`); }
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    const why = j && (j.message || j.error_code) ? `: ${String(j.error_code || "")} ${String(j.message || "").slice(0, 160)}`.trimEnd() : "";
    throw new Error(`webull ${path}: HTTP ${res.status}${why}`);
  }
  if (j === null) throw new Error(`webull ${path}: invalid response`);
  return j;
}

/* ---------- 解析 ---------- */
// 账户列表：数组，或 { subscriptions / data / accounts: [...] }，取 account_id
export function parseWebullAccountIds(json) {
  const list = Array.isArray(json) ? json : (json && (json.subscriptions || json.data || json.accounts)) || [];
  return [...new Set(list.map((a) => a && (a.account_id || a.accountId)).filter(Boolean).map(String))];
}

const MARKET_BY_TYPE = { US_STOCK: "US", US_ETF: "US", HK_STOCK: "HK", HK_ETF: "HK", CN_STOCK: "CN" };

export function webullToTencent(sym, type, currency) {
  const s = String(sym || "").trim().toUpperCase();
  const t = String(type || "").toUpperCase();
  let m = MARKET_BY_TYPE[t];
  if (!m && (t === "EQUITY" || t === "STOCK" || t === "ETF" || !t)) m = { USD: "US", HKD: "HK", CNY: "CN", CNH: "CN" }[String(currency || "").toUpperCase()];
  if (!s) return { reason: "empty symbol" };
  if (m === "US") {
    const u = s.replace(/[/\s]+/g, ".");
    return /^[A-Z][A-Z0-9.\-]*$/.test(u) ? { symbol: "us" + u, market: "US" } : { reason: "bad US ticker" };
  }
  if (m === "HK") return /^\d{1,5}$/.test(s) ? { symbol: "hk" + s.padStart(5, "0"), market: "HK" } : { reason: "bad HK code" };
  if (m === "CN") {
    if (/^[569]\d{5}$/.test(s)) return { symbol: "sh" + s, market: "CN" };
    if (/^[0-3]\d{5}$/.test(s)) return { symbol: "sz" + s, market: "CN" };
    return { reason: "bad A-share code" };
  }
  return { reason: `unsupported instrument type ${t || "?"}` };
}

const normCur = (c) => { const u = String(c || "").toUpperCase(); return u === "CNH" ? "CNY" : u; };

// /account/positions → { rows, unsupported, holdings }
export function parseWebullPositions(json) {
  const holdings = (json && (json.holdings || json.positions)) || (Array.isArray(json) ? json : []);
  const rows = [], unsupported = [];
  for (const h of holdings) {
    if (!h) continue;
    const raw = `${h.symbol || "?"}(${h.instrument_type || "?"})`;
    const mapped = webullToTencent(h.symbol, h.instrument_type, h.currency);
    if (!mapped.symbol) { unsupported.push({ raw, reason: mapped.reason }); continue; }
    const qty = toNum(h.qty ?? h.quantity);
    if (!Number.isFinite(qty) || qty === 0) { unsupported.push({ raw, reason: "invalid quantity" }); continue; }
    rows.push({ symbol: mapped.symbol, name: String(h.short_name || h.name || "").slice(0, 80), quantity: qty, costPrice: toNum(h.unit_cost ?? h.cost_price),
      currency: normCur(h.currency) || { US: "USD", HK: "HKD", CN: "CNY" }[mapped.market], market: mapped.market });
  }
  return { rows, unsupported, holdings };
}

// /account/balance → [[currency, amount]]；各币种 total_cash（含未交收），否则 cash_balance / balance
export function parseWebullBalance(json) {
  const pairs = [];
  for (const a of (json && json.account_currency_assets) || []) {
    if (!a || !a.currency) continue;
    const v = [a.total_cash, a.cash_balance, a.balance].map(toNum).find(Number.isFinite);
    pairs.push([normCur(a.currency), v]);
  }
  return pairs;
}

/* ---------- 主入口 ---------- */
// creds = { appKey, appSecret, accountId?, region? }；不填账户号就同步订阅列表里的全部账户
export async function fetchWebullAssets(creds, opts = {}) {
  if (!creds || !creds.appKey || !creds.appSecret) throw new Error("webull: missing credentials");
  const host = WEBULL_HOSTS[creds.region || "us"];
  if (!host) throw new Error("webull: unknown region");
  let ids = creds.accountId ? [creds.accountId] : [];
  if (!ids.length) ids = parseWebullAccountIds(await webullGet(creds, host, "/app/subscriptions/list", {}, opts));
  if (!ids.length) throw new Error("webull: no accounts found for this app — check the API subscription in the Webull developer portal");
  const rows = [], unsupported = [], pairs = [];
  for (const id of ids) {
    let last = null;
    for (let page = 0; page < 20; page++) {
      const q = { account_id: id, page_size: "100", ...(last ? { last_instrument_id: last } : {}) };
      const r = parseWebullPositions(await webullGet(creds, host, "/account/positions", q, opts));
      rows.push(...r.rows); unsupported.push(...r.unsupported);
      const tail = r.holdings[r.holdings.length - 1];
      if (r.holdings.length < 100 || !tail || !tail.instrument_id) break;
      last = String(tail.instrument_id);
    }
    pairs.push(...parseWebullBalance(await webullGet(creds, host, "/account/balance", { account_id: id }, opts)));
  }
  return { positions: mergePositions(rows), cash: sumCash(pairs), unsupported };
}
