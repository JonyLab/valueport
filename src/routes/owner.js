// Station-master (owner) admin routes: login/logout, activation codes, users, stats, password reset, encryption backfill.
import { getCookie, setCookie } from "hono/cookie";
import { signToken, verifyToken } from "../auth.js";
import { hashPassword } from "../password.js";
import { generateCode } from "../codes.js";
import { rowToUser } from "../users.js";
import { migratePortfolioBatch } from "../portfolio-storage.js";
import { ownerStats } from "../usage.js";
import { OWNER_COOKIE, SESSION_TTL, COOKIE_OPTS } from "./account.js";

export function registerOwnerRoutes(app) {
  app.post("/api/owner/login", async (c) => {
    const { password } = await c.req.json().catch(() => ({}));
    if (!password || password !== c.env.ADMIN_PASSWORD) return c.json({ ok: false, error: "密码错误" }, 401);
    const token = await signToken(c.env.SESSION_SECRET, { role: "owner" }, SESSION_TTL);
    setCookie(c, OWNER_COOKIE, token, COOKIE_OPTS);
    return c.json({ ok: true });
  });

  app.post("/api/owner/logout", (c) => { setCookie(c, OWNER_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 }); return c.json({ ok: true }); });

  // /api/owner/login 与 /logout 故意注册在本中间件之前 → 天然公开（Hono 中间件只作用于其后注册的路由）。
  app.use("/api/owner/*", async (c, next) => {
    if (c.req.path === "/api/owner/login") return next();
    const token = getCookie(c, OWNER_COOKIE);
    const claims = token ? await verifyToken(c.env.SESSION_SECRET, token) : null;
    if (!claims || claims.role !== "owner") return c.json({ ok: false, error: "unauthorized" }, 401);
    await next();
  });

  app.get("/api/owner/codes", async (c) => {
    const { results } = await c.env.DB.prepare("SELECT a.code, a.used_by, a.used_at, a.created_at, u.username FROM activation_codes a LEFT JOIN users u ON u.id=a.used_by ORDER BY a.created_at DESC").all();
    return c.json({ codes: (results || []).map((r) => ({ code: r.code, used: r.used_by != null, usedBy: r.used_by, usedByName: r.username || null, usedAt: r.used_at, createdAt: r.created_at })) });
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

  app.get("/api/owner/stats", async (c) => { c.header("Cache-Control", "no-store"); return c.json(await ownerStats(c.env)); });

  // Restartable backfill; only counts are returned, never financial values or ciphertext.
  app.post("/api/owner/portfolio/encrypt", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.json().catch(() => ({}));
    return c.json(await migratePortfolioBatch(c.env, body.limit));
  });

  app.post("/api/owner/users/:id/reset", async (c) => {
    const tmp = generateCode();
    const { hash, salt } = await hashPassword(tmp);
    const { meta } = await c.env.DB.prepare("UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?").bind(hash, salt, Number(c.req.param("id"))).run();
    if (!meta.changes) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true, password: tmp });
  });
}
