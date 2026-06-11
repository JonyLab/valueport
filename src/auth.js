// HMAC-SHA256 签名的无状态会话 token，携带任意 claims（如 role/uid）。
// 格式: base64url(JSON {...claims, exp}) + "." + base64url(hmac)
function b64urlEncode(bytes) {
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToBytes(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}
function nowSeconds() { return Math.floor(Date.now() / 1000); }
// Constant-time compare for equal-length ASCII strings (base64url MAC).
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0;
}

export async function signToken(secret, claims, ttlSeconds) {
  const body = { ...claims, exp: nowSeconds() + ttlSeconds };
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}
// 返回 claims 对象（含 exp/role/uid）或 null。
export async function verifyToken(secret, token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!timingSafeEqual(sig, await hmac(secret, payload))) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payload)));
    if (typeof claims.exp !== "number" || !isFinite(claims.exp) || claims.exp <= nowSeconds()) return null;
    return claims;
  } catch { return null; }
}
