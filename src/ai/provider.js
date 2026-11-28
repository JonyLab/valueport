// AI provider configuration, transport adapters (Workers AI / OpenAI-compatible / Anthropic),
// per-user encrypted custom model management, daily quota, and unified chat runner.
import { encryptJson, decryptJson } from "../crypto.js";
import { utcToday } from "../lib/runtime.js";
import { countAi } from "../usage.js";
import { SearchError } from "../web-search.js";

// 模型服务：用户在设置页配置自己的模型（ai_models 表）、在 AI 面板里切换（见 userAi()）；没选就用站点默认（wrangler.toml [vars] / secret）：
//   AI_PROVIDER  workers-ai（默认，用 [ai] 绑定，无需 Key）| openai（OpenAI 兼容协议）| anthropic
//   AI_MODEL     模型名；不填按协议取默认
//   AI_BASE_URL  openai / anthropic 协议的接口地址（可指向任意兼容服务）
//   AI_API_KEY   openai / anthropic 协议的 Key（secret）
const DEFAULTS = {
  "workers-ai": { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
  anthropic: { model: "claude-sonnet-5-5", baseUrl: "https://api.anthropic.com" },
};
const MAX_TOKENS = 4000; // 情景分析写得比较长，留足输出长度（不够时 JSON 会被截断）

export function aiConfig(env) {
  const provider = (env.AI_PROVIDER || "workers-ai").trim().toLowerCase();
  const d = DEFAULTS[provider];
  if (!d) throw new Error(`unknown AI_PROVIDER: ${provider}`);
  return { provider, model: env.AI_MODEL || d.model, baseUrl: (env.AI_BASE_URL || d.baseUrl || "").replace(/\/+$/, ""), apiKey: env.AI_API_KEY || "" };
}

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
// 推理类模型会把思考过程包在 <think> 里，只留最终回答
const clean = (t) => t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

// messages: [{ role: "user"|"assistant", content }]；返回模型回复文本。cfg 不传则用站点默认
export async function chatComplete(env, system, messages, fetchImpl = fetch, cfgIn = null) {
  const text = await rawComplete(env, system, messages, fetchImpl, cfgIn || aiConfig(env));
  return clean(text);
}

async function rawComplete(env, system, messages, fetchImpl, cfg) {
  if (cfg.provider === "workers-ai") {
    if (!env.AI || typeof env.AI.run !== "function") throw new Error("Workers AI binding (AI) is not configured");
    const out = await env.AI.run(cfg.model, { messages: [{ role: "system", content: system }, ...messages], max_tokens: MAX_TOKENS });
    // 老模型返回 { response }，新模型可能返回 OpenAI 形状
    const text = out && (typeof out.response === "string" ? out.response
      : out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content);
    if (typeof text !== "string") throw new Error("empty AI response");
    return text;
  }
  if (!cfg.apiKey) throw new Error("AI_API_KEY is not configured");
  if (cfg.provider === "openai") {
    const zhipu = /(^|\.)bigmodel\.cn$/.test(hostOf(cfg.baseUrl));
    const body = JSON.stringify({ model: cfg.model, max_tokens: MAX_TOKENS, messages: [{ role: "system", content: system }, ...messages],
      ...(zhipu ? { thinking: { type: "disabled" }, ...(cfg.structuredGuide ? { response_format: { type: "json_object" }, temperature: 0.2 } : {}) } : {}) }); // 智谱 GLM：关掉深度思考，更快，也不让思考吃掉输出长度
    let res, j;
    // 智谱免费模型常报「访问量过大」（并发限制），隔一会儿重试两次
    for (let attempt = 0; ; attempt++) {
      res = await fetchImpl(cfg.baseUrl + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cfg.apiKey }, body });
      j = await res.json().catch(() => null);
      const busy = !res.ok && zhipu && (res.status === 429 || /访问量过大|稍后再试|rate limit|concurrency/i.test((j && j.error && j.error.message) || ""));
      if (!busy || attempt >= 2) break;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (!res.ok) throw new Error((j && j.error && j.error.message) || `AI HTTP ${res.status}`);
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== "string") throw new Error("empty AI response");
    return text;
  }
  // anthropic
  const res = await fetchImpl(cfg.baseUrl + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: cfg.model, max_tokens: MAX_TOKENS, system, messages }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error((j && j.error && j.error.message) || `AI HTTP ${res.status}`);
  const text = j && Array.isArray(j.content) ? j.content.filter((b) => b.type === "text").map((b) => b.text).join("") : null;
  if (typeof text !== "string" || !text) throw new Error("empty AI response");
  return text;
}

