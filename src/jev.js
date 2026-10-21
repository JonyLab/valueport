import { encryptJson, decryptJson } from "./crypto.js";

const KEY = "_jev_key";
const context = (uid) => `jev:${uid}`;
export const JEV_MODEL = "jev-1.14.0";

export class JevError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function askJev(apiKey, state, questions) {
  let response;
  try {
    response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    });
  } catch { throw new JevError("unavailable"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new JevError(response.status === 401 || response.status === 403 ? "invalid_credentials" : "unavailable");
  }
  // 外部响应有上限；不读取或转发供应商错误正文，避免泄露凭证。
  const reader = response.body?.getReader(); if (!reader) throw new JevError("invalid_response");
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 262144) { await reader.cancel(); throw new JevError("invalid_response"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new JevError("invalid_response"); }
}

export function choiceAnswer(answer, options) {
  if (answer?.type !== "choice" || !options.includes(answer.choice) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) throw new JevError("invalid_response");
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(probabilities).length !== options.length || options.some((key) => !Number.isFinite(probabilities[key]) || probabilities[key] < 0 || probabilities[key] > 1)) throw new JevError("invalid_response");
  if (Math.abs(options.reduce((sum, key) => sum + probabilities[key], 0) - 1) > 0.02 || options.some((key) => probabilities[key] > probabilities[answer.choice] + 0.001)) throw new JevError("invalid_response");
  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

// 凭证按用户加密保存；通用 settings 接口的白名单不包含这个字段。
export async function readJevKey(env, uid) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key=?").bind(uid, KEY).first();
  return row ? (await decryptJson(env.CREDENTIALS_KEY, row.value, context(uid))).apiKey : null;
}

export function registerJev(app) {
  app.post("/api/my/ai/jev/test", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const key = await readJevKey(c.env, c.get("uid"));
      if (!key) return c.json({ error: "not_configured" }, 400);
      const result = await askJev(key, { company: "Example", description: "A bank that takes deposits and makes loans." }, {
        sector: { type: "choice", instructions: "Classify the business.", criteria: { financial: "Bank or insurer", other: "Other businesses" } },
      });
      choiceAnswer(result?.answers?.sector, ["financial", "other"]);
      return c.json({ ok: true, model: typeof result.model === "string" ? result.model.slice(0, 80) : JEV_MODEL });
    } catch (e) { return c.json({ error: e instanceof JevError ? e.code : "credential_unreadable" }, 502); }
  });
  app.get("/api/my/ai/jev", async (c) => {
    c.header("Cache-Control", "no-store");
    try { return c.json({ configured: !!(await readJevKey(c.env, c.get("uid"))) }); }
    catch { return c.json({ error: "credential_unreadable" }, 500); }
  });
  app.put("/api/my/ai/jev", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req.json().catch(() => null);
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey || apiKey.length > 500 || /\s|[\x00-\x1f\x7f]/.test(apiKey)) return c.json({ error: "invalid_key" }, 400);
    const uid = c.get("uid");
    let encrypted;
    try { encrypted = await encryptJson(c.env.CREDENTIALS_KEY, { apiKey }, context(uid)); }
    catch { return c.json({ error: "credential_storage_unavailable" }, 503); }
    await c.env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value")
      .bind(uid, KEY, encrypted).run();
    return c.json({ ok: true, configured: true });
  });
  app.delete("/api/my/ai/jev", async (c) => {
    c.header("Cache-Control", "no-store");
    await c.env.DB.prepare("DELETE FROM settings WHERE user_id=? AND key=?").bind(c.get("uid"), KEY).run();
    return c.json({ ok: true, configured: false });
  });
}
