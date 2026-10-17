// 持仓 CSV 导入：自动识别分隔符（, \t ;）、BOM、引号字段、中英文表头；符号统一转腾讯格式。

import { MARKET_CURRENCY, mergePositions } from "./common.js";

/* ---------- 表头别名（小写、去空白后精确匹配） ---------- */
const ALIASES = {
  symbol: ["symbol", "ticker", "code", "代码", "证券代码", "股票代码"],
  name: ["name", "名称", "证券名称", "股票名称"],
  quantity: ["quantity", "qty", "shares", "position", "数量", "持仓数量", "股票余额", "证券数量", "持股数量", "当前持仓"],
  cost: ["cost", "cost price", "avg cost", "average cost", "成本价", "参考成本价", "持仓成本", "买入均价", "成本"],
  currency: ["currency", "币种"],
  market: ["market", "市场", "交易市场"],
};
const HEADER_MAP = new Map();
for (const [k, list] of Object.entries(ALIASES)) for (const a of list) HEADER_MAP.set(a, k);

function normHeader(h) {
  return String(h || "").trim().toLowerCase()
    .replace(/[（(][^）)]*[）)]\s*$/, "") // 去掉尾部 "(USD)" / "（元）"
    .replace(/[_\s]+/g, " ").trim();
}

/* ---------- 分隔符识别 + 引号感知切分 ---------- */
function countOutsideQuotes(line, ch) {
  let n = 0, q = false;
  for (const c of line) { if (c === '"') q = !q; else if (!q && c === ch) n++; }
  return n;
}
function detectDelimiter(line) {
  let best = ",", max = 0;
  for (const d of ["\t", ";", ","]) { const n = countOutsideQuotes(line, d); if (n > max) { max = n; best = d; } }
  return best;
}
// 整段文本 → [{line, cells}]（line 为记录起始的物理行号，支持引号内换行与 "" 转义）
function splitRecords(text, delim) {
  const out = [];
  let cells = [], cur = "", q = false, line = 1, start = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else { if (c === "\n") line++; cur += c; }
    } else if (c === '"') q = true;
    else if (c === delim) { cells.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cells.push(cur); out.push({ line: start, cells });
      cells = []; cur = ""; line++; start = line;
    } else cur += c;
  }
  if (cur !== "" || cells.length) { cells.push(cur); out.push({ line: start, cells }); }
  return out;
}