// ── 用户的模型：设置页只管「配置了哪些」（ai_models 表，可多条），AI 面板里切「用哪个」（settings 内部键 _ai_active）──
// 不用配置就能选的：站点默认（"default"）+ 几个 Workers AI 模型（"wa:<模型 id>"，走站点的 Workers AI 额度）
// 用户自己加的 OpenAI 兼容 / Anthropic 模型：id 为 "m:<行 id>"，Key 用 CREDENTIALS_KEY 加密，接口永不返回明文
export const WORKERS_MODELS = [
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout 17B" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B" },
];
// 站点 Key 的免费模型：站长配了对应的 secret 才出现在列表里（走站点的 Key，同样受每人每天次数限制）
export const SITE_KEY_MODELS = [
  { id: "zhipu-glm-4.7-flash", label: "智谱 GLM-4.7-Flash", model: "glm-4.7-flash", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyEnv: "ZHIPU_API_KEY" },
];
export const siteKeyModels = (env) => SITE_KEY_MODELS.filter((m) => env && env[m.keyEnv]);

const MODEL_RE = /^[\w@.:\/-]{1,100}$/;
const MAX_MODELS = 10;

function cleanBaseUrl(raw) {
  let u; try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || String(raw).length > 300) return null;
  return u.toString().replace(/\/+$/, "");
}

// 新增 / 修改一个自定义模型 → { error } | { value: { provider, name, model, baseUrl, apiKey } }；apiKey 不传 = 沿用已存的
export function validateModel(b) {
  if (!b || typeof b !== "object") return { error: "bad body" };
  const provider = b.provider;
  if (provider !== "openai" && provider !== "anthropic") return { error: "provider must be openai or anthropic" };
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!MODEL_RE.test(model)) return { error: "model required" };
  const name = (typeof b.name === "string" ? b.name.trim() : "").slice(0, 40) || model;
  let baseUrl = "";
  if (b.baseUrl || provider === "openai") { baseUrl = cleanBaseUrl(b.baseUrl); if (!baseUrl) return { error: "base URL must be https" }; }
  let apiKey;
  if (b.apiKey !== undefined && b.apiKey !== "") {
    if (typeof b.apiKey !== "string" || b.apiKey.length > 500 || /\s/.test(b.apiKey.trim())) return { error: "bad api key" };
    apiKey = b.apiKey.trim();
  }
  return { value: { provider, name, model, baseUrl, apiKey } };
}

async function listModelRows(env, uid) {
  try { const { results } = await env.DB.prepare("SELECT * FROM ai_models WHERE user_id=? ORDER BY id ASC").bind(uid).all(); return results || []; }
  catch { return []; } // 线上还没跑迁移时当作没有自定义模型
}

async function readActive(env, uid) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key='_ai_active'").bind(uid).first();
  return row && typeof row.value === "string" ? row.value : "default";
}

const keyHint = (k) => (k && k.length > 4 ? "…" + k.slice(-4) : "");
const rowCfg = async (env, r) => ({ provider: r.provider, model: r.model, baseUrl: r.base_url || DEFAULTS[r.provider].baseUrl, apiKey: (await decryptJson(env.CREDENTIALS_KEY, r.key_enc)).apiKey });

// 当前用户实际用的配置；own = 用的是自己的 Key（不占站点每日额度）。选中的模型被删了就回到站点默认
export async function userAi(env, uid) {
  const active = await readActive(env, uid);
  if (active.startsWith("wa:")) {
    const m = WORKERS_MODELS.find((x) => x.id === active.slice(3));
    if (m) return { cfg: { provider: "workers-ai", model: m.id, baseUrl: "", apiKey: "" }, own: false, active };
  }
  if (active.startsWith("sk:")) {
    const m = siteKeyModels(env).find((x) => x.id === active.slice(3));
    if (m) return { cfg: { provider: "openai", model: m.model, baseUrl: m.baseUrl, apiKey: env[m.keyEnv] }, own: false, active };
  }
  if (active.startsWith("m:")) {
    const r = (await listModelRows(env, uid)).find((x) => String(x.id) === active.slice(2));
    if (r) return { cfg: await rowCfg(env, r), own: true, active };
  }
  return { cfg: aiConfig(env), own: false, active: "default" };
}

