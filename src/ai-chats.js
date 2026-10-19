// AI 估值助手的对话记录（ai_chats 表）：按「用户 + 标的」保存，面板打开时恢复最近一次；「历史」里可切换 / 删除。
// 只存对话本身（问题、AI 正文与结构化回复），不存估值表单；每个标的最多保留 MAX_PER_SYMBOL 条，超出删最旧的。
export const MAX_PER_SYMBOL = 30;
const MAX_MESSAGES = 80, MAX_BYTES = 200000;
const SYMBOL_RE = /^[a-z]{2}[A-Za-z0-9.\-]{1,15}$/;

export function validateChatSave(b) {
  if (!b || typeof b !== "object") return "bad body";
  if (typeof b.symbol !== "string" || !SYMBOL_RE.test(b.symbol)) return "bad symbol";
  if (b.id !== undefined && b.id !== null && !Number.isInteger(b.id)) return "bad id";
  if (b.method !== undefined && (typeof b.method !== "string" || b.method.length > 40)) return "bad method";
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > MAX_MESSAGES) return "messages must be 1-80 items";
  for (const m of b.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.content.length > 8000) return "bad message";
    if (m.view !== undefined && (m.view === null || typeof m.view !== "object")) return "bad view";
  }
  if (JSON.stringify(b.messages).length > MAX_BYTES) return "chat too large";
  return null;
}
const titleOf = (messages) => {
  const q = messages.find((m) => m.role === "user");
  return q ? q.content.replace(/\s+/g, " ").trim().slice(0, 60) : "";
};

export function registerAiChats(app) {
  // 某个标的的对话列表（新的在前），不含消息正文
  app.get("/api/my/ai/chats", async (c) => {
    const symbol = c.req.query("symbol") || "";
    if (!SYMBOL_RE.test(symbol)) return c.json({ error: "bad symbol" }, 400);
    const { results } = await c.env.DB.prepare(
      "SELECT id, method, title, updated_at, json_array_length(messages) AS n FROM ai_chats WHERE user_id=? AND symbol=? ORDER BY updated_at DESC, id DESC LIMIT ?")
      .bind(c.get("uid"), symbol, MAX_PER_SYMBOL).all();
    c.header("Cache-Control", "no-store");
    return c.json({ chats: (results || []).map((r) => ({ id: r.id, method: r.method, title: r.title, updatedAt: r.updated_at, count: r.n })) });
  });
  app.get("/api/my/ai/chats/:id", async (c) => {
    const r = await c.env.DB.prepare("SELECT id, symbol, method, title, messages, updated_at FROM ai_chats WHERE id=? AND user_id=?")
      .bind(Number(c.req.param("id")), c.get("uid")).first();
    if (!r) return c.json({ error: "not found" }, 404);
    c.header("Cache-Control", "no-store");
    let messages = []; try { messages = JSON.parse(r.messages); } catch { messages = []; }
    return c.json({ chat: { id: r.id, symbol: r.symbol, method: r.method, title: r.title, updatedAt: r.updated_at, messages } });
  });
  // 新建（不带 id）或覆盖自己的一条（带 id）
  app.put("/api/my/ai/chats", async (c) => {
    const b = await c.req.json().catch(() => null);
    const err = validateChatSave(b);
    if (err) return c.json({ error: err }, 400);
    const uid = c.get("uid"), now = new Date().toISOString(), msgs = JSON.stringify(b.messages), title = titleOf(b.messages);
    if (b.id) {
      const res = await c.env.DB.prepare("UPDATE ai_chats SET method=?, title=?, messages=?, updated_at=? WHERE id=? AND user_id=? AND symbol=?")
        .bind(b.method || "", title, msgs, now, b.id, uid, b.symbol).run();
      if (res.meta.changes) return c.json({ ok: true, id: b.id, updatedAt: now });
    }
    const ins = await c.env.DB.prepare("INSERT INTO ai_chats (user_id, symbol, method, title, messages, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(uid, b.symbol, b.method || "", title, msgs, now).run();
    // 超出上限：删掉这个标的最旧的几条
    await c.env.DB.prepare(`DELETE FROM ai_chats WHERE user_id=? AND symbol=? AND id NOT IN (
      SELECT id FROM ai_chats WHERE user_id=? AND symbol=? ORDER BY updated_at DESC, id DESC LIMIT ?)`).bind(uid, b.symbol, uid, b.symbol, MAX_PER_SYMBOL).run();
    return c.json({ ok: true, id: ins.meta.last_row_id, updatedAt: now }, 201);
  });
  app.delete("/api/my/ai/chats/:id", async (c) => {
    const res = await c.env.DB.prepare("DELETE FROM ai_chats WHERE id=? AND user_id=?").bind(Number(c.req.param("id")), c.get("uid")).run();
    return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
}
