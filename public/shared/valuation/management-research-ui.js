import { cleanManagementResearch, MANAGEMENT_KINDS } from "./management-research.js";

export function managementResearchElement(raw, lang = "zh", { onRetry } = {}) {
  const data = cleanManagementResearch(raw); if (!data) return null;
  const en = lang === "en", node = (tag, value) => {
    const el = document.createElement(tag); if (value !== undefined) el.textContent = value; return el;
  };
  const box = node("details"); box.className = "vc-management-research";
  box.open = !data.sources.length;
  box.append(node("summary", en ? `Earnings evidence · ${data.sources.length} sources` : `财报季研究依据 · ${data.sources.length} 个来源`));
  const messages = {
    empty: en ? "No usable material was found in the checked official pages and news. This does not establish that the company issued no guidance." : "本次检查的官网和新闻中未找到可用资料，不代表公司没有发布指引。",
    unavailable: en ? "Earnings evidence could not be retrieved. Retry, or continue with the financial statements." : "财报季资料暂时获取失败，可以重试或继续使用财报分析。",
    not_configured: en ? "The research source is not configured. You can continue with the financial statements." : "研究资料源暂未配置，可以继续使用财报分析。",
  };
  box.append(node("p", data.status === "ok"
    ? en ? "Official material is listed first when available. Outlook statements remain forecasts. Excerpts may not cover the full call or the latest earnings season."
      : "优先列出已取得的官方原文。公司展望仍是预测，摘录不保证覆盖完整电话会或最新财报季；新闻归属标签仅作初筛。"
    : messages[data.status]));
  if (!data.sources.length && onRetry) {
    const retry = node("button", en ? "Retry retrieval" : "重新获取资料"); retry.type = "button"; retry.className = "vc-guide-secondary";
    retry.addEventListener("click", async () => {
      retry.disabled = true; retry.textContent = en ? "Retrieving…" : "正在获取…";
      try { await onRetry(); }
      finally { retry.disabled = false; retry.textContent = en ? "Retry retrieval" : "重新获取资料"; }
    });
    box.append(retry);
  }
  if (data.officialStatus === "unavailable") box.append(node("p", en ? "Official material could not be retrieved. Any available news is listed below." : "本次官方资料获取失败；如已取得新闻补充资料，将列在下方。"));
  if (data.officialStatus === "empty") box.append(node("p", en ? "No usable official document was found in the checked directory." : "本次检查的官方目录中未找到可用文件。"));
  if (data.officialSite) {
    const website = node("a", en ? "Discovered company website" : "按需发现的公司官网");
    website.href = data.officialSite.website; website.target = "_blank"; website.rel = "noopener noreferrer";
    const ir = node("a", en ? "Investor relations entry" : "投资者关系入口");
    ir.href = data.officialSite.irUrl; ir.target = "_blank"; ir.rel = "noopener noreferrer";
    const entry = node("p"); entry.append(website, document.createTextNode(" · "), ir); box.append(entry);
  }
  if (data.fetchedAt) box.append(node("small", (en ? "Source snapshot: " : "资料快照：") + data.fetchedAt));
  if (data.storage) {
    const status = data.storage.status === "refreshing" ? (en ? "Showing saved material; checking for updates in the background." : "先展示已保存资料，正在后台检查更新。")
      : data.storage.status === "refresh_failed" ? (en ? "Update check failed; the last saved material remains available." : "本次更新检查失败，继续使用上次保存的资料。")
        : (en ? "Material saved for reuse." : "资料已保存，下次可直接复用。");
    box.append(node("p", status));
    if (data.storage.checkedAt) box.append(node("small", (en ? "Last check: " : "上次检查：") + data.storage.checkedAt));
  }
  data.sources.forEach((source, i) => {
    const article = node("article"), link = node("a", `M${i + 1} · ${source.title}`);
    link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    const official = source.sourceType === "official";
    article.append(link, node("small", [official ? (en ? "Official disclosure" : "官方披露") : (en ? "News report" : "新闻转述"), source.publisher, source.publishedAt?.slice(0, 10),
      (official ? (en ? "Report period: " : "文件报告期：") : (en ? "Reported period (unverified): " : "报道所述报告期（未核实）：")) + (source.reportPeriod || (en ? "Unknown" : "未明确"))].filter(Boolean).join(" · ")));
    if (official) article.append(node("p", [source.documentType === "prepared_remarks" ? (en ? "Prepared remarks" : "预备发言稿") : source.documentType === "earnings_release" ? (en ? "Earnings release" : "业绩公告") : (en ? "Earnings call material" : "电话会材料"),
      source.pageCount ? `${source.pageCount} ${en ? "pages" : "页"}` : "", source.qaCoverage === "not_included" ? (en ? "Q&A not included" : "不含问答") : source.qaCoverage === "included" ? (en ? "Includes a Q&A section" : "含问答章节") : (en ? "Q&A coverage unknown" : "问答覆盖未确认")].filter(Boolean).join(" · ")));
    if (official && source.retrievedAt) article.append(node("small", (en ? "Original text retrieved: " : "原文抓取：") + source.retrievedAt));
    for (const passage of source.passages) {
      article.append(node("strong", MANAGEMENT_KINDS[passage.kind][en ? "en" : "zh"]));
      if (official) {
        const location = [passage.speaker, passage.section, passage.page ? `${en ? "Page " : "第 "}${passage.page}${en ? "" : " 页"}` : ""].filter(Boolean).join(" · ");
        const citation = node("a", location || (en ? "Original document" : "原始文件"));
        citation.href = source.url + (passage.page ? `#page=${passage.page}` : ""); citation.target = "_blank"; citation.rel = "noopener noreferrer";
        article.append(citation);
      }
      article.append(node("blockquote", passage.excerpt));
    }
    box.append(article);
  });
  return box;
}