// 每人每天的对话次数上限（防刷；计数存在 settings 表的内部键，不在 SETTING_KEYS 白名单里，不会返回给前端）
export const DAILY_LIMIT = 100;

async function takeQuota(env, uid) {
  const day = utcToday();
  const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key='_ai_usage'").bind(uid).first();
  const [d, n] = row && typeof row.value === "string" ? row.value.split(":") : [];
  const used = d === day ? Number(n) || 0 : 0;
  if (used >= DAILY_LIMIT) return false;
  await env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?, '_ai_usage', ?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value")
    .bind(uid, `${day}:${used + 1}`).run();
  return true;
}

// 免费额度用完 / 容量不足：4006（daily free allocation of neurons）、3040（Out of Capacity）、429
export function isWorkersQuotaError(e) {
  const m = String(e && (e.message || e) || "");
  return /\b(4006|3040|429)\b/.test(m) || /neurons?|free allocation|out of capacity|capacity temporarily exceeded|rate limit/i.test(m);
}

// 用当前用户的模型配置调用；自己的 Key 不占站点每日额度。返回 { text } 或 { res }（错误响应）
export function createChatRunner(chat = chatComplete) {
  return async function runChat(c, system, messages, prepareSystem = null, structuredGuide = false) {
    let u;
    try { u = await userAi(c.env, c.get("uid")); } catch { return { res: c.json({ error: "ai_settings_unreadable", detail: "saved API key can't be decrypted — re-enter it in settings" }, 500) }; }
    if (!u.own && !(await takeQuota(c.env, c.get("uid")))) return { res: c.json({ error: "daily_limit" }, 429) };
    await countAi(c.env, c.get("uid"), u.own); // 站长统计的每日 AI 请求数
    try {
      if (prepareSystem) system = await prepareSystem(system);
      return { text: await chat(c.env, system, messages, undefined, { ...u.cfg, structuredGuide }) };
    } catch (e) {
      if (e instanceof SearchError) return { res: c.json({ error: e.code }, e.status) };
      // Workers AI 账号每天的免费额度（10,000 Neurons，全站共用）用完：单独报 site_quota，前端提示「早上 8 点恢复 / 配自己的模型」
      if (u.cfg.provider === "workers-ai" && isWorkersQuotaError(e)) return { res: c.json({ error: "site_quota" }, 429) };
      return { res: c.json({ error: "ai_failed", detail: String(e && e.message || e).slice(0, 300) }, 502) };
    }
  };
}

