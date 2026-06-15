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
