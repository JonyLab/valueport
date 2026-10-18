import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { env, SELF, fetchMock, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import { validateFeedback, cleanMeta, buildBody, issueUrl, repoOf, URL_MAX } from "../public/shared/feedback-core.js";
import { FEEDBACK_DAILY_LIMIT } from "../src/feedback.js";

beforeAll(async () => {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))`,
    `CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT)`,
  ];
  for (const q of ddl) await env.DB.prepare(q).run();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const J = { "content-type": "application/json" };
async function userCookie(username) {
  const own = await SELF.fetch("https://x/api/owner/login", { method: "POST", headers: J, body: JSON.stringify({ password: "test-pass" }) });
  const ck = own.headers.get("set-cookie");
  const code = (await (await SELF.fetch("https://x/api/owner/codes", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify({ count: 1 }) })).json()).created[0];
  const r = await SELF.fetch("https://x/api/register", { method: "POST", headers: J, body: JSON.stringify({ username, password: "secret1", code }) });
  return r.headers.get("set-cookie");
}
const post = (cookie, body) => SELF.fetch("https://x/api/my/feedback", { method: "POST", headers: { ...J, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const GOOD = { type: "bug", title: "Chart does not load", description: "Ping @octocat please", meta: { path: "/b/demo/AAPL?x=1", lang: "en", viewport: "1440x900", ua: "Mozilla/5.0 `x`", cookie: "secret" } };
// 拦截 GitHub 建 issue 的请求并记下请求内容
function mockGithub(status, data, seen) {
  fetchMock.get("https://api.github.com").intercept({ path: "/repos/JonyLab/watchlist/issues", method: "POST" })
    .reply((opts) => { if (seen) seen.push({ headers: opts.headers, body: JSON.parse(opts.body) }); return { statusCode: status, data: JSON.stringify(data), responseOptions: { headers: J } }; });
}
const hdr = (h, k) => (typeof h.get === "function" ? h.get(k) : h[k] ?? h[k.toLowerCase()] ?? Object.entries(h).find(([kk]) => kk.toLowerCase() === k.toLowerCase())?.[1]);

describe("feedback-core", () => {
  it("validates type, title and description lengths", () => {
    expect(validateFeedback(null).error).toBeTruthy();
    expect(validateFeedback({ type: "nope", title: "Hello" }).error).toBeTruthy();
    expect(validateFeedback({ type: "bug", title: "  a " }).error).toBeTruthy();
    expect(validateFeedback({ type: "bug", title: "x".repeat(121) }).error).toBeTruthy();
    expect(validateFeedback({ type: "bug", title: "Hello", description: "x".repeat(5001) }).error).toBeTruthy();
    expect(validateFeedback({ type: "idea", title: " Dark \n mode " }).value).toEqual({ type: "idea", title: "Dark mode", description: "", meta: null });
  });
  it("keeps only whitelisted page info and strips query strings", () => {
    expect(cleanMeta({ path: "/portfolio?token=abc#x", lang: "fr", viewport: "big", ua: "UA", cookie: "s", amount: 5 })).toEqual({ path: "/portfolio", ua: "UA" });
    expect(cleanMeta({ path: "https://evil" })).toBeNull();
  });
  it("defangs mentions and adds the username and page info to the body", () => {
    const body = buildBody(validateFeedback(GOOD).value, "alice");
    expect(body).toContain("@\u200bocto");
    expect(body).toContain("by ValuePort user `alice`");
    expect(body).toContain("- Path: `/b/demo/AAPL`");
    expect(body).not.toContain("secret");
  });
  it("builds a prefilled new-issue url under the length cap", () => {
    const u = new URL(issueUrl("JonyLab/watchlist", validateFeedback(GOOD).value));
    expect(u.origin + u.pathname).toBe("https://github.com/JonyLab/watchlist/issues/new");
    expect(u.searchParams.get("title")).toBe("Chart does not load");
    expect(u.searchParams.get("labels")).toBe("bug");
    const long = issueUrl("JonyLab/watchlist", { type: "idea", title: "Long one", description: "中文".repeat(2500), meta: null });
    expect(long.length).toBeLessThanOrEqual(URL_MAX);
    expect(new URL(long).searchParams.get("body")).toContain("…(truncated)");
    expect(repoOf("bad repo")).toBe("JonyLab/watchlist");
    expect(repoOf("me/fork")).toBe("me/fork");
  });
});

describe("/api/my/feedback", () => {
  it("requires login", async () => {
    expect((await post(null, GOOD)).status).toBe(401);
    expect((await SELF.fetch("https://x/api/my/feedback")).status).toBe(401);
  });
  it("reports the capability without leaking the token", async () => {
    const ck = await userCookie("fbuser1");
    const r = await SELF.fetch("https://x/api/my/feedback", { headers: { cookie: ck } });
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ server: true, repo: "JonyLab/watchlist" });
    expect(text).not.toContain("test-gh-token");
  });
  it("rejects invalid input before calling GitHub", async () => {
    const ck = await userCookie("fbuser2");
    expect((await post(ck, { ...GOOD, type: "x" })).status).toBe(400);
    expect((await post(ck, { ...GOOD, title: "ab" })).status).toBe(400);
    expect((await post(ck, { ...GOOD, description: "x".repeat(5001) })).status).toBe(400);
  });
  it("creates the issue with the right request shape and returns its url", async () => {
    const ck = await userCookie("fbuser3"), seen = [];
    mockGithub(201, { number: 42, html_url: "https://github.com/JonyLab/watchlist/issues/42" }, seen);
    const r = await post(ck, { ...GOOD, type: "idea" });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: true, url: "https://github.com/JonyLab/watchlist/issues/42", number: 42 });
    expect(text).not.toContain("test-gh-token");
    const { headers, body } = seen[0];
    expect(hdr(headers, "authorization")).toBe("Bearer test-gh-token");
    expect(hdr(headers, "accept")).toBe("application/vnd.github+json");
    expect(hdr(headers, "user-agent")).toBeTruthy();
    expect(body.title).toBe("Chart does not load");
    expect(body.labels).toEqual(["enhancement"]);
    expect(body.body).toContain("`fbuser3`");
    expect(body.body).toContain("Viewport: 1440x900");
    expect(body.body).not.toContain("secret");
  });
  it("retries without labels on 422 and maps GitHub failures to 502", async () => {
    const ck = await userCookie("fbuser4"), seen = [];
    mockGithub(422, { message: "Validation Failed" }, seen);
    mockGithub(201, { number: 7, html_url: "https://github.com/JonyLab/watchlist/issues/7" }, seen);
    expect((await (await post(ck, GOOD)).json()).number).toBe(7);
    expect(seen[1].body.labels).toBeUndefined();
    mockGithub(401, { message: "Bad credentials" });
    const r = await post(ck, GOOD);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, error: "github_failed", status: 401, repo: "JonyLab/watchlist" });
  });
  it(`enforces ${FEEDBACK_DAILY_LIMIT} issues per user per day`, async () => {
    const ck = await userCookie("fbuser5");
    const uid = (await env.DB.prepare("SELECT id FROM users WHERE username='fbuser5'").first()).id;
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO settings (user_id,key,value) VALUES (?, '_feedback_usage', ?)").bind(uid, `${day}:${FEEDBACK_DAILY_LIMIT - 1}`).run();
    mockGithub(201, { number: 1, html_url: "https://github.com/JonyLab/watchlist/issues/1" });
    expect((await post(ck, GOOD)).status).toBe(200);
    expect((await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND key='_feedback_usage'").bind(uid).first()).value).toBe(`${day}:${FEEDBACK_DAILY_LIMIT}`);
    const r = await post(ck, GOOD); // 不会再打 GitHub（没有待命的拦截器，打了就会报错）
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe("daily_limit");
    // 计数不出现在用户设置里
    expect((await (await SELF.fetch("https://x/api/my/settings", { headers: { cookie: ck } })).json()).settings._feedback_usage).toBeUndefined();
  });
  it("returns 501 with the repo when no token is configured", async () => {
    const ck = await userCookie("fbuser6");
    const noTok = { ...env, GITHUB_TOKEN: undefined, FEEDBACK_REPO: "me/fork" };
    const call = async (req) => { const ctx = createExecutionContext(); const r = await worker.fetch(req, noTok, ctx); await waitOnExecutionContext(ctx); return r; };
    const cap = await call(new Request("https://x/api/my/feedback", { headers: { cookie: ck } }));
    expect(await cap.json()).toEqual({ server: false, repo: "me/fork" });
    const r = await call(new Request("https://x/api/my/feedback", { method: "POST", headers: { ...J, cookie: ck }, body: JSON.stringify(GOOD) }));
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ ok: false, error: "not_configured", repo: "me/fork" });
  });
});
