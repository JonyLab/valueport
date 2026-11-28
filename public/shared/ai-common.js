// Shared AI client primitives used by the valuation assistant (ai-panel.js),
// the global assistant (global-ai.js), portfolio query, and valuation review/brief flows.
import { el } from "./dom.js";
import { normalizeResearch } from "./search-sources.js";

// AI 接口失败时给用户看的一句话：区分「全站免费额度用完」和「个人每天次数用完」
export function aiErrorText(status, j, lang) {
  const zh = lang !== "en", e = j && j.error;
  if (e === "search_not_configured") return zh ? "联网搜索暂未配置" : "Web search is not configured";
  if (e === "search_query_required") return zh ? "请输入要搜索的公开关键词" : "Enter public search keywords";
  if (e === "search_company_required") return zh ? "缺少公司名称或代码，无法搜索" : "A company name or ticker is required for search";
  if (e === "search_timeout" || e === "search_failed") return zh ? "联网搜索失败，请重试或关闭搜索后发送" : "Search failed. Retry or turn off web search.";
  if (e === "site_quota") return zh ? "站点的免费 AI 额度今天已用完（全站共用），北京时间早上 8 点恢复；也可以在「设置 → AI 模型」里配置自己的模型，不受这个限制"
    : "The site's free AI allowance is used up for today (shared by everyone); it resets at 00:00 UTC. Add your own model under Settings → AI models to skip this limit";
  if (e === "daily_limit" || status === 429) return zh ? "你今天的 AI 次数已用完，明天再来；在「设置 → AI 模型」里配置自己的模型可不受限制"
    : "You've used today's AI requests; try again tomorrow, or add your own model under Settings → AI models";
  if (e === "bad_ai_output") return zh ? "AI 返回的格式不对，请重试" : "Unexpected AI output, try again";
  if (/访问量过大|稍后再试/.test((j && j.detail) || "")) return zh ? "智谱免费模型现在太忙（并发有限制），稍等一会儿再试，或切换模型" : "The free Zhipu model is busy right now (concurrency is limited); try again shortly or switch models";
  const raw = String((j && j.detail) || e || "");
  if (raw || status) console.warn("[ai]", status, raw);
  if (status === 401 || status === 403) return zh ? "登录已过期，请刷新页面后重新登录" : "Your session has expired. Refresh the page and sign in again";
  if (status === 400 || status === 413) return zh ? "这次提交的内容太多或格式不对，可以精简一下回答后再试" : "This request was too long or malformed. Shorten your answers and try again";
  if (/[\u4e00-\u9fff]/.test(raw) && raw.length < 200 && !/\d{3}/.test(raw)) return raw;
  return zh ? "AI 暂时没有响应，可能是服务繁忙，请稍后再试" : "The AI didn't respond. It may be busy; please try again shortly";
}

export function activeAiModel(models) {
  if (!models || !models.site) return null;
  const all = [models.site, ...(models.workers || []), ...(models.siteKey || []), ...(models.custom || [])];
  return all.find((m) => m.id === models.active) || models.site;
}

// 共用模型切换菜单渲染（ai-panel 用 prefix="vc-ai"，global-ai 用 prefix="gai"）
export function renderAiModelMenu(menu, models, {
  lang = "zh",
  prefix = "vc-ai",
  manageHref = "",
  manageAddText,
  manageText,
  onSelected,
  onDismiss,
} = {}) {
  const zh = lang !== "en";
  menu.replaceChildren();
  const group = (label, items) => {
    if (!items.length) return;
    menu.appendChild(el("div", `${prefix}-mgroup`, label));
    for (const m of items) {
      const on = m.id === models.active;
      const b = el("button", on ? "on" : "");
      b.type = "button";
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(on));
      b.append(
        el("span", `${prefix}-mname`, m.name),
        el("span", `${prefix}-mmodel`, m.kind === "site" ? (zh ? "站点默认" : "Site default") : m.model),
      );
      b.addEventListener("click", async () => {
        if (m.id === models.active) { if (onDismiss) onDismiss(); return; }
        menu.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        const r = await fetch("/api/my/ai/active", {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: m.id }),
        }).catch(() => null);
        if (r && r.ok) {
          models.active = m.id;
          if (onSelected) onSelected(m.id);
        } else {
          menu.querySelectorAll("button").forEach((x) => { x.disabled = false; });
          let err = menu.querySelector('[role="alert"]');
          if (!err) {
            err = el("p", `${prefix}-mgroup ${prefix}-merr`);
            err.setAttribute("role", "alert");
            menu.appendChild(err);
          }
          err.textContent = zh ? "切换失败，请重试。" : "Could not switch models. Try again.";
        }
      });
      menu.appendChild(b);
    }
  };
  group(zh ? "站点默认" : "Site default", [models.site]);
  group("Workers AI", (models.workers || []).filter((w) => w.model !== (models.site.provider === "workers-ai" ? models.site.model : "")));
  group(zh ? "免费模型" : "Free models", models.siteKey || []);
  group(zh ? "我的模型" : "My models", models.custom || []);
  if (manageHref) {
    const hasCustom = (models.custom || []).length > 0;
    const a = el("a", `${prefix}-manage`, hasCustom
      ? (manageText || (zh ? "管理模型…" : "Manage models…"))
      : (manageAddText || (zh ? "添加自己的模型…" : "Add your own model…")));
    a.href = manageHref;
    a.target = "_blank";
    a.rel = "noopener";
    menu.appendChild(a);
  }
}

export function renderSearchSources(research, { lang = "zh", cls = "gai-sources" } = {}) {
  const sources = normalizeResearch(research);
  if (!sources) return null;
  const zh = lang !== "en";
  const refs = el("div", cls);
  refs.appendChild(el("div", "", sources.sources.length
    ? (zh ? "搜索来源 · 摘要待核实" : "Search sources · verify excerpts")
    : (zh ? "本次搜索未找到相关资料" : "No relevant search results")));
  if (sources.searchedAt && Number.isFinite(Date.parse(sources.searchedAt))) {
    refs.appendChild(el("small", "", (zh ? "检索于 " : "Searched ") + new Date(sources.searchedAt).toLocaleString(zh ? "zh-CN" : "en-US")));
  }
  for (const source of sources.sources) {
    const a = el("a", "", `[${source.id}] ${source.title}${source.publishedAt ? " · " + source.publishedAt : ""}`);
    a.href = source.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    refs.appendChild(a);
  }
  return refs;
}

export async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
