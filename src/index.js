import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { signToken, verifyToken } from "./auth.js";
import { validateItem, rowToItem } from "./items.js";
import { parseTencentQuotes, parseTencentHints } from "./quotes.js";
import { fetchLongbridgeQuotes, fetchLongbridgeNames, fetchLongbridgeFinancials, pickLatestAnnual, fetchValuationRefs } from "./longbridge.js";
import { fetchDeductedNetIncome } from "./eastmoney.js";
import { fetchAdjustedEps } from "./finnhub.js";
import { fetchDividendHistory } from "./dividends.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateCode } from "./codes.js";
import { validateUsername, validateSlug, rowToUser } from "./users.js";

const app = new Hono();
const USER_COOKIE = "pendulum_user", OWNER_COOKIE = "pendulum_owner";
const TTL = 7 * 24 * 3600;
const TEXT_KEYS = ["eyebrow", "title", "subtitle"];
const COLOR_KEYS = ["color_deep", "color_under", "color_fair", "color_over", "color_xover"];
const SETTING_KEYS = [...TEXT_KEYS, ...COLOR_KEYS];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: TTL };

async function readSettings(db, userId) {
  const out = {};
  try {
    const { results } = await db.prepare("SELECT key, value FROM settings WHERE user_id=?").bind(userId).all();
    for (const r of results || []) if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value;
  } catch {}
  return out;
}
async function fetchGbk(url) {
  const res = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return new TextDecoder("gbk").decode(await res.arrayBuffer());
}

/* ---------- 公开接口 ---------- */
app.get("/api/config", async (c) => {
  const slug = c.req.query("slug") || "";
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE board_slug=?").bind(slug).first();
  if (!user) return c.json({ error: "board not found" }, 404);
  const { results } = await c.env.DB.prepare("SELECT * FROM items WHERE user_id=? ORDER BY sort_order ASC, id ASC").bind(user.id).all();
  return c.json({ board: { slug: user.board_slug, name: user.board_name }, items: (results || []).map(rowToItem), settings: await readSettings(c.env.DB, user.id) });
});
async function tencentQuotes(symbols) {
  if (!symbols.length) return {};
  try { return parseTencentQuotes(await fetchGbk("https://qt.gtimg.cn/q=" + symbols.join(",")), symbols); }
  catch { return {}; }
}
app.get("/api/quotes", async (c) => {
  const symbols = (c.req.query("symbols") || "").split(",").map((s) => s.trim()).filter((s) => s && s.length <= 16).slice(0, 50);
  if (!symbols.length) return c.json({ quotes: {}, ts: new Date().toISOString() });
  let quotes = {}, source = "tencent";
  // 有长桥凭据则优先用其实时行情；失败或缺漏的退回腾讯延时
  if (c.env.LONGBRIDGE_APP_KEY && c.env.LONGBRIDGE_APP_SECRET && c.env.LONGBRIDGE_ACCESS_TOKEN) {
    try { quotes = await fetchLongbridgeQuotes(c.env, symbols); source = "longbridge"; }
    catch (e) { console.error("longbridge failed, fall back to tencent:", e && e.message); quotes = {}; source = "tencent"; }
  }
  const missing = symbols.filter((s) => !(s in quotes));
  if (missing.length) Object.assign(quotes, await tencentQuotes(missing));
  c.header("Cache-Control", "no-store"); // 实时行情不缓存
  if (!Object.keys(quotes).length) return c.json({ quotes: {}, error: "upstream unreachable", ts: new Date().toISOString() }, 502);
  return c.json({ quotes, source, ts: new Date().toISOString() });
});
// 标的中英文名（用于切语言时显示对应名）。仅长桥提供，缺则返回空、前端回退已存名。
app.get("/api/names", async (c) => {
  const symbols = (c.req.query("symbols") || "").split(",").map((s) => s.trim()).filter((s) => s && s.length <= 16).slice(0, 50);
  if (!symbols.length) return c.json({ names: {} });
  let names = {};
  if (c.env.LONGBRIDGE_APP_KEY && c.env.LONGBRIDGE_APP_SECRET && c.env.LONGBRIDGE_ACCESS_TOKEN) {
    try { names = await fetchLongbridgeNames(c.env, symbols); }
    catch (e) { console.error("longbridge names failed:", e && e.message); names = {}; }
  }
  c.header("Cache-Control", "public, max-age=86400"); // 名称基本不变，可缓存一天
  return c.json({ names });
});
// 财报（Fundamental）：按需取 + 缓存一天。无凭据/无权限 → financials:null（前端优雅降级）。
app.get("/api/financials", async (c) => {
  const symbol = (c.req.query("symbol") || "").trim();
  const isAnnual = c.req.query("period") !== "quarter";
  const report = isAnnual ? "af" : "qf";
  const haveCreds = c.env.LONGBRIDGE_APP_KEY && c.env.LONGBRIDGE_APP_SECRET && c.env.LONGBRIDGE_ACCESS_TOKEN;
  let financials = null, valuationRefs = null, deducted = null, adjEps = null, dividends = null;
  if (symbol && haveCreds) {
    try {
      if (isAnnual) {
        // 扣非(东财·A股)、调整后EPS(Finnhub·美股)、逐年派息(东财·全市场)均与长桥并行拉取;免费、各自失败不影响其余
        const [f, vr, dni, aeps, div] = await Promise.all([
          fetchLongbridgeFinancials(c.env, symbol, report),
          fetchValuationRefs(c.env, symbol),
          fetchDeductedNetIncome(symbol),
          fetchAdjustedEps(c.env, symbol),
          fetchDividendHistory(symbol),
        ]);
        financials = f; valuationRefs = vr; deducted = dni; adjEps = aeps; dividends = div;
      } else {
        financials = await fetchLongbridgeFinancials(c.env, symbol, report);
      }
    } catch (e) { console.error("financials failed:", e && e.message); financials = null; }
  }
  const latest = pickLatestAnnual(financials);
  if (Number.isFinite(deducted)) latest.deductedNetIncome = deducted;
  if (Number.isFinite(adjEps)) latest.adjustedEps = adjEps;
  // 仅缓存成功结果;失败/空响应不长期缓存,避免一次瞬时失败把基本面钉死 24 小时
  const ok = financials && (financials.IS || financials.BS || financials.CF);
  // 派息支持的市场但本次没取到(东财瞬时失败)→ 缩短缓存,避免把派息钉死 24h,约 1h 后自愈
  const divMissing = isAnnual && /^(sh|sz|bj|hk|us)/i.test(symbol) && !dividends;
  const maxAge = !ok ? 0 : (divMissing ? 3600 : 86400);
  c.header("Cache-Control", maxAge ? `public, max-age=${maxAge}` : "no-store");
  return c.json({ financials, latest, valuationRefs, dividends });
});
app.get("/api/hints", async (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.json({ hints: [] });
  try { const text = await fetchGbk("https://smartbox.gtimg.cn/s3/?v=2&t=all&q=" + encodeURIComponent(q)); return c.json({ hints: parseTencentHints(text) }); }
  catch { return c.json({ hints: [] }); }
});

