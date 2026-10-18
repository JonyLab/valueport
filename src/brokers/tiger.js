// 老虎证券 Tiger OpenAPI：POST JSON 到网关，公共参数 + biz_content 按 key 排序拼成 k=v&k=v，
// 用开发者 RSA 私钥做 SHA1withRSA（RSASSA-PKCS1-v1_5 + SHA-1）签名，与官方 SDK（tigeropen）一致。
// 持仓用 positions（sec_type=STK），现金用 prime_assets（综合账户）；环球账户不支持时退回 assets。

import { toNum, MARKET_CURRENCY, sumCash, mergePositions } from "./common.js";

export const TIGER_GATEWAY = "https://openapi.tigerfintech.com/gateway";

/* ---------- 私钥：PEM / 裸 base64，PKCS#1 自动包成 PKCS#8 ---------- */
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function derLen(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
function der(tag, body) { return Uint8Array.from([tag, ...derLen(body.length), ...body]); }
// 读出外层 SEQUENCE 的内容起点
function seqBodyStart(b) {
  if (b[0] !== 0x30) return -1;
  return b[1] < 0x80 ? 2 : 2 + (b[1] & 0x7f);
}
// rsaEncryption OID 1.2.840.113549.1.1.1 + NULL
const RSA_ALG_ID = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

// 返回 PKCS#8 DER 字节；PKCS#1（RSAPrivateKey：SEQUENCE{INTEGER 0, INTEGER n, …}）会被包一层 PrivateKeyInfo
export function privateKeyToPkcs8(text) {
  const b64 = String(text || "")
    .replace(/-----(BEGIN|END)[^-]*-----/g, "")
    .replace(/\\n/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  if (!b64) throw new Error("tiger: empty private key");
  let bytes;
  try { bytes = b64ToBytes(b64); } catch { throw new Error("tiger: private key is not valid base64"); }
  const s = seqBodyStart(bytes);
  // 两种格式都以 INTEGER 0（版本号 02 01 00）开头；PKCS#8 紧接着是 AlgorithmIdentifier SEQUENCE，PKCS#1 是模数 INTEGER
  if (s < 0 || bytes[s] !== 0x02 || bytes[s + 1] !== 0x01 || bytes[s + 2] !== 0x00) throw new Error("tiger: unrecognised private key format");
  const next = bytes[s + 3];
  if (next === 0x30) return bytes;
  if (next !== 0x02) throw new Error("tiger: unrecognised private key format");
  const body = Uint8Array.from([0x02, 0x01, 0x00, ...RSA_ALG_ID, ...der(0x04, bytes)]);
  return der(0x30, body);
}

const keyCache = new Map(); // 同一个私钥在一次同步里会签两三次
export async function importTigerKey(text) {
  const k = String(text || "");
  if (keyCache.has(k)) return keyCache.get(k);
  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", privateKeyToPkcs8(k), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["sign"]);
  } catch (e) {
    throw new Error(String(e.message || "").startsWith("tiger:") ? e.message : "tiger: could not load the private key");
  }
  if (keyCache.size > 20) keyCache.clear();
  keyCache.set(k, key);
  return key;
}

/* ---------- 签名 ---------- */
// 与 SDK get_sign_content 一致：按 key 排序，k=v 用 & 连接（值都是字符串）
export function signContent(params) {
  return Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
}
// SDK 用本地时间；服务端在北京时间，这里固定按 UTC+8 输出 "YYYY-MM-DD HH:mm:ss"
export function tigerTimestamp(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
}
export async function signParams(params, privateKey) {
  const key = await importTigerKey(privateKey);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signContent(params)));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// biz_content 与 SDK 一样：key 排序、紧凑 JSON
function bizJson(biz) {
  const sorted = {};
  for (const k of Object.keys(biz).sort()) if (biz[k] !== undefined && biz[k] !== null) sorted[k] = biz[k];
  return JSON.stringify(sorted);
}

// 调一个网关方法，返回 data（字符串形式的 data 会被解析）；code≠0 抛错（带 code 与 message，不含凭证）
export async function tigerCall(creds, method, biz, { fetchImpl = fetch, now = Date.now(), version = "2.0" } = {}) {
  const params = {
    tiger_id: creds.tigerId,
    method,
    charset: "UTF-8",
    sign_type: "RSA",
    timestamp: tigerTimestamp(now),
    version,
    biz_content: bizJson(biz),
  };
  params.sign = await signParams(params, creds.privateKey);
  const headers = { "Content-Type": "application/json;charset=UTF-8", "User-Agent": "ValuePort/1.0" };
  if (creds.token) headers.Authorization = creds.token; // TBHK 牌照需要的 token（可选）
  let res;
  try { res = await fetchImpl(TIGER_GATEWAY, { method: "POST", headers, body: JSON.stringify(params) }); }
  catch (e) { throw new Error(`tiger ${method}: network error (${e.message})`); }
  if (!res.ok) throw new Error(`tiger ${method}: HTTP ${res.status}`);
  let json;
  try { json = await res.json(); } catch { throw new Error(`tiger ${method}: invalid response`); }
  if (!json || typeof json !== "object") throw new Error(`tiger ${method}: invalid response`);
  if (json.code !== 0) {
    const err = new Error(`tiger ${method}: code ${json.code}${json.message ? " " + String(json.message).slice(0, 200) : ""}`);
    err.code = json.code;
    throw err;
  }
  let data = json.data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { throw new Error(`tiger ${method}: invalid data`); } }
  return data || {};
}