export function registerAiModelRoutes(app, chat = chatComplete) {
  // 可选模型列表 + 当前选中（AI 面板的切换器和设置页都用）
  app.get("/api/my/ai/models", async (c) => {
    const uid = c.get("uid");
    const rows = await listModelRows(c.env, uid);
    const u = await userAi(c.env, uid).catch(() => ({ active: "default" }));
    const site = aiConfig(c.env);
    const wm = (id) => (WORKERS_MODELS.find((m) => m.id === id) || { label: id }).label;
    const custom = [];
    for (const r of rows) {
      let hint = ""; try { hint = keyHint((await decryptJson(c.env.CREDENTIALS_KEY, r.key_enc)).apiKey); } catch { hint = ""; }
      custom.push({ id: "m:" + r.id, kind: r.provider, name: r.name, model: r.model, baseUrl: r.base_url, keyHint: hint });
    }
    c.header("Cache-Control", "no-store");
    return c.json({
      active: u.active, dailyLimit: DAILY_LIMIT, webSearchAvailable: !!c.env.TAVILY_API_KEY?.trim(),
      site: { id: "default", kind: "site", provider: site.provider, model: site.model, name: site.provider === "workers-ai" ? wm(site.model) : site.model },
      workers: WORKERS_MODELS.map((m) => ({ id: "wa:" + m.id, kind: "workers-ai", name: m.label, model: m.id })),
      siteKey: siteKeyModels(c.env).map((m) => ({ id: "sk:" + m.id, kind: "site-key", name: m.label, model: m.model })),
      custom,
    });
  });

  // 切换当前用的模型
  app.put("/api/my/ai/active", async (c) => {
    const uid = c.get("uid"), b = await c.req.json().catch(() => ({}));
    const id = typeof b.id === "string" ? b.id : "";
    const ok = id === "default" || (id.startsWith("wa:") && WORKERS_MODELS.some((m) => "wa:" + m.id === id))
      || (id.startsWith("sk:") && siteKeyModels(c.env).some((m) => "sk:" + m.id === id))
      || (id.startsWith("m:") && (await listModelRows(c.env, uid)).some((r) => "m:" + r.id === id));
    if (!ok) return c.json({ error: "unknown model" }, 400);
    await c.env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?, '_ai_active', ?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value").bind(uid, id).run();
    return c.json({ ok: true, active: id });
  });

  app.post("/api/my/ai/models", async (c) => {
    const uid = c.get("uid"), v = validateModel(await c.req.json().catch(() => null));
    if (v.error) return c.json({ error: v.error }, 400);
    if (!v.value.apiKey) return c.json({ error: "api key required" }, 400);
    if ((await listModelRows(c.env, uid)).length >= MAX_MODELS) return c.json({ error: `at most ${MAX_MODELS} models` }, 400);
    const enc = await encryptJson(c.env.CREDENTIALS_KEY, { apiKey: v.value.apiKey });
    const r = await c.env.DB.prepare("INSERT INTO ai_models (user_id, provider, name, model, base_url, key_enc, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(uid, v.value.provider, v.value.name, v.value.model, v.value.baseUrl, enc, new Date().toISOString()).run();
    return c.json({ ok: true, id: "m:" + r.meta.last_row_id }, 201);
  });

  const ownRow = async (c) => (await listModelRows(c.env, c.get("uid"))).find((r) => String(r.id) === c.req.param("id")) || null;
  app.put("/api/my/ai/models/:id", async (c) => {
    const row = await ownRow(c);
    if (!row) return c.json({ error: "not found" }, 404);
    const v = validateModel(await c.req.json().catch(() => null));
    if (v.error) return c.json({ error: v.error }, 400);
    if (!v.value.apiKey && v.value.provider !== row.provider) return c.json({ error: "api key required when changing provider" }, 400);
    const enc = v.value.apiKey ? await encryptJson(c.env.CREDENTIALS_KEY, { apiKey: v.value.apiKey }) : row.key_enc;
    await c.env.DB.prepare("UPDATE ai_models SET provider=?, name=?, model=?, base_url=?, key_enc=? WHERE id=? AND user_id=?")
      .bind(v.value.provider, v.value.name, v.value.model, v.value.baseUrl, enc, row.id, c.get("uid")).run();
    return c.json({ ok: true });
  });

  app.delete("/api/my/ai/models/:id", async (c) => {
    const row = await ownRow(c);
    if (!row) return c.json({ error: "not found" }, 404);
    await c.env.DB.prepare("DELETE FROM ai_models WHERE id=? AND user_id=?").bind(row.id, c.get("uid")).run();
    return c.json({ ok: true }); // 正在用的被删了：userAi() 自动回到站点默认
  });

  // 测试连接：用表单里（可能还没保存）的配置发一条最小请求；编辑已有模型时不填 Key 就用已存的
  app.post("/api/my/ai/models/test", async (c) => {
    const b = await c.req.json().catch(() => null);
    const v = validateModel(b);
    if (v.error) return c.json({ error: v.error }, 400);
    let apiKey = v.value.apiKey;
    if (!apiKey && b && typeof b.id === "string" && b.id.startsWith("m:")) {
      const r = (await listModelRows(c.env, c.get("uid"))).find((x) => "m:" + x.id === b.id);
      if (r) { try { apiKey = (await decryptJson(c.env.CREDENTIALS_KEY, r.key_enc)).apiKey; } catch { apiKey = ""; } }
    }
    if (!apiKey) return c.json({ error: "api key required" }, 400);
    const cfg = { provider: v.value.provider, model: v.value.model, baseUrl: v.value.baseUrl || DEFAULTS[v.value.provider].baseUrl, apiKey };
    const t0 = Date.now();
    try {
      const text = await chat(c.env, "You are a connectivity check. Reply with exactly: OK", [{ role: "user", content: "ping" }], undefined, cfg);
      return c.json({ ok: true, reply: String(text).slice(0, 80), ms: Date.now() - t0, model: cfg.model });
    } catch (e) {
      return c.json({ ok: false, error: String(e && e.message || e).slice(0, 300) });
    }
  });
}
