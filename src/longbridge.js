// LongPort/Longbridge 实时行情（长连接：HTTP 取 OTP → WebSocket → protobuf 命令 11）。
// 协议见 github.com/longportapp/openapi-protocol（v1 帧）与 openapi-protobufs（control/quote）。
// 已对线上网关验证。Worker 运行时：Web Crypto 签名 + fetch-upgrade 出站 WebSocket。

const HTTP_HOST = "https://openapi.longportapp.com";
// Workers fetch-upgrade 出站 WS 用 https:// scheme（Upgrade 头触发 WebSocket 握手）
const WS_URL = "https://openapi-quote.longportapp.com/v2?version=1&codec=1&platform=9";

/* ---------- 符号映射：腾讯格式 ↔ LongPort 格式 ---------- */
// usAAPL→AAPL.US, hk00700→700.HK, sh600519→600519.SH, sz000001→000001.SZ, bj→.BJ
export function tencentToLongport(sym) {
  const m = /^(us|hk|sh|sz|bj)(.+)$/i.exec(sym);
  if (!m) return null;
  const mkt = m[1].toLowerCase(), code = m[2];
  if (mkt === "us") return code.toUpperCase() + ".US";
  if (mkt === "hk") return String(parseInt(code, 10)) + ".HK"; // 去前导零
  if (mkt === "sh") return code + ".SH";
  if (mkt === "sz") return code + ".SZ";
  if (mkt === "bj") return code + ".BJ";
  return null;
}
export function longportToTencent(lp) {
  const m = /^(.+)\.(US|HK|SH|SZ|BJ)$/i.exec(lp);
  if (!m) return null;
  const code = m[1], mkt = m[2].toUpperCase();
  if (mkt === "US") return "us" + code.toUpperCase();
  if (mkt === "HK") return "hk" + code.padStart(5, "0"); // 补回 5 位
  if (mkt === "SH") return "sh" + code;
  if (mkt === "SZ") return "sz" + code;
  if (mkt === "BJ") return "bj" + code;
  return null;
}

/* ---------- 财报（Fundamental Financial Report） ---------- */
// LongPort symbol → counter_id：AAPL.US → ST/US/AAPL
export function symbolToCounterId(lp) {
  const i = lp.lastIndexOf(".");
  if (i < 0) return lp;
  return `ST/${lp.slice(i + 1).toUpperCase()}/${lp.slice(0, i)}`;
}

// 解析 /v1/quote/financial-reports 响应 → { IS:[Acct], BS:[Acct], CF:[Acct] } 或 null
// Acct = { field, name, currency, values:[{ year, fpEnd, period, value:Number, yoy }] }（最新期在前）
export function parseFinancials(json) {
  if (!json || json.code !== 0 || !json.data || !json.data.list) return null;
  const list = json.data.list;
  const out = {};
  for (const kind of Object.keys(list)) {
    const inds = (list[kind] && list[kind].indicators) || [];
    const accts = [];
    for (const ind of inds) {
      const cur = ind.currency || "";
      for (const a of ind.accounts || []) {
        accts.push({
          field: a.field, name: a.name, currency: a.currency || cur,
          values: (a.values || []).map((v) => ({ year: v.year, fpEnd: v.fp_end, period: v.period, value: parseFloat(v.value), yoy: v.yoy || "" })),
        });
      }
    }
    out[kind] = accts;
  }
  return Object.keys(out).length ? out : null;
}

// 从已解析财报取最近一期年报的关键数字（取不到为 null）
export function pickLatestAnnual(financials) {
  const pick = (kind, field) => {
    const a = financials && financials[kind] && financials[kind].find((x) => x.field === field);
    const v = a && a.values && a.values[0] && a.values[0].value;
    return Number.isFinite(v) ? v : null;
  };
  return { revenue: pick("IS", "OperatingRevenue"), netIncome: pick("IS", "NetProfit"), netDebt: pick("BS", "NetDebt"), fcf: pick("CF", "NetFreeCashFlow") };
}

// 签名 GET（沿用 getOtp 的 canonical 规则；query 须按 key 字母序，签名与 URL 用同一字符串）
async function signedGet(env, path, query) {
  const ts = (Date.now() / 1000).toFixed(3);
  const names = "authorization;x-api-key;x-timestamp";
  const sh = `authorization:${env.LONGBRIDGE_ACCESS_TOKEN}\nx-api-key:${env.LONGBRIDGE_APP_KEY}\nx-timestamp:${ts}\n`;
  const canonical = `GET|${path}|${query}|${sh}|${names}|`;
  const sig = await hmac256hex(env.LONGBRIDGE_APP_SECRET, "HMAC-SHA256|" + await sha1hex(canonical));
  const res = await fetch(HTTP_HOST + path + (query ? "?" + query : ""), {
    headers: {
      authorization: env.LONGBRIDGE_ACCESS_TOKEN,
      "x-api-key": env.LONGBRIDGE_APP_KEY,
      "x-timestamp": ts,
      "x-api-signature": `HMAC-SHA256 SignedHeaders=${names}, Signature=${sig}`,
    },
  });
  return res.json();
}

