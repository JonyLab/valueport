// 券商凭证加密：AES-256-GCM，密钥来自 Worker secret CREDENTIALS_KEY（base64 编码的 32 字节）。
// 存库格式：base64(12 字节 IV ‖ 密文+认证标签)。解不开（密钥换了 / 数据被改）就抛错，调用方当作「凭证失效」处理。

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function importKey(secret) {
  if (!secret) throw new Error("CREDENTIALS_KEY is not configured");
  const raw = b64ToBytes(secret);
  if (raw.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// 加密任意可 JSON 序列化的对象
export async function encryptJson(secret, obj) {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function decryptJson(secret, blob) {
  const key = await importKey(secret);
  const bytes = b64ToBytes(blob);
  const iv = bytes.slice(0, 12), ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}
