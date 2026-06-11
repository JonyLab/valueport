// PBKDF2-SHA256 加盐密码哈希（Web Crypto）。hash/salt 均 base64 存储。
const ITER = 100000, KEYLEN = 32, SALTLEN = 16;

function b64(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function unb64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }

async function derive(password, saltBytes) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: ITER }, key, KEYLEN * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALTLEN));
  const hash = await derive(password, salt);
  return { hash: b64(hash), salt: b64(salt) };
}

export async function verifyPassword(password, saltB64, hashB64) {
  let expected, salt;
  try { salt = unb64(saltB64); expected = unb64(hashB64); } catch { return false; }
  const actual = await derive(password, salt);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