/* ---------- 注册 / 登录 ---------- */
app.post("/api/register", async (c) => {
  const { username, password, code } = await c.req.json().catch(() => ({}));
  if (!validateUsername(username)) return c.json({ ok: false, error: "用户名需 3-20 位字母/数字/_/-" }, 400);
  if (typeof password !== "string" || password.length < 6 || password.length > 1024) return c.json({ ok: false, error: "密码需 6-1024 位" }, 400);
  if (await c.env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first()) return c.json({ ok: false, error: "用户名已被占用" }, 409);
  // 原子领取激活码：仅未使用的码能被领取，防并发重复使用（TOCTOU）
  const claim = await c.env.DB.prepare("UPDATE activation_codes SET used_by=-1, used_at=? WHERE code=? AND used_by IS NULL").bind(new Date().toISOString(), code || "").run();
  if (!claim.meta.changes) return c.json({ ok: false, error: "激活码无效或已被使用" }, 400);
  let slug = username.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!validateSlug(slug)) slug = "b-" + slug;
  if (await c.env.DB.prepare("SELECT id FROM users WHERE board_slug=?").bind(slug).first()) slug = slug + "-" + (Date.now() % 10000);
  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  let uid;
  try {
    const { meta } = await c.env.DB.prepare(
      "INSERT INTO users (username,pass_hash,pass_salt,board_slug,board_name,created_at) VALUES (?,?,?,?,?,?)"
    ).bind(username, hash, salt, slug, username, now).run();
    uid = meta.last_row_id;
  } catch {
    await c.env.DB.prepare("UPDATE activation_codes SET used_by=NULL, used_at=NULL WHERE code=?").bind(code).run(); // 注册失败，归还激活码
    return c.json({ ok: false, error: "用户名或网址已被占用，请重试" }, 409);
  }
  await c.env.DB.prepare("UPDATE activation_codes SET used_by=? WHERE code=?").bind(uid, code).run();
  const token = await signToken(c.env.SESSION_SECRET, { role: "user", uid }, TTL);
  setCookie(c, USER_COOKIE, token, COOKIE_OPTS);
  return c.json({ ok: true, board: { slug, name: username } });
});
app.post("/api/login", async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE username=?").bind(username || "").first();
  if (!user || !(await verifyPassword(password || "", user.pass_salt, user.pass_hash))) return c.json({ ok: false, error: "用户名或密码错误" }, 401);
  const token = await signToken(c.env.SESSION_SECRET, { role: "user", uid: user.id }, TTL);
  setCookie(c, USER_COOKIE, token, COOKIE_OPTS);
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => { setCookie(c, USER_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 }); return c.json({ ok: true }); });