/* ---------- 值解析 ---------- */
// 去掉千分位、货币符号、空白；"-" / "N/A" → NaN
function num(v) {
  const s = String(v == null ? "" : v).replace(/[^0-9.+\-]/g, "");
  if (!s || s === "-" || s === "+") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// 市场列 → { market, ex }（ex 为 "sh"/"sz" 用于补零后的 A 股判定）
function parseMarket(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return null;
  if (/^(US|USA|美股|美国|NASDAQ|NYSE|AMEX|ARCA)$/.test(s)) return { market: "US" };
  if (/^(HK|HKEX|SEHK|港股|香港|港股通)$/.test(s)) return { market: "HK" };
  if (/^(SH|SSE|沪|沪A|沪市|上海|上证|上海A股|沪股通)$/.test(s)) return { market: "CN", ex: "sh" };
  if (/^(SZ|SZSE|深|深A|深市|深圳|深证|深圳A股|深股通)$/.test(s)) return { market: "CN", ex: "sz" };
  if (/^(CN|A股|A|CHINA|中国|沪深)$/.test(s)) return { market: "CN" };
  if (/^(BJ|北交所|北京)$/.test(s)) return { market: "BJ" };
  return null;
}
function parseCurrency(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return "";
  if (/^(USD|US\$|美元)$/.test(s)) return "USD";
  if (/^(HKD|HK\$|港币|港元)$/.test(s)) return "HKD";
  if (/^(CNY|CNH|RMB|人民币|元)$/.test(s)) return "CNY";
  return s;
}
const CUR_MARKET = { USD: "US", HKD: "HK", CNY: "CN" };

// A 股 6 位代码 → sh/sz；北交所（4/8 开头）→ null
function aShare(code, ex) {
  if (ex) return ex + code;
  const c = code[0];
  if ("695".includes(c)) return "sh" + code;
  if ("023".includes(c)) return "sz" + code;
  return null;
}

// 各种写法 → { symbol, market } 或 { reason }
export function normalizeSymbol(raw, hint = {}) {
  const s = String(raw || "").trim();
  if (!s) return { reason: "empty symbol" };
  let m;
  // 腾讯格式
  if ((m = /^us([A-Z][A-Z0-9.\-]*)$/.exec(s))) return { symbol: "us" + m[1], market: "US" };
  if ((m = /^hk(\d{5})$/i.exec(s))) return { symbol: "hk" + m[1], market: "HK" };
  if ((m = /^(sh|sz)(\d{6})$/i.exec(s))) return { symbol: m[1].toLowerCase() + m[2], market: "CN" };
  if (/^bj\d{6}$/i.test(s)) return { reason: "BSE (bj) not supported" };
  // 后缀格式：Longbridge AAPL.US / 700.HK / 600519.SH；Yahoo 0700.HK / 600519.SS
  if ((m = /^(.+)\.(US|HK|SH|SS|SZ|BJ)$/i.exec(s))) {
    const code = m[1].trim(), sfx = m[2].toUpperCase();
    if (sfx === "US") return /^[A-Z][A-Z0-9.\-]*$/i.test(code) ? { symbol: "us" + code.toUpperCase(), market: "US" } : { reason: "bad US ticker" };
    if (sfx === "HK") return /^\d{1,5}$/.test(code) ? { symbol: "hk" + code.padStart(5, "0"), market: "HK" } : { reason: "bad HK code" };
    if (sfx === "BJ") return { reason: "BSE (bj) not supported" };
    if (!/^\d{6}$/.test(code)) return { reason: "bad A-share code" };
    return { symbol: (sfx === "SZ" ? "sz" : "sh") + code, market: "CN" };
  }
  // 纯数字
  if (/^\d+$/.test(s)) {
    const mk = hint.market;
    if (mk === "HK" && s.length <= 5) return { symbol: "hk" + s.padStart(5, "0"), market: "HK" };
    if (s.length === 6 || (mk === "CN" && s.length < 6)) { // CN 提示时补回被表格吞掉的前导零
      const code = s.padStart(6, "0");
      const sym = aShare(code, hint.ex);
      return sym ? { symbol: sym, market: "CN" } : { reason: "BSE (bj) or unknown A-share code" };
    }
    if (mk === "BJ") return { reason: "BSE (bj) not supported" };
    return { reason: "ambiguous numeric code (set market/currency)" };
  }
  if (/^[A-Z]{1,6}\s*\d{6}[CP]\d+$/i.test(s)) return { reason: "option" }; // OCC 期权代码
  // 纯字母 → 美股（"BRK B" / "BRK/B" → BRK.B）
  const t = s.toUpperCase().replace(/[\s/]+/g, ".");
  if (/^[A-Z][A-Z0-9.\-]*$/.test(t)) return { symbol: "us" + t, market: "US" };
  return { reason: "unrecognized symbol" };
}

/* ---------- 主入口 ---------- */
export function parseHoldingsCsv(text) {
  const out = { positions: [], cash: [], unsupported: [], errors: [] };
  let src = String(text == null ? "" : text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.split(/\r\n|\n|\r/);

  // 表头：前 10 个非空行中，第一个同时含 symbol 与 quantity 列的行（跳过券商导出的抬头说明）
  let hdrIdx = -1, delim = ",", cols = null;
  for (let i = 0, seen = 0; i < lines.length && seen < 10; i++) {
    if (!lines[i].trim()) continue;
    seen++;
    const d = detectDelimiter(lines[i]);
    const cells = splitRecords(lines[i], d)[0].cells;
    const map = {};
    cells.forEach((h, j) => { const k = HEADER_MAP.get(normHeader(h)); if (k && map[k] == null) map[k] = j; });
    if (map.symbol != null && map.quantity != null) { hdrIdx = i; delim = d; cols = map; break; }
  }
  if (!cols) { out.errors.push({ line: 1, message: "header must include symbol/代码 and quantity/数量 columns" }); return out; }

  const body = lines.slice(hdrIdx + 1).join("\n");
  const rows = [];
  for (const { line: rel, cells } of splitRecords(body, delim)) {
    const line = rel + hdrIdx + 1;
    if (cells.every((c) => !c.trim())) continue; // 空行
    const get = (k) => (cols[k] != null && cells[cols[k]] != null ? cells[cols[k]].trim() : "");
    const rawSym = get("symbol");
    if (!rawSym) { out.errors.push({ line, message: "missing symbol" }); continue; }
    if (/^(合计|总计|小计|total|subtotal)$/i.test(rawSym)) continue; // 汇总行

    const cur0 = parseCurrency(get("currency"));
    const mh = parseMarket(get("market")) || (CUR_MARKET[cur0] ? { market: CUR_MARKET[cur0] } : {});
    const mapped = normalizeSymbol(rawSym, mh);
    if (!mapped.symbol) { out.unsupported.push({ raw: rawSym, reason: mapped.reason }); continue; }

    const qRaw = get("quantity");
    const quantity = num(qRaw);
    if (!Number.isFinite(quantity)) { out.errors.push({ line, message: `invalid quantity "${qRaw}" for ${rawSym}` }); continue; }
    if (quantity === 0) { out.unsupported.push({ raw: rawSym, reason: "zero quantity" }); continue; }

    rows.push({
      symbol: mapped.symbol,
      name: get("name"),
      quantity,
      costPrice: num(get("cost")),
      currency: cur0 || MARKET_CURRENCY[mapped.market],
      market: mapped.market,
    });
  }
  out.positions = mergePositions(rows);
  return out;
}