// 取财报：report = "af"(年报) | "qf"(季报)。失败/空 → null。
export async function fetchLongbridgeFinancials(env, tencentSymbol, report) {
  const lp = tencentToLongport(tencentSymbol);
  if (!lp) return null;
  const rep = report === "qf" ? "qf" : "af";
  const query = `counter_id=${symbolToCounterId(lp)}&kind=ALL&report=${rep}`; // 已按字母序：counter_id<kind<report
  try { return parseFinancials(await signedGet(env, "/v1/quote/financial-reports", query)); }
  catch { return null; }
}

/* ---------- 行业估值参考（PE/PB/PS：当前 / 自身5年均 / 行业中位） ---------- */
function _median(arr) {
  const a = (arr || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// industry-valuation-distribution → { pe:{value,median}, pb:{...}, ps:{...} } | null
export function parseValuationDist(json) {
  if (!json || json.code !== 0 || !json.data) return null;
  const out = {};
  for (const m of ["pe", "pb", "ps"]) {
    const d = json.data[m];
    if (!d) continue;
    out[m] = { value: parseFloat(d.value), median: parseFloat(d.median) };
  }
  return Object.keys(out).length ? out : null;
}

// industry-valuation-comparison → 自身（首条）history → { pe:[...], pb:[...], ps:[...] } | null
export function parseIndustryComp(json) {
  if (!json || json.code !== 0 || !json.data || !Array.isArray(json.data.list) || !json.data.list.length) return null;
  const self = json.data.list[0];
  const hist = Array.isArray(self.history) ? self.history : [];
  if (!hist.length) return null;
  return {
    pe: hist.map((h) => parseFloat(h.pe)),
    pb: hist.map((h) => parseFloat(h.pb)),
    ps: hist.map((h) => parseFloat(h.ps)),
  };
}

// 合成参考：current=dist.value，industryMedian=dist.median，own5y=最近~20季 history 的中位
export function buildValuationRefs(dist, comp) {
  const out = {}; let any = false;
  for (const m of ["pe", "pb", "ps"]) {
    const current = dist && dist[m] && Number.isFinite(dist[m].value) ? dist[m].value : null;
    const industryMedian = dist && dist[m] && Number.isFinite(dist[m].median) ? dist[m].median : null;
    const own5y = comp && comp[m] ? _median(comp[m].slice(-20)) : null;
    if (current != null || industryMedian != null || own5y != null) { out[m] = { current, own5y, industryMedian }; any = true; }
  }
  return any ? out : null;
}

export async function fetchValuationRefs(env, tencentSymbol) {
  const lp = tencentToLongport(tencentSymbol);
  if (!lp) return null;
  const q = `counter_id=${symbolToCounterId(lp)}`;
  try {
    const [distJson, compJson] = await Promise.all([
      signedGet(env, "/v1/quote/industry-valuation-distribution", q),
      signedGet(env, "/v1/quote/industry-valuation-comparison", q),
    ]);
    return buildValuationRefs(parseValuationDist(distJson), parseIndustryComp(compJson));
  } catch { return null; }
}

/* ---------- 工具 ---------- */
function toHex(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
async function sha1hex(str) {
  return toHex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str)));
}
async function hmac256hex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

/* ---------- protobuf 极简编解码（仅用到的字段） ---------- */
function varint(n) { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; }
function pstr(field, s) {
  const b = new TextEncoder().encode(s);
  return [(field << 3) | 2, ...varint(b.length), ...b];
}
function authBody(otp) { return new Uint8Array(pstr(1, otp)); }                              // AuthRequest{token=1}
function multiBody(syms) { return new Uint8Array(syms.flatMap((s) => pstr(1, s))); }          // MultiSecurityRequest{repeated symbol=1}