/* ---------- 用户会话中间件 ---------- */
async function currentUserId(c) {
  const token = getCookie(c, USER_COOKIE);
  if (!token) return null;
  const claims = await verifyToken(c.env.SESSION_SECRET, token);
  return claims && claims.role === "user" ? claims.uid : null;
}
app.get("/api/me", async (c) => {
  const uid = await currentUserId(c);
  if (!uid) return c.json({ ok: false, error: "unauthorized" }, 401);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
  if (!user) return c.json({ ok: false }, 401);
  return c.json({ username: user.username, board: { slug: user.board_slug, name: user.board_name } });
});
app.use("/api/my/*", async (c, next) => {
  const uid = await currentUserId(c);
  if (!uid) return c.json({ ok: false, error: "unauthorized" }, 401);
  c.set("uid", uid);
  await next();
});

/* ---------- 用户数据 CRUD（按 uid 隔离） ---------- */
app.get("/api/my/items", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM items WHERE user_id=? ORDER BY sort_order ASC, id ASC").bind(c.get("uid")).all();
  return c.json({ items: (results || []).map(rowToItem) });
});
app.post("/api/my/items", async (c) => {
  const v = validateItem(await c.req.json().catch(() => ({})));
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const it = v.value;
  const { meta } = await c.env.DB.prepare(
    "INSERT INTO items (user_id,ticker,name,symbol,fair_low,fair_high,mos,ext,sort_order,valuations,selected_valuation_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(c.get("uid"), it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder,
    JSON.stringify(it.valuations), it.selectedValuationId, new Date().toISOString()).run();
  return c.json({ ok: true, id: meta.last_row_id }, 201);
});
app.put("/api/my/items/:id", async (c) => {
  const v = validateItem(await c.req.json().catch(() => ({})));
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const it = v.value;
  const { meta } = await c.env.DB.prepare(
    "UPDATE items SET ticker=?,name=?,symbol=?,fair_low=?,fair_high=?,mos=?,ext=?,sort_order=?,valuations=?,selected_valuation_id=?,updated_at=? WHERE id=? AND user_id=?"
  ).bind(it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder,
    JSON.stringify(it.valuations), it.selectedValuationId, new Date().toISOString(),
    Number(c.req.param("id")), c.get("uid")).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true });
});
app.delete("/api/my/items/:id", async (c) => {
  const { meta } = await c.env.DB.prepare("DELETE FROM items WHERE id=? AND user_id=?").bind(Number(c.req.param("id")), c.get("uid")).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true });
});
app.get("/api/my/settings", async (c) => c.json({ settings: await readSettings(c.env.DB, c.get("uid")) }));
app.put("/api/my/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const uid = c.get("uid"), stmts = [];
  for (const k of SETTING_KEYS) {
    if (!(k in body)) continue;
    const val = typeof body[k] === "string" ? body[k].trim() : "";
    if (COLOR_KEYS.includes(k) && val && !HEX_RE.test(val)) continue;
    stmts.push(val
      ? c.env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").bind(uid, k, val)
      : c.env.DB.prepare("DELETE FROM settings WHERE user_id=? AND key=?").bind(uid, k));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, settings: await readSettings(c.env.DB, uid) });
});
app.put("/api/my/board", async (c) => {
  const { slug, name } = await c.req.json().catch(() => ({}));
  if (!validateSlug(slug)) return c.json({ ok: false, error: "网址 slug 需 3-32 位小写字母/数字/-" }, 400);
  const clash = await c.env.DB.prepare("SELECT id FROM users WHERE board_slug=? AND id<>?").bind(slug, c.get("uid")).first();
  if (clash) return c.json({ ok: false, error: "该网址已被占用" }, 409);
  try {
    await c.env.DB.prepare("UPDATE users SET board_slug=?, board_name=? WHERE id=?").bind(slug, typeof name === "string" ? name : "", c.get("uid")).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ ok: false, error: "该网址已被占用" }, 409); // 并发抢占
    throw e;
  }
  return c.json({ ok: true, board: { slug, name: name || "" } });
});