/* ---------- 代码映射 ---------- */
const normCur = (c) => { const u = String(c || "").toUpperCase(); return u === "CNH" ? "CNY" : u; };

// Tiger 的 symbol + market → 腾讯格式；返回 { symbol, market } 或 { reason }
export function tigerToTencent(sym, market) {
  const s = String(sym || "").trim().toUpperCase();
  const m = String(market || "").trim().toUpperCase();
  if (!s) return { reason: "empty symbol" };
  if (m === "US") {
    const t = s.replace(/\s+/g, ".");
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(t)) return { reason: "bad US ticker" };
    return { symbol: "us" + t, market: "US" };
  }
  if (m === "HK") {
    if (!/^\d{1,5}$/.test(s)) return { reason: "bad HK code" };
    return { symbol: "hk" + s.padStart(5, "0"), market: "HK" };
  }
  if (m === "CN") {
    if (!/^\d{6}$/.test(s)) return { reason: "bad A-share code" };
    if (/^[569]/.test(s)) return { symbol: "sh" + s, market: "CN" };
    if (/^[0-3]/.test(s)) return { symbol: "sz" + s, market: "CN" };
    return { reason: "unsupported A-share board" }; // 北交所等
  }
  return { reason: `unsupported market ${m || "?"}` };
}

/* ---------- 响应解析 ---------- */
// positions → { positions, unsupported }；数量优先 positionQty（碎股是小数），否则 position / 10^positionScale
export function parseTigerPositions(data) {
  const positions = [], unsupported = [];
  for (const it of (data && data.items) || []) {
    if (!it) continue;
    const raw = `${it.symbol || "?"}@${it.market || "?"}(${it.secType || "?"})`;
    if (it.secType && String(it.secType).toUpperCase() !== "STK") { unsupported.push({ raw, reason: "sec type " + it.secType }); continue; }
    const mapped = tigerToTencent(it.symbol, it.market);
    if (!mapped.symbol) { unsupported.push({ raw, reason: mapped.reason }); continue; }
    let quantity = toNum(it.positionQty);
    if (!Number.isFinite(quantity)) {
      const q = toNum(it.position), scale = toNum(it.positionScale);
      quantity = Number.isFinite(q) ? (Number.isFinite(scale) && scale > 0 ? q / 10 ** scale : q) : NaN;
    }
    if (!Number.isFinite(quantity) || quantity === 0) { unsupported.push({ raw, reason: "invalid quantity" }); continue; }
    positions.push({
      symbol: mapped.symbol,
      name: String(it.name || it.localSymbol || "").slice(0, 80),
      quantity,
      costPrice: toNum(it.averageCost),
      currency: normCur(it.currency) || MARKET_CURRENCY[mapped.market],
      market: mapped.market,
    });
  }
  return { positions: mergePositions(positions), unsupported };
}

// prime_assets（综合账户）→ [{currency, amount}]：各分部（S 证券 / C 期货）按币种的 cashBalance
export function parseTigerPrimeAssets(data) {
  const pairs = [];
  for (const seg of (data && data.segments) || []) {
    if (!seg) continue;
    const ca = Array.isArray(seg.currencyAssets) ? seg.currencyAssets : [];
    if (ca.length) for (const c of ca) { if (c && c.currency) pairs.push([normCur(c.currency), toNum(c.cashBalance)]); }
    else if (seg.currency) pairs.push([normCur(seg.currency), toNum(seg.cashBalance)]);
  }
  return sumCash(pairs);
}

// assets（环球账户，market_value=true）→ [{currency, amount}]：marketValues 里各币种 cashBalance，否则账户币种的 cashValue
export function parseTigerAssets(data) {
  const pairs = [];
  for (const it of (data && data.items) || []) {
    if (!it) continue;
    const mv = it.marketValues;
    const list = Array.isArray(mv) ? mv : mv && typeof mv === "object" ? Object.entries(mv).map(([currency, v]) => ({ currency, ...v })) : [];
    if (list.length) for (const v of list) { if (v && v.currency) pairs.push([normCur(v.currency), toNum(v.cashBalance)]); }
    else if (it.currency) pairs.push([normCur(it.currency), toNum(it.cashValue ?? it.cashBalance)]);
  }
  return sumCash(pairs);
}

/* ---------- 主入口 ---------- */
// creds = { tigerId, account, privateKey, token? }；opts.fetchImpl / opts.now 供测试注入
export async function fetchTigerAssets(creds, opts = {}) {
  if (!creds || !creds.tigerId || !creds.account || !creds.privateKey) throw new Error("tiger: missing credentials");
  const account = creds.account;
  const cashOf = async () => {
    try { return parseTigerPrimeAssets(await tigerCall(creds, "prime_assets", { account, consolidated: true }, opts)); }
    catch (e) {
      if (e.code === undefined) throw e; // 网络 / 签名错误，没必要再试
      try { return parseTigerAssets(await tigerCall(creds, "assets", { account, market_value: true }, opts)); }
      catch { throw e; } // 环球账户接口也不行：报综合账户的原始错误
    }
  };
  const [posData, cash] = await Promise.all([
    tigerCall(creds, "positions", { account, sec_type: "STK", market: "ALL", currency: "ALL" }, opts),
    cashOf(),
  ]);
  const { positions, unsupported } = parseTigerPositions(posData);
  return { positions, cash, unsupported };
}
