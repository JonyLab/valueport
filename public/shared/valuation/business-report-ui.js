import { cleanBusinessReports } from "./business-report.js";

export function businessReportElement(raw, lang = "zh", { onRetry } = {}) {
  const data = cleanBusinessReports(raw); if (!data || data.status === "unsupported") return null;
  const en = lang === "en", t = (zh, english) => en ? english : zh;
  const node = (tag, value) => { const n = document.createElement(tag); if (value !== undefined) n.textContent = value; return n; };
  const link = (label, report, page) => { const a = node("a", label); a.href = report.url + (page ? `#page=${page}` : ""); a.target = "_blank"; a.rel = "noopener noreferrer"; return a; };
  const box = node("details"); box.className = "vc-management-research vc-business-reports";
  const count = data.reports.filter((r) => r.tables.length).length;
  box.append(node("summary", t(`收入结构 · ${count} 份年报 / 中报`, `Revenue mix · ${count} annual / interim reports`)));
  if (!count) {
    box.append(node("p", t("尚未取得可可靠识别的收入分解表。未提取不代表公司未披露；可打开原报告核对。", "No revenue table could be reliably extracted. This does not establish non-disclosure; check the original report.")));
    if (onRetry) { const retry = node("button", t("重新查找报表", "Retry reports")); retry.type = "button"; retry.addEventListener("click", async () => { retry.disabled = true; try { await onRetry(); } finally { retry.disabled = false; } }); box.append(retry); }
  }
  if (count) box.append(node("p", t("按公开目录取得的年报和最新中报分别展示；不自动年化，不合并不同业务口径。* 为根据原文计算，缺失值保留为空。", "Annual and latest interim reports from the checked catalog are shown separately. No automatic annualization or merging of business definitions. * Calculated from the source; missing values remain blank.")));
  for (const report of data.reports) {
    const article = node("article"); article.append(link(`${report.period} · ${report.title}`, report));
    article.append(node("small", t(`披露：${report.publishedAt} · PDF ${report.pageCount || "—"} 页`, `Published ${report.publishedAt} · ${report.pageCount || "—"} PDF pages`)));
    if (!report.tables.length) article.append(node("p", t("本报告暂未成功提取，不能据此断定没有收入结构披露。", "Extraction was unsuccessful; this does not establish non-disclosure.")));
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
  if (data.storage) box.append(node("small", data.storage.status === "refresh_failed" ? t("更新失败，暂用上次保存的报表。", "Refresh failed; showing saved reports.") : t("资料已保存，下次可直接复用。", "Saved for reuse.")));
  return box;
}
