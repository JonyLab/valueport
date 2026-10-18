// 用户反馈 → GitHub issue（挂在 /api/my/* 登录中间件之后）。
// 配了 GITHUB_TOKEN（fine-grained PAT，仓库 Issues: write）就由 Worker 直接建 issue；
// 没配时 POST 返回 501，前端退回到 GitHub「新建 issue」预填页（见 public/shared/feedback.js）。
// token 只放在请求头里，不写日志、不进任何响应。
import { validateFeedback, buildBody, defang, repoOf, TYPE_LABEL } from "../public/shared/feedback-core.js";

export const FEEDBACK_DAILY_LIMIT = 10;
const USAGE_KEY = "_feedback_usage"; // settings 表里的计数，值为 "YYYY-MM-DD:n"（同 src/ai.js 的 _ai_usage）

async function usedToday(env, uid, day) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key=?").bind(uid, USAGE_KEY).first();
  const [d, n] = row && typeof row.value === "string" ? row.value.split(":") : [];
  return d === day ? Number(n) || 0 : 0;
}

async function createIssue(token, repo, payload) {
  return fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ValuePort-feedback",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export function registerFeedback(app) {
  // 能力探测：前端据此决定「直接提交」还是「去 GitHub 页面」
  app.get("/api/my/feedback", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ server: !!c.env.GITHUB_TOKEN, repo: repoOf(c.env.FEEDBACK_REPO) });
  });

  app.post("/api/my/feedback", async (c) => {
    const v = validateFeedback(await c.req.json().catch(() => null));
    if (v.error) return c.json({ ok: false, error: v.error }, 400);
    const repo = repoOf(c.env.FEEDBACK_REPO), token = c.env.GITHUB_TOKEN;
    if (!token) return c.json({ ok: false, error: "not_configured", repo }, 501);

    const uid = c.get("uid"), day = new Date().toISOString().slice(0, 10);
    const used = await usedToday(c.env, uid, day);
    if (used >= FEEDBACK_DAILY_LIMIT) return c.json({ ok: false, error: "daily_limit", limit: FEEDBACK_DAILY_LIMIT }, 429);
    const user = await c.env.DB.prepare("SELECT username FROM users WHERE id=?").bind(uid).first();

    const payload = { title: defang(v.value.title), body: buildBody(v.value, user && user.username), labels: [TYPE_LABEL[v.value.type]] };
    let res;
    try {
      res = await createIssue(token, repo, payload);
      // 标签设不上（比如 token 没权限管标签）时 GitHub 回 422：去掉标签再试一次，反馈本身更重要
      if (res.status === 422) res = await createIssue(token, repo, { title: payload.title, body: payload.body });
    } catch {
      return c.json({ ok: false, error: "github_unreachable", repo }, 502);
    }
    if (!res.ok) return c.json({ ok: false, error: "github_failed", status: res.status, repo }, 502);
    const issue = await res.json().catch(() => ({}));

    await c.env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value")
      .bind(uid, USAGE_KEY, `${day}:${used + 1}`).run();
    return c.json({ ok: true, url: issue.html_url || `https://github.com/${repo}/issues`, number: issue.number ?? null });
  });
}
