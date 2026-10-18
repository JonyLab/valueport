// 反馈 → GitHub issue 的纯逻辑（无 DOM）：前端 /shared/feedback.js 与 Worker src/feedback.js 共用。
// 只处理用户填写的标题 / 描述，以及可选的「页面信息」（路径、语言、窗口尺寸、浏览器 UA）；
// 不碰 cookie、token、金额等任何个人数据。
export const DEFAULT_REPO = "JonyLab/watchlist";
export const TYPES = ["bug", "idea", "other"];
export const TYPE_LABEL = { bug: "bug", idea: "enhancement", other: "question" }; // GitHub 默认标签
export const TYPE_NAME = { bug: "Bug", idea: "Idea", other: "Other" };
export const LIMITS = { titleMin: 3, title: 120, description: 5000, path: 200, ua: 300 };
export const URL_MAX = 8000; // GitHub「新建 issue」预填链接的安全长度

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function repoOf(v) { return typeof v === "string" && REPO_RE.test(v.trim()) ? v.trim() : DEFAULT_REPO; }

// 页面信息白名单：每项不合规就丢掉（不报错），路径去掉 query / hash
export function cleanMeta(m) {
  if (!m || typeof m !== "object") return null;
  const out = {};
  if (typeof m.path === "string" && m.path.startsWith("/")) out.path = m.path.split(/[?#]/)[0].slice(0, LIMITS.path);
  if (m.lang === "zh" || m.lang === "en") out.lang = m.lang;
  if (typeof m.viewport === "string" && /^\d{2,5}x\d{2,5}$/.test(m.viewport)) out.viewport = m.viewport;
  if (typeof m.ua === "string" && m.ua.trim()) out.ua = m.ua.replace(/[`\r\n]/g, " ").trim().slice(0, LIMITS.ua);
  return Object.keys(out).length ? out : null;
}

// 校验表单：返回 { error } 或 { value: { type, title, description, meta } }
export function validateFeedback(b) {
  if (!b || typeof b !== "object") return { error: "invalid body" };
  if (!TYPES.includes(b.type)) return { error: "type must be bug, idea or other" };
  const title = typeof b.title === "string" ? b.title.replace(/\s+/g, " ").trim() : "";
  if (title.length < LIMITS.titleMin || title.length > LIMITS.title) return { error: `title must be ${LIMITS.titleMin}-${LIMITS.title} characters` };
  if (b.description != null && typeof b.description !== "string") return { error: "description must be text" };
  const description = (b.description || "").replace(/\r\n/g, "\n").trim();
  if (description.length > LIMITS.description) return { error: `description must be at most ${LIMITS.description} characters` };
  return { value: { type: b.type, title, description, meta: cleanMeta(b.meta) } };
}

// 别让反馈里的 @someone 去通知 GitHub 用户（插一个零宽空格）
export function defang(s) { return String(s).replace(/@(?=[A-Za-z0-9])/g, "@\u200b"); }

// issue 正文：描述 + 分隔线后的来源说明 + 可选页面信息（折叠）
export function buildBody({ type, description, meta }, username) {
  const lines = [description ? defang(description) : "_(no description)_", "", "---"];
  const by = username ? ` by ValuePort user \`${String(username).replace(/`/g, "")}\`` : "";
  lines.push(`<sub>Filed via ValuePort feedback${by} · ${TYPE_NAME[type] || type}</sub>`);
  if (meta) {
    lines.push("", "<details><summary>Page info</summary>", "");
    if (meta.path) lines.push(`- Path: \`${meta.path.replace(/`/g, "")}\``);
    if (meta.lang) lines.push(`- Language: ${meta.lang}`);
    if (meta.viewport) lines.push(`- Viewport: ${meta.viewport}`);
    if (meta.ua) lines.push(`- User agent: \`${meta.ua}\``);
    lines.push("", "</details>");
  }
  return lines.join("\n");
}

// 没配 GITHUB_TOKEN 时的退路：GitHub「新建 issue」页的预填链接，超长就截短描述
export function issueUrl(repo, fb) {
  const base = `https://github.com/${repoOf(repo)}/issues/new?`;
  const make = (desc) => base + new URLSearchParams({ title: fb.title, body: buildBody({ ...fb, description: desc }), labels: TYPE_LABEL[fb.type] || "" }).toString();
  const desc = fb.description || "", full = make(desc);
  if (full.length <= URL_MAX) return full;
  // 二分找能放下的最长前缀（中文编码后一个字约 9 个字符，不能按比例估）
  const cut = (n) => make(desc.slice(0, n).trimEnd() + "\n\n…(truncated)");
  let lo = 0, hi = desc.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (cut(mid).length <= URL_MAX) lo = mid; else hi = mid - 1; }
  return lo > 0 ? cut(lo) : make("");
}
