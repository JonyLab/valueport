// User authentication, session cookie helpers, public board config, and authenticated board/items/settings CRUD.
import { getCookie, setCookie } from "hono/cookie";
import { signToken, verifyToken } from "../auth.js";
import { validateItem, rowToItem } from "../items.js";
import { hashPassword, verifyPassword } from "../password.js";
import { validateUsername, validateSlug } from "../users.js";
import { touchSeen } from "../usage.js";

export const USER_COOKIE = "pendulum_user";
export const OWNER_COOKIE = "pendulum_owner";
export const SESSION_TTL = 7 * 24 * 3600;
export const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL };

// 用户设置：只剩「新标的的默认安全边际 / 泡沫阈值」（页面文案与区间配色已取消，库里旧值不再返回、不再生效）
const NUM_SETTINGS = { default_mos: [5, 95], default_ext: [5, 300] }; // 键 → 允许范围（%）
const SETTING_KEYS = Object.keys(NUM_SETTINGS);

async function readSettings(db, userId) {
  const out = {};
  try {
    const { results } = await db.prepare("SELECT key, value FROM settings WHERE user_id=?").bind(userId).all();
    for (const r of results || []) if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value;
  } catch {}
  return out;
}

export async function currentUserId(c) {
  const token = getCookie(c, USER_COOKIE);
  if (!token) return null;
  const claims = await verifyToken(c.env.SESSION_SECRET, token);
  return claims && claims.role === "user" ? claims.uid : null;
}

export function registerAuthRoutes(app) {
  app.get("/api/config", async (c) => {
    const slug = c.req.query("slug") || "";
    const user = await c.env.DB.prepare("SELECT * FROM users WHERE board_slug=?").bind(slug).first();
    if (!user) return c.json({ error: "board not found" }, 404);
    const { results } = await c.env.DB.prepare("SELECT * FROM items WHERE user_id=? ORDER BY sort_order ASC, id ASC").bind(user.id).all();
    return c.json({ board: { slug: user.board_slug, name: user.board_name }, items: (results || []).map(rowToItem), settings: await readSettings(c.env.DB, user.id) });
  });

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
    const token = await signToken(c.env.SESSION_SECRET, { role: "user", uid }, SESSION_TTL);
    setCookie(c, USER_COOKIE, token, COOKIE_OPTS);
    return c.json({ ok: true, board: { slug, name: username } });
  });

  app.post("/api/login", async (c) => {
    const { username, password } = await c.req.json().catch(() => ({}));
    const user = await c.env.DB.prepare("SELECT * FROM users WHERE username=?").bind(username || "").first();
    if (!user || !(await verifyPassword(password || "", user.pass_salt, user.pass_hash))) return c.json({ ok: false, error: "用户名或密码错误" }, 401);
    const token = await signToken(c.env.SESSION_SECRET, { role: "user", uid: user.id }, SESSION_TTL);
    setCookie(c, USER_COOKIE, token, COOKIE_OPTS);
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => { setCookie(c, USER_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 }); return c.json({ ok: true }); });

  app.get("/api/me", async (c) => {
    const uid = await currentUserId(c);
    if (!uid) return c.json({ ok: false, error: "unauthorized" }, 401);
    const user = await c.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
    if (!user) return c.json({ ok: false }, 401);
    await touchSeen(c.env, uid); // 站长统计里的「最近活跃」
    return c.json({ username: user.username, board: { slug: user.board_slug, name: user.board_name } });
  });

  app.use("/api/my/*", async (c, next) => {
    const uid = await currentUserId(c);
    if (!uid) return c.json({ ok: false, error: "unauthorized" }, 401);
    c.set("uid", uid);
    await next();
  });
}

export function registerBoardRoutes(app) {
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
      const raw = body[k] === null || body[k] === undefined ? "" : String(body[k]).trim();
      const n = Number(raw), [lo, hi] = NUM_SETTINGS[k];
      if (raw && !(Number.isFinite(n) && n >= lo && n <= hi)) return c.json({ error: `${k} must be ${lo}-${hi}` }, 400);
      const val = raw ? String(Math.round(n * 10) / 10) : "";
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
}
