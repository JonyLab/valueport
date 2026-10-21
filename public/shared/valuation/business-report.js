const text = (s, max) => typeof s === "string" ? s.replace(/[\x00-\x1f]/g, " ").trim().slice(0, max) : "";
const finite = (n) => typeof n === "number" && Number.isFinite(n);
export const businessReportUrl = (url) => typeof url === "string" && /^https:\/\/static\.cninfo\.com\.cn\/finalpage\/\d{4}-\d{2}-\d{2}\/\d+\.pdf$/i.test(url) ? url : null;

// Why a report yielded no table; the server sets these and the UI explains them per report.
export const REPORT_REASONS = ["download_failed", "too_large", "not_pdf", "identity_mismatch", "page_limit", "timeout", "parse_failed", "no_table"];

export function cleanBusinessReports(raw) {
  if (!raw || !["ok", "empty", "unavailable", "unsupported"].includes(raw.status)) return null;
  const reports = [];
  for (const report of Array.isArray(raw.reports) ? raw.reports.slice(0, 2) : []) {
    const url = businessReportUrl(report?.url);
    if (!url || !["annual", "interim"].includes(report.kind) || !Number.isInteger(report.year) || report.year < 1990 || report.year > 2100) continue;
    const pageCount = Number.isInteger(report.pageCount) && report.pageCount > 0 && report.pageCount <= 400 ? report.pageCount : null;
    const validPage = (n) => Number.isInteger(n) && n > 0 && pageCount && n <= pageCount;
    const tables = [];
    for (const table of Array.isArray(report.tables) ? report.tables.slice(0, 3) : []) {
      if (!validPage(table?.pdfPage) || !["consolidated", "management"].includes(table.scope) || table.currency !== "CNY"
        || !finite(table.subtotal) || table.subtotal <= 0 || !Array.isArray(table.rows) || !table.rows.length || table.rows.length > 30) continue;
      const companyRevenue = finite(table.companyRevenue?.value) && table.companyRevenue.value >= table.subtotal * 0.999999
        && table.companyRevenue.currency === "CNY" && validPage(table.companyRevenue.pdfPage)
        ? { value: table.companyRevenue.value, currency: "CNY", pdfPage: table.companyRevenue.pdfPage } : null;
      const rows = table.rows.filter((r) => text(r?.name, 100) && finite(r.revenue) && r.revenue >= 0 && finite(r.cost)).map((r) => {
        const derived = table.scope === "consolidated" ? ["sharePercent", "growthPercent", "grossMarginPercent"] : ["sharePercent"];
        const previousRevenue = finite(r.previousRevenue) ? r.previousRevenue : null;
        return { name: text(r.name, 100), revenue: r.revenue, cost: r.cost, previousRevenue,
          sharePercent: r.revenue / table.subtotal * 100, companySharePercent: companyRevenue ? r.revenue / companyRevenue.value * 100 : null,
          growthPercent: table.scope === "consolidated" ? previousRevenue > 0 ? (r.revenue / previousRevenue - 1) * 100 : null : finite(r.growthPercent) ? r.growthPercent : null,
          grossMarginPercent: table.scope === "consolidated" ? r.revenue > 0 ? (1 - r.cost / r.revenue) * 100 : null : finite(r.grossMarginPercent) ? r.grossMarginPercent : null,
          derived };
      });
      if (rows.length !== table.rows.length || Math.abs(rows.reduce((sum, r) => sum + r.revenue, 0) - table.subtotal) > Math.max(1, table.subtotal * 0.000001)) continue;
      tables.push({ scope: table.scope, basis: table.scope === "management" ? "listed_main_business_sum" : "reported_table_subtotal",
        label: text(table.label, 100), currency: "CNY", originalUnit: text(table.originalUnit, 10), pdfPage: table.pdfPage,
        subtotal: table.subtotal, companyRevenue, coveragePercent: companyRevenue ? table.subtotal / companyRevenue.value * 100 : null,
        excerpt: text(table.excerpt, 6500), rows });
    }
    reports.push({ kind: report.kind, year: report.year, period: `${report.year} ${report.kind === "annual" ? "FY" : "H1"}`,
      title: text(report.title, 200), url, publishedAt: text(report.publishedAt, 10), pageCount,
      status: tables.length ? "ok" : ["unavailable", "unsupported_layout"].includes(report.status) ? report.status : "unsupported_layout",
      ...(!tables.length && REPORT_REASONS.includes(report.reason) ? { reason: report.reason } : {}), tables,
      notes: (Array.isArray(report.notes) ? report.notes : []).filter((n) => validPage(n?.pdfPage) && text(n.excerpt, 650)).slice(0, 3)
        .map((n) => ({ pdfPage: n.pdfPage, excerpt: text(n.excerpt, 650) })) });
  }
  return { status: reports.some((r) => r.tables.length) ? "ok" : raw.status === "ok" ? "unavailable" : raw.status,
    symbol: text(raw.symbol, 24), name: text(raw.name, 100), fetchedAt: text(raw.fetchedAt, 40), reports,
    ...(["saved", "refresh_failed"].includes(raw.storage?.status) ? { storage: { status: raw.storage.status, savedAt: text(raw.storage.savedAt, 40) } } : {}) };
}