function* pbFields(buf) {
  let i = 0;
  while (i < buf.length) {
    let key = 0, sh = 0;
    while (true) { const b = buf[i++]; key += (b & 127) * 2 ** sh; if (!(b & 128)) break; sh += 7; }
    const f = Math.floor(key / 8), wt = key & 7;
    let val;
    if (wt === 2) { let len = 0, s2 = 0; while (true) { const b = buf[i++]; len += (b & 127) * 2 ** s2; if (!(b & 128)) break; s2 += 7; } val = buf.subarray(i, i + len); i += len; }
    else if (wt === 0) { let v = 0, s3 = 0; while (true) { const b = buf[i++]; v += (b & 127) * 2 ** s3; if (!(b & 128)) break; s3 += 7; } val = v; }
    else if (wt === 5) { val = buf.subarray(i, i + 4); i += 4; }
    else if (wt === 1) { val = buf.subarray(i, i + 8); i += 8; }
    else break;
    yield [f, wt, val];
  }
}
function parseQuotes(body) { // SecurityQuoteResponse{repeated SecurityQuote secu_quote=1}; SecurityQuote{symbol=1,last_done=2}
  const dec = new TextDecoder();
  const out = [];
  for (const [f, wt, val] of pbFields(body)) {
    if (f === 1 && wt === 2) {
      let sym = null, last = null;
      for (const [ff, ww, vv] of pbFields(val)) {
        if (ff === 1 && ww === 2) sym = dec.decode(vv);
        if (ff === 2 && ww === 2) last = dec.decode(vv);
      }
      if (sym) out.push({ sym, last });
    }
  }
  return out;
}
export function parseStaticInfo(body) { // SecurityStaticInfoResponse{repeated secu_static_info=1}；字段号按线上网关实测：symbol=1,name_cn=2,name_en=3,name_hk=4,exchange=6,currency=7,total_shares=9,eps_ttm=13,bps=14,dividend_yield=15
  const dec = new TextDecoder();
  const out = [];
  for (const [f, wt, val] of pbFields(body)) {
    if (f === 1 && wt === 2) {
      let sym = null, cn = "", en = "", hk = "", exchange = "", currency = "", totalShares = 0, epsTtm = "", bps = "", dividendYield = "";
      for (const [ff, ww, vv] of pbFields(val)) {
        if (ff === 1 && ww === 2) sym = dec.decode(vv);
        else if (ff === 2 && ww === 2) cn = dec.decode(vv);
        else if (ff === 3 && ww === 2) en = dec.decode(vv);
        else if (ff === 4 && ww === 2) hk = dec.decode(vv);
        else if (ff === 6 && ww === 2) exchange = dec.decode(vv);
        else if (ff === 7 && ww === 2) currency = dec.decode(vv);
        else if (ff === 9 && ww === 0) totalShares = vv;
        else if (ff === 13 && ww === 2) epsTtm = dec.decode(vv);
        else if (ff === 14 && ww === 2) bps = dec.decode(vv);
        else if (ff === 15 && ww === 2) dividendYield = dec.decode(vv);
      }
      if (sym) out.push({ sym, cn, en, hk, exchange, currency, totalShares, epsTtm, bps, dividendYield });
    }
  }
  return out;
}

