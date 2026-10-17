// Longbridge OpenAPI 资产：股票持仓（/v1/asset/stock）+ 账户现金（/v1/asset/account）。
// 签名复用 src/longbridge.js 的 signedGet；数字字段均为字符串。

import { signedGet, longportToTencent } from "../longbridge.js";
import { toNum, marketOfSymbol, MARKET_CURRENCY, sumCash, mergePositions } from "./common.js";

// 美股期权代码形如 AAPL230317C150000（标的 + YYMMDD + C/P + 行权价）
const US_OPTION_RE = /^[A-Z]{1,6}\d{6}[CP]\d+$/i;

// 非 0 code / 非法响应 → 抛出带说明的 Error
function ensureOk(json, what) {
  if (!json || typeof json !== "object") throw new Error(`longbridge ${what}: invalid response`);
  if (json.code !== 0) throw new Error(`longbridge ${what}: code ${json.code}${json.message ? " " + json.message : ""}`);
  return json.data || {};
}

// /v1/asset/stock → { positions, unsupported }
export function parseLongbridgePositions(json) {
  const data = ensureOk(json, "positions");
  const positions = [], unsupported = [];
  for (const ch of data.list || []) {
    for (const s of (ch && ch.stock_info) || []) {
      try {
        const raw = String((s && s.symbol) || "");
        const code = raw.replace(/\.[A-Z]+$/i, "");
        const sym = longportToTencent(raw);
        const market = sym && marketOfSymbol(sym);
        if (!market) { unsupported.push({ raw, reason: "unsupported market" }); continue; }
        if (market === "US" && US_OPTION_RE.test(code)) { unsupported.push({ raw, reason: "option" }); continue; }
        const quantity = toNum(s.quantity);
        if (!Number.isFinite(quantity)) { unsupported.push({ raw, reason: "invalid quantity" }); continue; }
        positions.push({
          symbol: sym,
          name: s.symbol_name || "",
          quantity,
          costPrice: toNum(s.cost_price),
          currency: s.currency || MARKET_CURRENCY[market],
          market,
        });
      } catch (e) {
        unsupported.push({ raw: s && s.symbol, reason: "bad row: " + e.message });
      }
    }
  }
  return { positions: mergePositions(positions), unsupported }; // 多个 account_channel 同符号合并
}

// /v1/asset/account → [{currency, amount}]；优先 cash_infos 明细（可用+冻结+待交收），否则 total_cash
export function parseLongbridgeBalances(json) {
  const data = ensureOk(json, "balances");
  const pairs = [];
  for (const it of data.list || []) {
    if (!it) continue;
    const infos = Array.isArray(it.cash_infos) ? it.cash_infos : [];
    if (infos.length) {
      for (const c of infos) {
        if (!c || !c.currency) continue;
        const parts = [c.available_cash, c.frozen_cash, c.settling_cash].map(toNum).filter(Number.isFinite);
        if (parts.length) pairs.push([c.currency, parts.reduce((a, b) => a + b, 0)]);
      }
    } else {
      pairs.push([it.currency, toNum(it.total_cash)]);
    }
  }
  return sumCash(pairs);
}

// 主入口：creds = { appKey, appSecret, accessToken }；get 可注入（测试用）
export async function fetchLongbridgeAssets(creds, get = signedGet) {
  if (!creds || !creds.appKey || !creds.appSecret || !creds.accessToken) throw new Error("longbridge: missing credentials");
  const env = { LONGBRIDGE_APP_KEY: creds.appKey, LONGBRIDGE_APP_SECRET: creds.appSecret, LONGBRIDGE_ACCESS_TOKEN: creds.accessToken };
  const call = async (path, what) => {
    try { return await get(env, path, ""); }
    catch (e) { throw new Error(`longbridge ${what}: request failed (${e.message})`); } // 非 JSON / 网络错误
  };
  const [stockJson, accountJson] = await Promise.all([
    call("/v1/asset/stock", "positions"),
    call("/v1/asset/account", "balances"),
  ]);
  const { positions, unsupported } = parseLongbridgePositions(stockJson);
  const cash = parseLongbridgeBalances(accountJson);
  return { positions, cash, unsupported };
}
