// IBKR Flex Web Service：SendRequest 取 ReferenceCode → GetStatement 取报表 XML。
// Worker 无 DOMParser：用正则解析自闭合元素属性（OpenPosition / CashReportCurrency）。

import { toNum, sumCash, mergePositions } from "./common.js";

const SEND_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";
const RETRY_CODES = new Set(["1019", "1018"]); // 1019 生成中；1018 请求过于频繁

/* ---------- 极简 XML 工具 ---------- */
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">";
    if (k === "quot") return '"'; if (k === "apos") return "'";
    const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}
function parseAttrs(s) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[2] != null ? m[2] : m[3]);
  return out;
}
// 所有 <tag .../> 或 <tag ...> 的属性对象
function elements(xml, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*?)\\/?>`, "g");
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(parseAttrs(m[1]));
  return out;
}
function textOf(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeEntities(m[1].trim()) : "";
}

/* ---------- 交易所 → 腾讯符号 ---------- */
const HK_EX = new Set(["SEHK"]);
const SH_EX = new Set(["SEHKNTL"]);   // 沪股通
const SZ_EX = new Set(["SEHKSZSE"]);  // 深股通

// 返回 { symbol, market } 或 { reason }
export function ibkrToTencent(sym, exchange, currency) {
  const s = String(sym || "").trim();
  const ex = String(exchange || "").trim().toUpperCase();
  const cur = String(currency || "").trim().toUpperCase();
  if (!s) return { reason: "empty symbol" };
  if (HK_EX.has(ex)) {
    if (!/^\d{1,5}$/.test(s)) return { reason: "bad HK code" };
    return { symbol: "hk" + s.padStart(5, "0"), market: "HK" };
  }
  if (SH_EX.has(ex) || SZ_EX.has(ex)) {
    if (!/^\d{1,6}$/.test(s)) return { reason: "bad A-share code" };
    return { symbol: (SH_EX.has(ex) ? "sh" : "sz") + s.padStart(6, "0"), market: "CN" };
  }
  if (cur === "USD") { // USD + 非港/A 交易所 → 美股（NASDAQ/NYSE/ARCA/AMEX/BATS/IEX/ISLAND…）
    const t = s.toUpperCase().replace(/\s+/g, ".");
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(t)) return { reason: "bad US ticker" };
    return { symbol: "us" + t, market: "US" };
  }
  return { reason: `unsupported exchange ${ex || "?"}/${cur || "?"}` };
}

const normCur = (c) => { const u = String(c || "").toUpperCase(); return u === "CNH" ? "CNY" : u; };

/* ---------- 报表解析（多个 FlexStatement 自动合并：同符号累加、加权成本） ---------- */
export function parseIbkrFlexStatement(xml) {
  const text = String(xml || "");
  const rows = [], unsupported = [];
  for (const a of elements(text, "OpenPosition")) {
    // 若查询含 LOT 明细，只取 SUMMARY 行，避免重复计数
    if (a.levelOfDetail && a.levelOfDetail.toUpperCase() !== "SUMMARY") continue;
    const raw = `${a.symbol || "?"}@${a.listingExchange || a.exchange || "?"}(${a.assetCategory || "?"})`;
    if ((a.assetCategory || "").toUpperCase() !== "STK") { unsupported.push({ raw, reason: "asset category " + (a.assetCategory || "?") }); continue; }
    const mapped = ibkrToTencent(a.symbol, a.listingExchange || a.exchange, a.currency);
    if (!mapped.symbol) { unsupported.push({ raw, reason: mapped.reason }); continue; }
    const quantity = toNum(a.position);
    if (!Number.isFinite(quantity)) { unsupported.push({ raw, reason: "invalid quantity" }); continue; }
    rows.push({
      symbol: mapped.symbol, name: a.description || "", quantity, costPrice: toNum(a.costBasisPrice),
      currency: normCur(a.currency) || "USD", market: mapped.market,
    });
  }
  const pairs = [];
  for (const c of elements(text, "CashReportCurrency")) {
    const cur = (c.currency || "").toUpperCase();
    if (!cur || cur === "BASE_SUMMARY") continue;
    pairs.push([normCur(cur), toNum(c.endingCash)]);
  }
  return { positions: mergePositions(rows), cash: sumCash(pairs), unsupported };
}

/* ---------- 两步拉取 ---------- */
function flexError(xml, step) {
  const code = textOf(xml, "ErrorCode"), msg = textOf(xml, "ErrorMessage");
  return new Error(`ibkr flex ${step} failed${code ? " (" + code + ")" : ""}: ${msg || "unknown error"}`);
}
async function getText(fetchImpl, url, step) {
  let res;
  try { res = await fetchImpl(url, { headers: { "User-Agent": "ValuePort/1.0" } }); }
  catch (e) { throw new Error(`ibkr flex ${step}: network error (${e.message})`); }
  if (!res.ok) throw new Error(`ibkr flex ${step}: HTTP ${res.status}`);
  return res.text();
}

// opts.tries / opts.delayMs 可调（测试传 0）
export async function fetchIbkrFlex({ token, queryId } = {}, fetchImpl = fetch, opts = {}) {
  if (!token || !queryId) throw new Error("ibkr flex: missing token or queryId");
  const tries = opts.tries ?? 5, delayMs = opts.delayMs ?? 1500;
  const t = encodeURIComponent(token);

  const sendXml = await getText(fetchImpl, `${SEND_URL}?t=${t}&q=${encodeURIComponent(queryId)}&v=3`, "SendRequest");
  if (textOf(sendXml, "Status") !== "Success") throw flexError(sendXml, "SendRequest");
  const ref = textOf(sendXml, "ReferenceCode");
  const url = textOf(sendXml, "Url");
  if (!ref || !url) throw new Error("ibkr flex SendRequest: missing ReferenceCode/Url");

  const stmtUrl = `${url}${url.includes("?") ? "&" : "?"}t=${t}&q=${encodeURIComponent(ref)}&v=3`;
  for (let i = 0; i < tries; i++) {
    if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const xml = await getText(fetchImpl, stmtUrl, "GetStatement");
    if (/<FlexQueryResponse\b/.test(xml) || /<FlexStatement\b/.test(xml)) return parseIbkrFlexStatement(xml);
    if (/<FlexStatementResponse\b/.test(xml)) {
      if (RETRY_CODES.has(textOf(xml, "ErrorCode"))) continue; // 生成中，稍后重试
      throw flexError(xml, "GetStatement");
    }
    throw new Error("ibkr flex GetStatement: unexpected response");
  }
  throw new Error(`ibkr flex GetStatement: statement not ready after ${tries} tries`);
}
