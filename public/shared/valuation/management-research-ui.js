import { cleanManagementResearch, MANAGEMENT_KINDS } from "./management-research.js";

// One short line explaining why no official document was used (codes from the server).
const REASON_TEXT = {
  no_company_website: ["资料源未提供公司官网", "no company website was provided"],
  ir_blocked: ["公司投资者关系网站拒绝了自动访问", "the company IR site refused automated access"],
  ir_unavailable: ["公司投资者关系网站暂时无法访问", "the company IR site could not be reached"],
  ir_not_found: ["公司官网上没找到投资者关系入口", "no investor relations entry was found on the company site"],
  ir_no_documents: ["投资者关系页面没有可直接读取的财报文件（可能由脚本加载）", "the IR page lists no directly readable results documents (likely script-rendered)"],
  ir_documents_rejected: ["官网文件与公司或报告期对不上", "the IR documents did not match the company or report period"],
  pdf_too_large: ["财报文件过大，未读取", "the results document was too large to read"],
  pdf_parse_failed: ["财报 PDF 无法解析", "the results PDF could not be parsed"],
  timeout: ["读取超时", "retrieval timed out"],
};
const FALLBACK_TEXT = {
  not_listed: ["未找到该代码的登记", "the ticker was not found"], no_filings: ["暂未找到业绩公告", "no results announcement was found"],
  unavailable: ["暂时无法访问", "it could not be reached"], blocked: ["访问被拒绝", "access was refused"], documents_rejected: ["公告内容无法核对", "the announcement could not be verified"],
};
export function officialReasonText(reason, lang = "zh") {
  const en = lang === "en", i = en ? 1 : 0, parts = [];
  for (const code of String(reason || "").split(",").filter(Boolean)) {
    const status = code.match(/_blocked_(\d{3})$/)?.[1], base = code.replace(/_\d{3}$/, "");
    const fallback = base.match(/^(sec|hkex)_(.+)$/);
    if (fallback) {
      const tail = FALLBACK_TEXT[fallback[2]]; if (!tail) continue;
      const where = fallback[1] === "sec" ? (en ? "SEC filings" : " SEC 公告") : (en ? "HKEXnews" : "港交所披露易");
      parts.push(en ? `tried ${where}, but ${tail[1]}` : `已尝试${where}，${tail[0]}`);
    } else if (REASON_TEXT[base]) parts.push(REASON_TEXT[base][i] + (status ? (en ? ` (${status})` : `（${status}）`) : ""));
  }
  if (!parts.length) return "";
  const line = parts.join(en ? "; " : "；");
  return en ? line[0].toUpperCase() + line.slice(1) + "." : line + "。";
}

// 时间戳按本地时间显示到分钟（2026-10-21 22:09）；解析不了就原样显示
const pad = (n) => String(n).padStart(2, "0");
function localTime(value) {
  const date = new Date(value); if (!value || Number.isNaN(date.getTime())) return String(value ?? "");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function managementResearchElement(raw, lang = "zh", { onRetry } = {}) {
  const data = cleanManagementResearch(raw); if (!data) return null;
  const en = lang === "en", node = (tag, value) => {
    const el = document.createElement(tag); if (value !== undefined) el.textContent = value; return el;
  };
  const box = node("details"); box.className = "vc-management-research";
  // 默认收起，不把下面的问题挤出首屏；标题上直接写明状态（几个来源 / 暂未取得），不用展开也知道
  box.open = false;
  const summary = node("summary", en ? "Earnings evidence" : "财报季研究依据"), meta = node("span", " · " + (data.sources.length
    ? (en ? `${data.sources.length} source${data.sources.length > 1 ? "s" : ""}` : `${data.sources.length} 个来源`)
    : data.status === "empty" ? (en ? "nothing usable found" : "未找到可用资料")
      : data.status === "not_configured" ? (en ? "not configured" : "未配置")
        : (en ? "not retrieved yet" : "暂未取得")));
  meta.className = "vc-guide-summary-meta"; summary.append(meta); box.append(summary);
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
  const reasonLine = !data.sources.some((s) => s.sourceType === "official") && officialReasonText(data.officialReason, lang);
  if (reasonLine) box.append(node("p", reasonLine));
  if (data.officialSite) {
    const website = node("a", en ? "Discovered company website" : "按需发现的公司官网");
    website.href = data.officialSite.website; website.target = "_blank"; website.rel = "noopener noreferrer";
    const ir = node("a", en ? "Investor relations entry" : "投资者关系入口");
    ir.href = data.officialSite.irUrl; ir.target = "_blank"; ir.rel = "noopener noreferrer";
    const entry = node("p"); entry.append(website, document.createTextNode(" · "), ir); box.append(entry);
  }
  if (data.fetchedAt) box.append(node("small", (en ? "Source snapshot: " : "资料快照：") + localTime(data.fetchedAt)));
  if (data.storage) {
    const status = data.storage.status === "refreshing" ? (en ? "Showing saved material; checking for updates in the background." : "先展示已保存资料，正在后台检查更新。")
      : data.storage.status === "refresh_failed" ? (en ? "Update check failed; the last saved material remains available." : "本次更新检查失败，继续使用上次保存的资料。")
        : (en ? "Material saved for reuse." : "资料已保存，下次可直接复用。");
    box.append(node("p", status));
    if (data.storage.checkedAt) box.append(node("small", (en ? "Last check: " : "上次检查：") + localTime(data.storage.checkedAt)));
  }
  data.sources.forEach((source, i) => {
    const article = node("article"), link = node("a", `M${i + 1} · ${source.title}`);
    link.href = source.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    const official = source.sourceType === "official";
    article.append(link, node("small", [official ? (en ? "Official disclosure" : "官方披露") : (en ? "News report" : "新闻转述"), source.publisher, source.publishedAt?.slice(0, 10),
      (official ? (en ? "Report period: " : "文件报告期：") : (en ? "Reported period (unverified): " : "报道所述报告期（未核实）：")) + (source.reportPeriod || (en ? "Unknown" : "未明确"))].filter(Boolean).join(" · ")));
    if (official) article.append(node("p", [source.documentType === "prepared_remarks" ? (en ? "Prepared remarks" : "预备发言稿") : source.documentType === "earnings_release" ? (en ? "Earnings release" : "业绩公告") : (en ? "Earnings call material" : "电话会材料"),
      source.pageCount ? `${source.pageCount} ${en ? "pages" : "页"}` : "", source.qaCoverage === "not_included" ? (en ? "Q&A not included" : "不含问答") : source.qaCoverage === "included" ? (en ? "Includes a Q&A section" : "含问答章节") : (en ? "Q&A coverage unknown" : "问答覆盖未确认")].filter(Boolean).join(" · ")));
    if (official && source.retrievedAt) article.append(node("small", (en ? "Original text retrieved: " : "原文抓取：") + localTime(source.retrievedAt)));
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