/* ---------- v1 帧 ---------- */
let REQ = 0;
function packReq(cmd, body) {
  const h = new Uint8Array(11 + body.length);
  h[0] = 0x01; // type=request, verify=0, gzip=0
  h[1] = cmd;
  const id = (++REQ) >>> 0;
  new DataView(h.buffer).setUint32(2, id);
  new DataView(h.buffer).setUint16(6, 5000); // timeout ms
  h[8] = (body.length >> 16) & 255; h[9] = (body.length >> 8) & 255; h[10] = body.length & 255;
  h.set(body, 11);
  return h;
}
async function parseFrame(data) {
  const f = new Uint8Array(data);
  const b = f[0], type = b & 0xf, gzip = (b >> 5) & 1;
  let i = 1;
  const cmd = f[i++]; let status = 0;
  if (type === 1 || type === 2) i += 4;       // request_id
  if (type === 1) i += 2;                       // timeout
  if (type === 2) status = f[i++];              // status_code
  const bl = (f[i] << 16) | (f[i + 1] << 8) | f[i + 2]; i += 3;
  let body = f.subarray(i, i + bl);
  if (gzip) {
    const ds = new Response(body).body.pipeThrough(new DecompressionStream("gzip"));
    body = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  return { type, cmd, status, body };
}

/* ---------- OTP ---------- */
async function getOtp(env) {
  const path = "/v1/socket/token";
  const ts = (Date.now() / 1000).toFixed(3);
  const names = "authorization;x-api-key;x-timestamp";
  const sh = `authorization:${env.LONGBRIDGE_ACCESS_TOKEN}\nx-api-key:${env.LONGBRIDGE_APP_KEY}\nx-timestamp:${ts}\n`;
  const canonical = `GET|${path}||${sh}|${names}|`;
  const sig = await hmac256hex(env.LONGBRIDGE_APP_SECRET, "HMAC-SHA256|" + await sha1hex(canonical));
  const res = await fetch(HTTP_HOST + path, {
    headers: {
      authorization: env.LONGBRIDGE_ACCESS_TOKEN,
      "x-api-key": env.LONGBRIDGE_APP_KEY,
      "x-timestamp": ts,
      "x-api-signature": `HMAC-SHA256 SignedHeaders=${names}, Signature=${sig}`,
    },
  });
  const j = await res.json();
  if (j.code !== 0 || !j.data || !j.data.otp) throw new Error("otp failed: " + JSON.stringify(j));
  return j.data.otp;
}

/* ---------- 主入口：取一批腾讯格式符号的实时价 → {tencentSym: price} ---------- */
export async function fetchLongbridgeQuotes(env, tencentSymbols) {
  const lpToTc = new Map();
  for (const s of tencentSymbols) { const lp = tencentToLongport(s); if (lp) lpToTc.set(lp, s); }
  const lpSyms = [...lpToTc.keys()];
  if (!lpSyms.length) return {};

  const otp = await getOtp(env);
  const resp = await fetch(WS_URL, { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("longbridge ws upgrade failed");
  ws.accept();

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("longbridge timeout")); }, 8000);
      const done = (v) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(v); };
      const fail = (e) => { clearTimeout(timer); try { ws.close(); } catch {} reject(e); };
      ws.addEventListener("message", async (ev) => {
        try {
          const fr = await parseFrame(ev.data);
          if (fr.cmd === 2) {
            if (fr.status !== 0) return fail(new Error("longbridge auth status " + fr.status));
            ws.send(packReq(11, multiBody(lpSyms)));
          } else if (fr.cmd === 11) {
            if (fr.status !== 0) return fail(new Error("longbridge quote status " + fr.status));
            const out = {};
            for (const { sym, last } of parseQuotes(fr.body)) {
              const tc = lpToTc.get(sym); const p = parseFloat(last);
              if (tc && p > 0) out[tc] = p;
            }
            done(out);
          }
        } catch (e) { fail(e); }
      });
      ws.addEventListener("error", () => fail(new Error("longbridge ws error")));
      ws.addEventListener("close", () => fail(new Error("longbridge ws closed")));
      ws.send(packReq(2, authBody(otp))); // accept() 后连接已建立，直接发鉴权
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

/* ---------- 静态信息：取一批腾讯格式符号的中英文名 → {tencentSym: {cn, en}} ---------- */
export async function fetchLongbridgeNames(env, tencentSymbols) {
  const lpToTc = new Map();
  for (const s of tencentSymbols) { const lp = tencentToLongport(s); if (lp) lpToTc.set(lp, s); }
  const lpSyms = [...lpToTc.keys()];
  if (!lpSyms.length) return {};

  const otp = await getOtp(env);
  const resp = await fetch(WS_URL, { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("longbridge ws upgrade failed");
  ws.accept();

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("longbridge timeout")); }, 8000);
      const done = (v) => { clearTimeout(timer); try { ws.close(); } catch {} resolve(v); };
      const fail = (e) => { clearTimeout(timer); try { ws.close(); } catch {} reject(e); };
      ws.addEventListener("message", async (ev) => {
        try {
          const fr = await parseFrame(ev.data);
          if (fr.cmd === 2) {
            if (fr.status !== 0) return fail(new Error("longbridge auth status " + fr.status));
            ws.send(packReq(10, multiBody(lpSyms))); // QuerySecurityStaticInfo
          } else if (fr.cmd === 10) {
            if (fr.status !== 0) return fail(new Error("longbridge staticinfo status " + fr.status));
            const out = {};
            for (const r of parseStaticInfo(fr.body)) {
              const tc = lpToTc.get(r.sym);
              if (tc) out[tc] = {
                cn: r.cn || "", en: r.en || r.hk || "",
                exchange: r.exchange || "", currency: r.currency || "",
                totalShares: r.totalShares || 0, epsTtm: r.epsTtm || "", bps: r.bps || "", dividendYield: r.dividendYield || "",
              };
            }
            done(out);
          }
        } catch (e) { fail(e); }
      });
      ws.addEventListener("error", () => fail(new Error("longbridge ws error")));
      ws.addEventListener("close", () => fail(new Error("longbridge ws closed")));
      ws.send(packReq(2, authBody(otp)));
    });
  } finally {
    try { ws.close(); } catch {}
  }
}