export function businessReportFacts(raw, lang = "zh") {
  const data = cleanBusinessReports(raw), en = lang === "en", facts = [];
  if (!data) return facts;
  const pct = (v) => finite(v) ? v.toFixed(2) + "%" : (en ? "not disclosed" : "缺失");
  for (const report of data.reports.filter((r) => r.tables.length)) {
    const table = report.tables[0];
    facts.push(`${report.period} ${en ? "Original report, scope" : "报表原文，口径"}：${table.label}；PDF ${table.pdfPage}；${report.url}`.slice(0, 300));
    for (const row of table.rows.slice(0, 6)) facts.push((en
      ? `${report.period} ${row.name}: revenue CNY ${row.revenue.toFixed(2)}; ${table.companyRevenue ? "company" : "table"} revenue share (calculated) ${pct(row.companySharePercent ?? row.sharePercent)}; YoY ${pct(row.growthPercent)}; gross margin ${pct(row.grossMarginPercent)}. ${table.scope === "consolidated" ? "YoY and margin calculated from same-table amounts." : "YoY and margin reported."} PDF ${table.pdfPage}.`
      : `${report.period} ${row.name}：收入${row.revenue.toFixed(2)}元；${table.companyRevenue ? "公司收入" : "表内收入"}占比（计算）${pct(row.companySharePercent ?? row.sharePercent)}；同比${pct(row.growthPercent)}；毛利率${pct(row.grossMarginPercent)}。${table.scope === "consolidated" ? "同比与毛利率按同表金额计算" : "同比与毛利率为披露值"}，PDF第${table.pdfPage}页。`).slice(0, 300));
    if (table.coveragePercent !== null && table.coveragePercent < 99.9) facts.push(`${report.period} ${en ? "This table covers only part of company revenue" : "此表仅覆盖公司部分收入"}：${pct(table.coveragePercent)}；${en ? "do not treat it as the complete business mix" : "不得当成完整业务构成"}。`);
    if (report.notes[0]) facts.push(`${report.period} ${en ? "Accounting caveat (check applicable business)" : "会计口径原文（须核对适用业务）"}，PDF ${report.notes[0].pdfPage}：${report.notes[0].excerpt}`.slice(0, 300));
  }
  if (facts.length) facts.push(en ? "Report rows are extracted evidence, not a completed driver analysis. Annual and interim amounts are not directly comparable; no automatic annualization or name-based segment merging. Check net/gross accounting and business boundaries before comparing margins."
    : "收入结构是自动提取的研究依据，尚未完成驱动验证。年报与中报金额不能直接同比，不自动年化；不因业务名称相似就合并。比较毛利率前核对净额/总额法及业务边界。");
  return facts.slice(0, 20);
}
