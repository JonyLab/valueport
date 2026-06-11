import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { signToken, verifyToken } from "./auth.js";
import { validateItem, rowToItem } from "./items.js";
import { parseTencentQuotes, parseTencentHints } from "./quotes.js";

const app = new Hono();
const SESSION_COOKIE = "pendulum_session";
const SESSION_TTL = 7 * 24 * 3600;

// 可配置项；前端持有默认值，这里只存/返回已自定义的键。
const TEXT_KEYS = ["eyebrow", "title", "subtitle"];                          // 页面文案
const COLOR_KEYS = ["color_deep", "color_under", "color_fair", "color_over", "color_xover"]; // 区间色块
const SETTING_KEYS = [...TEXT_KEYS, ...COLOR_KEYS];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
async function readSettings(db) {
  const out = {};
  try {
    const { results } = await db.prepare("SELECT key, value FROM settings").all();
    for (const r of results || []) if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value;
  } catch { /* settings 表尚未迁移时退回默认文案，不影响看板 */ }
  return out;
}

// 服务端抓腾讯并按 GBK 解码为文本
async function fetchGbk(url) {
  const res = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder("gbk").decode(buf);
}

/* ---------- 公开接口 ---------- */
app.get("/api/config", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM items ORDER BY sort_order ASC, id ASC"
  ).all();
  return c.json({ items: (results || []).map(rowToItem), settings: await readSettings(c.env.DB) });
});

app.get("/api/quotes", async (c) => {
  const symbols = (c.req.query("symbols") || "").split(",").map((s) => s.trim())
    .filter((s) => s && s.length <= 16).slice(0, 50);
  if (!symbols.length) return c.json({ quotes: {}, ts: new Date().toISOString() });
  try {
    const text = await fetchGbk("https://qt.gtimg.cn/q=" + symbols.join(","));
    return c.json({ quotes: parseTencentQuotes(text, symbols), ts: new Date().toISOString() });
  } catch {
    return c.json({ quotes: {}, error: "upstream unreachable", ts: new Date().toISOString() }, 502);
  }
});

app.get("/api/hints", async (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.json({ hints: [] });
  try {
    const text = await fetchGbk(
      "https://smartbox.gtimg.cn/s3/?v=2&t=all&q=" + encodeURIComponent(q)
    );
    return c.json({ hints: parseTencentHints(text) });
  } catch {
    return c.json({ hints: [] });
  }
});

/* ---------- 登录 ---------- */
app.post("/api/login", async (c) => {
  const { password } = await c.req.json().catch(() => ({}));
  if (!password || password !== c.env.ADMIN_PASSWORD) {
    return c.json({ ok: false, error: "invalid password" }, 401);
  }
  const token = await signToken(c.env.SESSION_SECRET, SESSION_TTL);
  // Strict: admin panel is same-origin only; no cross-site navigation needs to carry the session.
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL,
  });
  return c.json({ ok: true });
});

app.post("/api/logout", (c) => {
  setCookie(c, SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

/* ---------- 后台鉴权中间件 ---------- */
app.use("/api/admin/*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !(await verifyToken(c.env.SESSION_SECRET, token))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});

/* ---------- 后台 CRUD ---------- */
app.get("/api/admin/items", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM items ORDER BY sort_order ASC, id ASC"
  ).all();
  return c.json({ items: (results || []).map(rowToItem) });
});

app.post("/api/admin/items", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const v = validateItem(body);
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const it = v.value;
  const { meta } = await c.env.DB.prepare(
    `INSERT INTO items (ticker,name,symbol,fair_low,fair_high,mos,ext,sort_order,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder,
    new Date().toISOString()).run();
  return c.json({ ok: true, id: meta.last_row_id }, 201);
});

app.put("/api/admin/items/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const v = validateItem(body);
  if (!v.ok) return c.json({ ok: false, errors: v.errors }, 400);
  const it = v.value;
  const { meta } = await c.env.DB.prepare(
    `UPDATE items SET ticker=?,name=?,symbol=?,fair_low=?,fair_high=?,mos=?,ext=?,sort_order=?,updated_at=?
     WHERE id=?`
  ).bind(it.ticker, it.name, it.symbol, it.fairLow, it.fairHigh, it.mos, it.ext, it.sortOrder,
    new Date().toISOString(), id).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/admin/items/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { meta } = await c.env.DB.prepare("DELETE FROM items WHERE id=?").bind(id).run();
  if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true });
});

/* ---------- 页面文案设置 ---------- */
app.get("/api/admin/settings", async (c) => {
  return c.json({ settings: await readSettings(c.env.DB) });
});

app.put("/api/admin/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const stmts = [];
  for (const k of SETTING_KEYS) {
    if (!(k in body)) continue;
    const v = typeof body[k] === "string" ? body[k].trim() : "";
    if (COLOR_KEYS.includes(k) && v && !HEX_RE.test(v)) continue; // 非法 hex：忽略，不改动
    stmts.push(v
      ? c.env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k, v)
      : c.env.DB.prepare("DELETE FROM settings WHERE key=?").bind(k)); // 清空即恢复默认
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, settings: await readSettings(c.env.DB) });
});

// 未匹配的 /api/* 返回 JSON 404；其余交给静态资源（public/）
app.all("*", (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ ok: false, error: "not found" }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
