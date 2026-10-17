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

// 行情串里的静态信息（长桥不可用时的兜底）。各市场字段位置不同，已用「股价 × 总股本 = 总市值」核对：
//   名称：索引 1 中文名；索引 46 英文名（美股 "Apple Inc."、港股 "TENCENT"；A 股该位不是名称）
//   总股本：美股 62、港股 69、A 股 73；币种：美股 35、港股 75、A 股 82；市盈率 TTM：各市场均为 39
//   52 周最高/最低：美股、港股 48/49，A 股 67/68
// 返回 {sym: {cn, en, currency, totalShares, epsTtm, peTtm, high52, low52}}；缺失项为 "" 或 NaN。
const STATIC_IDX = {
  us: { shares: 62, cur: 35, hi: 48, lo: 49 }, hk: { shares: 69, cur: 75, hi: 48, lo: 49 },
  sh: { shares: 73, cur: 82, hi: 67, lo: 68 }, sz: { shares: 73, cur: 82, hi: 67, lo: 68 }, bj: { shares: 73, cur: 82, hi: 67, lo: 68 },
};
export function parseTencentStatics(text, symbols) {
  const out = {};
  for (const sym of symbols) {
    if (!SYMBOL_RE.test(sym)) continue;
    const m = text.match(new RegExp(`v_${sym}="([^"]*)"`));
    if (!m) continue;
    const f = m[1].split("~");
    const idx = STATIC_IDX[sym.slice(0, 2).toLowerCase()];
    const en = sym.startsWith("us") || sym.startsWith("hk") ? (f[46] || "").trim() : "";
    const price = parseFloat(f[3]), pe = parseFloat(f[39]);
    const shares = idx ? parseFloat(f[idx.shares]) : NaN;
    const cur = idx ? (f[idx.cur] || "").trim() : "";
    const num = (i) => { const v = idx ? parseFloat(f[i]) : NaN; return v > 0 ? v : NaN; };
    out[sym] = {
      cn: (f[1] || "").trim(),
      en: /[A-Za-z]/.test(en) ? en : "",
      currency: /^[A-Z]{3}$/.test(cur) ? cur : "",
      totalShares: shares > 0 ? shares : NaN,
      epsTtm: price > 0 && Number.isFinite(pe) && pe !== 0 ? price / pe : NaN,
      peTtm: Number.isFinite(pe) && pe !== 0 ? pe : NaN,
      high52: idx ? num(idx.hi) : NaN,
      low52: idx ? num(idx.lo) : NaN,
    };
  }
  return out;
}

// 昨收价（索引 4，三个市场一致）：前端用「现价 − 昨收」算当日涨跌，长桥实时价也能套用。返回 {sym: prevClose}
export function parseTencentPrevClose(text, symbols) {
  const out = {};
  for (const sym of symbols) {
    if (!SYMBOL_RE.test(sym)) continue;
    const m = text.match(new RegExp(`v_${sym}="([^"]*)"`));
    if (!m) continue;
    const v = parseFloat(m[1].split("~")[4]);
    if (v > 0) out[sym] = v;
  }
  return out;
}

// 腾讯代码 → FinancialModelingPrep 图片接口用的代码（logo 代理用）：
//   usAAPL → AAPL；hk01810 → 1810.HK（港股取后 4 位）；sh600519 → 600519.SS；sz000338 → 000338.SZ；其他返回 null
export function logoTicker(sym) {
  const m = /^(us|hk|sh|sz)([A-Za-z0-9.]{1,12})$/.exec(sym || "");
  if (!m) return null;
  const [, mkt, code] = m;
  if (mkt === "us") return /^[A-Za-z.]{1,8}$/.test(code) ? code.toUpperCase().replace(/\./g, "-") : null;
  if (!/^\d+$/.test(code)) return null;
  if (mkt === "hk") return code.padStart(4, "0").slice(-4) + ".HK";
  return code + (mkt === "sh" ? ".SS" : ".SZ");
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
