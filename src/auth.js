// HMAC-SHA256 签名的无状态会话 token。
// 格式: base64url(JSON payload) + "." + base64url(hmac)
function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToBytes(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

// exp = now + ttlSeconds。verifyToken 用 exp > now 严格判定，故 ttlSeconds<=0 即为已过期 token（供测试）。
export async function signToken(secret, ttlSeconds) {
  const exp = nowSeconds() + ttlSeconds;
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ exp })));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyToken(secret, token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(payload)));
    return typeof exp === "number" && exp > nowSeconds();
  } catch {
    return false;
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
// ASCII-only constant-time compare (safe for base64url MAC strings; do not reuse for arbitrary unicode).
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
