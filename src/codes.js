// 去歧义字符集（无 0/1/I/O）。生成形如 XXXX-XXXX-XXXX 的一次性激活码。
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 chars
export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) out += "-";
    out += ALPHABET[bytes[i] & 31];
  }
  return out;
}
