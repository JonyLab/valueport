export const MKT_LABEL = { sh: "沪A", sz: "深A", hk: "港股", us: "美股", bj: "北交所" };

const SYMBOL_RE = /^[a-zA-Z0-9.]+$/; // tencent symbols are alphanumeric+dot; reject anything else (regex-injection guard)
// 腾讯行情返回多行: v_<sym>="f0~f1~f2~price~...";  价格在索引 3。
export function parseTencentQuotes(text, symbols) {
  const out = {};
  for (const sym of symbols) {
    if (!SYMBOL_RE.test(sym)) continue;
    const m = text.match(new RegExp(`v_${sym}="([^"]*)"`));
    if (!m) continue;
    const f = m[1].split("~");
    const p = parseFloat(f[3]);
    if (p > 0) out[sym] = p;
  }
  return out;
}

// smartbox 把名称按 \uXXXX 或 %uXXXX 转义返回（如 万科 → 万科）；两种都解码回真实字符。
function decodeHintName(s) {
  if (s.indexOf("u") < 0) return s;
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// 腾讯 smartbox: v_hint="mkt~code~name~~^mkt~code~name~~^...";
export function parseTencentHints(text) {
  const m = text.match(/v_hint="([^"]*)"/);
  if (!m) return [];
  const out = [];
  for (const e of m[1].split("^")) {
    const f = e.split("~");
    if (f.length < 3) continue;
    const mkt = (f[0] || "").toLowerCase();
    if (!MKT_LABEL[mkt]) continue;
    let code = (f[1] || "").toUpperCase();
    const name = decodeHintName(f[2] || "");
    if (mkt === "us") code = code.split(".")[0];
    const symbol = mkt + (mkt === "us" ? code : (f[1] || "").toLowerCase());
    out.push({ mkt, code, name, symbol });
  }
  return out.slice(0, 8);
}
