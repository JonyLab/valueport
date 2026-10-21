import { cleanBusinessReports } from "./business-report.js";

// 时间戳按本地时间显示到分钟（2026-10-21 22:09）；解析不了就原样显示
const pad = (n) => String(n).padStart(2, "0");
function localTime(value) {
  const date = new Date(value); if (!value || Number.isNaN(date.getTime())) return String(value ?? "");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Per-report explanation of an empty result; never phrased as "the company did not disclose".
function failureText(report, t) {
  const pages = report.pageCount ? t(`（共 ${report.pageCount} 页）`, ` (${report.pageCount} pages)`) : "";
  return {
    no_table: t(`已读取原报告${pages}，但未找到可自动识别的收入分解表；可打开原报告核对。`, `The report was read${pages}, but no revenue table could be recognised automatically; check the original.`),
    too_large: t("文件过大，未能解析；可打开原报告查看。", "The file is too large to parse; open the original report."),
    download_failed: t("报告下载失败，可稍后重试。", "The report could not be downloaded; retry later."),
    not_pdf: t("下载到的不是 PDF 文件，未能解析。", "The download was not a PDF and could not be parsed."),
    identity_mismatch: t("报告封面与公司或报告期对不上，已跳过以免误读。", "The cover does not match the company or period, so it was skipped."),
    page_limit: t("报告篇幅过长，未能完整解析；可打开原报告查看。", "The report is too long to parse fully; open the original report."),
    timeout: t("解析超时，可稍后重试。", "Parsing timed out; retry later."),
  }[report.reason] || t("本报告暂未成功提取，不能据此断定没有收入结构披露。", "Extraction was unsuccessful; this does not establish non-disclosure.");
}

export function businessReportElement(raw, lang = "zh", { onRetry } = {}) {
  const data = cleanBusinessReports(raw); if (!data || data.status === "unsupported") return null;
  const en = lang === "en", t = (zh, english) => en ? english : zh;
  const node = (tag, value) => { const n = document.createElement(tag); if (value !== undefined) n.textContent = value; return n; };
  const link = (label, report, page) => { const a = node("a", label); a.href = report.url + (page ? `#page=${page}` : ""); a.target = "_blank"; a.rel = "noopener noreferrer"; return a; };
  const box = node("details"); box.className = "vc-management-research vc-business-reports";
  const count = data.reports.filter((r) => r.tables.length).length;
  // 提取到才默认展开；没提取到时收起，标题直接写明状态
  box.open = count > 0;
  const summary = node("summary", t("收入结构", "Revenue mix")), meta = node("span", " · " + (count
    ? t(`${count} 份年报 / 中报`, `${count} annual / interim report${count > 1 ? "s" : ""}`)
    : data.reports.length ? t("未能提取", "not extracted")
      : data.status === "empty" ? t("未找到报表", "no reports found") : t("暂未取得", "not retrieved yet")));
  meta.className = "vc-guide-summary-meta"; summary.append(meta); box.append(summary);
  if (!count) {
    box.append(node("p", data.reports.length
      ? t("尚未取得能可靠识别的收入分解表。未提取不代表公司未披露；可打开原报告核对。", "No revenue table could be reliably extracted. This does not establish non-disclosure; check the original report.")
      : data.status === "empty" ? t("公开目录中未找到近年的年报或半年报。", "No recent annual or interim report was found in the public catalog.")
        : t("报表目录暂时获取失败，可以重试。", "The report catalog could not be retrieved; retry later.")));
    if (onRetry) {
      const label = t("重新查找报表", "Retry reports"), retry = node("button", label); retry.type = "button"; retry.className = "vc-guide-secondary";
      retry.addEventListener("click", async () => {
        retry.disabled = true; retry.textContent = t("正在查找…", "Retrieving…");
        try { await onRetry(); } finally { retry.disabled = false; retry.textContent = label; }
      });
      box.append(retry);
    }
  }
  for (const report of data.reports) {
    const article = node("article"); article.append(link(`${report.period} · ${report.title}`, report));
    const pages = report.pageCount ? t(` · PDF ${report.pageCount} 页`, ` · ${report.pageCount} PDF pages`) : "";
    article.append(node("small", t(`披露：${report.publishedAt}${pages}`, `Published ${report.publishedAt}${pages}`)));
    if (!report.tables.length) article.append(node("p", failureText(report, t)));
    report.tables.forEach((table, index) => {
      const section = node(index ? "details" : "section");
      section.append(node(index ? "summary" : "strong", table.label));
      section.append(node("small", t(`${table.scope === "consolidated" ? "合并报表附注" : "经营分析口径"} · 原文单位：${table.originalUnit}，人民币`, `${table.scope === "consolidated" ? "Consolidated notes" : "Management discussion"} · Original unit: ${table.originalUnit}, CNY`)));
      section.append(link(t(`原表：PDF 第 ${table.pdfPage} 页`, `Source table: PDF page ${table.pdfPage}`), report, table.pdfPage));
      const wrap = node("div"); wrap.className = "vc-business-table-wrap";
      const grid = node("table"), head = node("thead"), hr = node("tr");
      for (const label of [t("业务", "Business"), t("收入（亿元）", "Revenue (CNY 100m)"), table.companyRevenue ? t("公司收入占比*", "Company revenue share*") : t("表内收入占比*", "Table revenue share*"), t("同比", "YoY"), t("毛利率", "Gross margin")]) {
        const th = node("th", label); th.scope = "col"; hr.append(th);
      }
      head.append(hr); grid.append(head); const body = node("tbody");
      const percent = (n, star = false) => typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) + "%" + (star ? "*" : "") : "—";
      for (const row of table.rows) {
        const tr = node("tr"), name = node("th", row.name); name.scope = "row"; tr.append(name);
        for (const value of [(row.revenue / 1e8).toFixed(3), percent(row.companySharePercent ?? row.sharePercent), percent(row.growthPercent, row.derived.includes("growthPercent")), percent(row.grossMarginPercent, row.derived.includes("grossMarginPercent"))]) tr.append(node("td", value));
        body.append(tr);
      }
      grid.append(body); wrap.append(grid); section.append(wrap);
      section.append(node("p", t(`表内收入合计 ${(table.subtotal / 1e8).toFixed(3)} 亿元。`, `Table revenue total: CNY ${(table.subtotal / 1e8).toFixed(3)} × 100m.`)));
      if (table.companyRevenue) section.append(link(t(`占比分母：合并营业收入 ${(table.companyRevenue.value / 1e8).toFixed(3)} 亿元，PDF 第 ${table.companyRevenue.pdfPage} 页；此表覆盖 ${table.coveragePercent.toFixed(2)}%。`, `Denominator: consolidated revenue CNY ${(table.companyRevenue.value / 1e8).toFixed(3)} × 100m, PDF page ${table.companyRevenue.pdfPage}; table coverage ${table.coveragePercent.toFixed(2)}%.`), report, table.companyRevenue.pdfPage));
      else section.append(node("p", t("未可靠取得同报告、同币种的公司总收入；占比仅以本表合计为分母。", "A reliable same-report company revenue denominator is unavailable; shares use this table's subtotal.")));
      if (table.scope === "consolidated") section.append(node("small", t("同比 = 本期收入 / 同表上年同期收入 − 1；毛利率 =（收入 − 成本）/ 收入。零基数或缺失值不计算。", "YoY = revenue / same-table prior-period revenue − 1; gross margin = (revenue − cost) / revenue. No calculation on missing or zero denominators.")));
      article.append(section);
    });
    for (const note of report.notes) {
      const caveat = node("details"); caveat.open = true; caveat.append(node("summary", t("会计口径原文 · 核对适用业务", "Accounting caveat · check applicable business")), link(t(`PDF 第 ${note.pdfPage} 页`, `PDF page ${note.pdfPage}`), report, note.pdfPage), node("blockquote", note.excerpt)); article.append(caveat);
    }
    box.append(article);
  }
  const saved = data.storage?.savedAt ? localTime(data.storage.savedAt) : "";
  if (data.storage) box.append(node("small", data.storage.status === "refresh_failed"
    ? t(`更新失败，暂用上次保存的报表${saved ? `（${saved}）` : ""}。`, `Refresh failed; showing saved reports${saved ? ` (${saved})` : ""}.`)
    : t(`资料已保存${saved ? `（${saved}）` : ""}，下次可直接复用。`, `Saved for reuse${saved ? ` (${saved})` : ""}.`)));
  else if (data.fetchedAt) box.append(node("small", t("资料快照：", "Source snapshot: ") + localTime(data.fetchedAt)));
  return box;
}