/* ---------- 站长 ---------- */
app.post("/api/owner/login", async (c) => {
  const { password } = await c.req.json().catch(() => ({}));
  if (!password || password !== c.env.ADMIN_PASSWORD) return c.json({ ok: false, error: "密码错误" }, 401);
  const token = await signToken(c.env.SESSION_SECRET, { role: "owner" }, TTL);
  setCookie(c, OWNER_COOKIE, token, COOKIE_OPTS);
  return c.json({ ok: true });
});
app.post("/api/owner/logout", (c) => { setCookie(c, OWNER_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 }); return c.json({ ok: true }); });
// /api/owner/login 与 /logout 故意注册在本中间件之前 → 天然公开（Hono 中间件只作用于其后注册的路由）。
// 其余 /api/owner/* 路由都在下方注册，受本中间件保护。下面这行对 login 是冗余兜底（实际到不了）。
app.use("/api/owner/*", async (c, next) => {
  if (c.req.path === "/api/owner/login") return next();
  const token = getCookie(c, OWNER_COOKIE);
  const claims = token ? await verifyToken(c.env.SESSION_SECRET, token) : null;
  if (!claims || claims.role !== "owner") return c.json({ ok: false, error: "unauthorized" }, 401);
  await next();
});
app.get("/api/owner/codes", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT code, used_by, used_at, created_at FROM activation_codes ORDER BY created_at DESC").all();
  return c.json({ codes: (results || []).map((r) => ({ code: r.code, used: r.used_by != null, usedBy: r.used_by, usedAt: r.used_at })) });
});
app.post("/api/owner/codes", async (c) => {
  const { count } = await c.req.json().catch(() => ({}));
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const now = new Date().toISOString(), created = [], stmts = [];
  for (let i = 0; i < n; i++) { const code = generateCode(); created.push(code); stmts.push(c.env.DB.prepare("INSERT INTO activation_codes (code,used_by,created_at,used_at) VALUES (?,?,?,?)").bind(code, null, now, null)); }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, created });
});
app.get("/api/owner/users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  return c.json({ users: (results || []).map(rowToUser) });
});
app.post("/api/owner/users/:id/reset", async (c) => {
  const tmp = generateCode();
  const { hash, salt } = await hashPassword(tmp);
  const { meta } = await c.env.DB.prepare("UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?").bind(hash, salt, Number(c.req.param("id"))).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, password: tmp });
});

/* ---------- 公开页路由 + 静态 ---------- */
// 旧入口 /app：看板页已查看/编辑合一，重定向到自己的 /b/<slug>（无会话则去登录）。
app.get("/app", async (c) => {
  const uid = await currentUserId(c);
  if (uid) {
    const u = await c.env.DB.prepare("SELECT board_slug FROM users WHERE id=?").bind(uid).first();
    if (u) return c.redirect("/b/" + u.board_slug, 302);
  }
  return c.redirect("/login", 302);
});
// 取根路径的 index.html（canonical，200，不会触发 .html→去扩展名的 307 跳转），
// 浏览器地址保持 /b/<slug>，页面 JS 再从 location.pathname 解析 slug。
app.get("/b/:slug", (c) => { const url = new URL(c.req.url); url.pathname = "/"; return c.env.ASSETS.fetch(new Request(url, { method: "GET" })); });
// 标的详情页：同一个 SPA，前端按 /b/<slug>/<code> 解析后渲染详情
app.get("/b/:slug/:code", (c) => { const url = new URL(c.req.url); url.pathname = "/"; return c.env.ASSETS.fetch(new Request(url, { method: "GET" })); });
// 估值方法介绍页（干净 URL，公开）
app.get("/valuation", (c) => { const url = new URL(c.req.url); url.pathname = "/valuation.html"; return c.env.ASSETS.fetch(new Request(url, { method: "GET" })); });
app.all("*", (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ ok: false, error: "not found" }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});
export default app;
