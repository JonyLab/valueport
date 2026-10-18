// 嘉信 Schwab Trader API：OAuth2（用户自己的 App Key / Secret，回调到本站），
// 访问令牌约 30 分钟、刷新令牌 7 天（过期只能重新授权）；持仓 GET /trader/v1/accounts?fields=positions。

import { toNum, sumCash, mergePositions } from "./common.js";

export const SCHWAB_AUTHORIZE = "https://api.schwabapi.com/v1/oauth/authorize";
export const SCHWAB_TOKEN = "https://api.schwabapi.com/v1/oauth/token";
export const SCHWAB_API = "https://api.schwabapi.com/trader/v1";
const REFRESH_TTL = 7 * 86400e3;

export function schwabAuthorizeUrl(appKey, redirectUri, state) {
  const q = new URLSearchParams({ response_type: "code", client_id: appKey, redirect_uri: redirectUri, state });
  return `${SCHWAB_AUTHORIZE}?${q}`;
}

function authError(msg) { const e = new Error(msg); e.needsAuth = true; return e; }

async function tokenRequest(creds, form, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(SCHWAB_TOKEN, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${creds.appKey}:${creds.appSecret}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (e) { throw new Error(`schwab token: network error (${e.message})`); }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.access_token) {
    const why = j && (j.error_description || j.error) ? `: ${String(j.error_description || j.error).slice(0, 160)}` : "";
    if (res.status === 400 || res.status === 401) throw authError(`schwab: authorization rejected${why} — reconnect the account`);
    throw new Error(`schwab token: HTTP ${res.status}${why}`);
  }
  return j;
}

// 授权回调：用 code 换令牌，返回带令牌的新凭证
export async function schwabExchangeCode(creds, code, redirectUri, { fetchImpl = fetch, now = Date.now() } = {}) {
  const j = await tokenRequest(creds, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, fetchImpl);
  return {
    appKey: creds.appKey, appSecret: creds.appSecret,
    accessToken: j.access_token, refreshToken: j.refresh_token,
    accessExpiresAt: now + (Number(j.expires_in) || 1800) * 1000,
    refreshExpiresAt: now + REFRESH_TTL,
  };
}

// 访问令牌快过期（留 60 秒余量）就用刷新令牌换新的；返回 [creds, changed]
async function ensureAccess(creds, fetchImpl, now) {
  if (!creds.refreshToken) throw authError("schwab: not authorized yet — click Authorize to connect the account");
  if (creds.refreshExpiresAt && now > creds.refreshExpiresAt) throw authError("schwab: authorization expired (Schwab requires signing in again every 7 days) — reconnect the account");
  if (creds.accessToken && creds.accessExpiresAt && now < creds.accessExpiresAt - 60e3) return [creds, false];
  const j = await tokenRequest(creds, { grant_type: "refresh_token", refresh_token: creds.refreshToken }, fetchImpl);
  return [{
    ...creds,
    accessToken: j.access_token,
    refreshToken: j.refresh_token || creds.refreshToken,
    accessExpiresAt: now + (Number(j.expires_in) || 1800) * 1000,
  }, true];
}

/* ---------- 解析 ---------- */
const STOCK_TYPES = new Set(["EQUITY", "COLLECTIVE_INVESTMENT", "ETF"]);

// GET /accounts?fields=positions 的数组（或单个账户对象）→ { positions, cash, unsupported }
export function parseSchwabAccounts(json) {
  const list = Array.isArray(json) ? json : json ? [json] : [];
  const rows = [], unsupported = [], pairs = [];
  for (const acc of list) {
    const sa = acc && acc.securitiesAccount;
    if (!sa) continue;
    for (const p of sa.positions || []) {
      const ins = (p && p.instrument) || {};
      const type = String(ins.assetType || "").toUpperCase();
      const raw = `${ins.symbol || "?"}(${type || "?"})`;
      const qty = toNum(p.longQuantity || 0) - toNum(p.shortQuantity || 0);
      if (type === "CASH_EQUIVALENT") { pairs.push(["USD", toNum(p.marketValue)]); continue; } // 货币基金扫单：算现金
      if (!STOCK_TYPES.has(type)) { unsupported.push({ raw, reason: "asset type " + (type || "?") }); continue; }
      const t = String(ins.symbol || "").trim().toUpperCase().replace(/[/\s]+/g, ".");
      if (!/^[A-Z][A-Z0-9.\-]*$/.test(t)) { unsupported.push({ raw, reason: "bad US ticker" }); continue; }
      if (!Number.isFinite(qty) || qty === 0) { unsupported.push({ raw, reason: "invalid quantity" }); continue; }
      rows.push({ symbol: "us" + t, name: String(ins.description || "").slice(0, 80), quantity: qty, costPrice: toNum(p.averagePrice ?? p.averageLongPrice), currency: "USD", market: "US" });
    }
    const b = sa.currentBalances || {};
    const cash = [b.cashBalance, b.totalCash, b.cashAvailableForTrading].map(toNum).find(Number.isFinite);
    if (Number.isFinite(cash)) pairs.push(["USD", cash]);
    const mmf = toNum(b.moneyMarketFund);
    if (Number.isFinite(mmf) && mmf) pairs.push(["USD", mmf]);
  }
  return { positions: mergePositions(rows), cash: sumCash(pairs), unsupported };
}

/* ---------- 主入口 ---------- */
// 返回快照；令牌刷新过时带上 creds（由调用方重新加密保存）
export async function fetchSchwabAssets(creds, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!creds || !creds.appKey || !creds.appSecret) throw new Error("schwab: missing credentials");
  const [cur, changed] = await ensureAccess(creds, fetchImpl, now);
  let res;
  try { res = await fetchImpl(`${SCHWAB_API}/accounts?fields=positions`, { headers: { Authorization: "Bearer " + cur.accessToken, Accept: "application/json" } }); }
  catch (e) { throw new Error(`schwab accounts: network error (${e.message})`); }
  if (res.status === 401) throw authError("schwab: access token rejected — reconnect the account");
  if (!res.ok) throw new Error(`schwab accounts: HTTP ${res.status}`);
  const json = await res.json().catch(() => { throw new Error("schwab accounts: invalid response"); });
  return { ...parseSchwabAccounts(json), ...(changed ? { creds: cur } : {}) };
}
