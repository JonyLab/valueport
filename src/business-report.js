// Original A-share periodic reports, discovered by security code rather than issuer adapters.
const CATALOG = "https://www.cninfo.com.cn";
const CDN = "https://static.cninfo.com.cn";
const compact = (s) => String(s || "").replace(/\s+/g, "");
const numeric = (s) => /^-?[\d,]+(?:\.\d+)?$/.test(compact(s)) ? Number(compact(s).replace(/,/g, "")) : null;

async function bounded(response, limit) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("report_request_failed"); }
  if (Number(response.headers.get("content-length")) > limit) { await response.body.cancel(); throw new Error("report_too_large"); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw new Error("report_too_large"); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(size); let offset = 0;
  for (const value of chunks) { result.set(value, offset); offset += value.length; }
  return result;
}

export function selectPeriodicReports(items, code, now = Date.now()) {
  const candidates = (Array.isArray(items) ? items : []).flatMap((item) => {
    const title = String(item.announcementTitle || "").replace(/<[^>]*>/g, "");
    const period = title.match(/(20\d{2})年(半年度|年度)报告(?:[（(](?:修订|更正|更新)[^）)]{0,12}[）)])?$/);
    if (item.secCode !== code || !period || /摘要|英文|取消|作废|提示|更正公告|说明|回复/.test(title)
      || !/^finalpage\/\d{4}-\d{2}-\d{2}\/\d+\.pdf$/i.test(item.adjunctUrl || "")
      || !Number.isFinite(item.announcementTime) || item.announcementTime > now
      || Number(period[1]) > new Date(now).getUTCFullYear() - (period[2] === "年度" ? 1 : 0)) return [];
    return [{ kind: period[2] === "年度" ? "annual" : "interim", year: Number(period[1]),
      period: `${period[1]} ${period[2] === "年度" ? "FY" : "H1"}`, title: title.slice(0, 200),
      url: CDN + "/" + item.adjunctUrl, publishedAt: new Date(item.announcementTime + 8 * 3600000).toISOString().slice(0, 10),
      publishedTime: item.announcementTime }];
  }).sort((a, b) => b.year - a.year || b.publishedTime - a.publishedTime);
  return ["annual", "interim"].map((kind) => candidates.find((r) => r.kind === kind)).filter(Boolean);
}

export async function discoverPeriodicReports(symbol, { fetchImpl = fetch, signal, now = Date.now() } = {}) {
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) return null;
  const code = symbol.slice(2);
  const post = async (path, params) => JSON.parse(new TextDecoder().decode(await bounded(await fetchImpl(CATALOG + path, {
    method: "POST", signal, redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", Referer: CATALOG + "/", "User-Agent": "Mozilla/5.0" },
    body: new URLSearchParams(params).toString(),
  }), 1024000)));
  const identity = await post("/new/information/topSearch/detailOfQuery", { keyWord: code, maxSecNum: "10", maxListNum: "1" });
  const expectedPlate = { sh: "sse", sz: "szse", bj: "bse" }[symbol.slice(0, 2)];
  const company = identity.keyBoardList?.find((item) => item.code === code && item.plate === expectedPlate && /^\d{1,20}$/.test(item.orgId));
  if (!company) return { code, name: "", reports: [] };
  const end = new Date(now).toISOString().slice(0, 10), start = `${new Date(now).getUTCFullYear() - 3}-01-01`;
  const result = await post("/new/hisAnnouncement/query", { pageNum: "1", pageSize: "60", column: company.plate,
    tabName: "fulltext", stock: code + "," + company.orgId, searchkey: "", secid: "", plate: "", trade: "",
    category: "category_ndbg_szsh;category_bndbg_szsh;", seDate: start + "~" + end, sortName: "time", sortType: "desc", isHLtitle: "false" });
  // A bounded recent catalog is a discovery window, not a claim of complete archive coverage.
  return { code, name: String(company.zwjc || "").slice(0, 100), reports: selectPeriodicReports(result.announcements, code, now) };
}

// Preserve coordinates: blank cells must never shift the following year's amounts left.
export function reportLines(items) {
  const lines = [];
  for (const item of items.filter((i) => typeof i.str === "string" && i.str.trim() && Array.isArray(i.transform))) {
    const x = item.transform[4], y = item.transform[5];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    let line = lines.find((r) => Math.abs(r.y - y) < 2);
    if (!line) { line = { y, items: [] }; lines.push(line); }
    line.items.push({ text: item.str.trim(), x, width: Number(item.width) || 0 });
  }
  return lines.sort((a, b) => b.y - a.y).map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    const merged = [];
    for (const item of line.items) {
      const last = merged.at(-1);
      if (last && /^[\d,.-]+$/.test(last.text) && /^[\d,.-]+$/.test(item.text) && item.x - (last.x + last.width) < 3) {
        last.text += item.text; last.width = item.x + item.width - last.x;
      } else merged.push({ ...item });
    }
    return { y: line.y, items: merged, text: merged.map((i) => i.text).join(" ") };
  });
}

function unitOf(text) {
  const m = compact(text).match(/单位[:：](人民币)?(亿元|万元|千元|元)(?:币种[:：](人民币|美元|港元))?/);
  if (!m || (!m[1] && m[3] !== "人民币")) return null;
  return { currency: "CNY", unit: m[2], multiplier: { 元: 1, 千元: 1000, 万元: 10000, 亿元: 1e8 }[m[2]] };
}

function fourColumns(lines) {
  return lines.map((line) => line.items.filter((i) => /^(营业)?(收入|成本)$/.test(compact(i.text))))
    .find((cells) => cells.length === 4 && cells.map((i) => compact(i.text).replace(/^营业/, "")).join() === "收入,成本,收入,成本")
    ?.map((i) => i.x + i.width / 2);
}

export function extractMainBusinessTable(page) {
  const lines = reportLines(page.items), start = lines.findIndex((l) => /^主营业务分产品情况$/.test(compact(l.text)));
  if (start < 0) return null;
  const unit = unitOf(lines.slice(Math.max(0, start - 30), start).map((l) => l.text).join(" "));
  const end = lines.findIndex((l, i) => i > start && /^主营业务分(?:地区|销售模式|行业)情况$/.test(compact(l.text)));
  if (!unit || end < 0) return null;
  const block = lines.slice(start + 1, end);
  const header = block.find((l) => l.items.some((i) => compact(i.text) === "分产品"));
  const upper = block.find((l) => l.items.some((i) => compact(i.text) === "毛利率比"));
  const primary = header?.items.filter((i) => /^(营业收入|营业成本|毛利率)$/.test(compact(i.text)));
  const secondary = upper?.items.filter((i) => /^(营业收入|营业成本|毛利率比)$/.test(compact(i.text)));
  if (primary?.length !== 3 || secondary?.length !== 3) return null;
  const columns = [...primary, ...secondary].map((i) => i.x + i.width / 2);
  const raw = readRows(block.filter((l) => l.y < header.y - 8), columns);
  if (!raw.length || raw.length > 30 || raw.some((r) => !r.name || r.values[0] < 0 || r.values[1] === null
    || r.values[2] === null || (r.values[0] > 0 && Math.abs((1 - r.values[1] / r.values[0]) * 100 - r.values[2]) > 0.03))) return null;
  const subtotal = raw.reduce((sum, r) => sum + r.values[0] * unit.multiplier, 0);
  if (!(subtotal > 0)) return null;
  return { scope: "management", basis: "listed_main_business_sum", label: "主营业务分产品（经营分析）", currency: unit.currency,
    originalUnit: unit.unit, pdfPage: page.page, subtotal, companyRevenue: null, coveragePercent: null,
    excerpt: lines.slice(start, end).map((l) => l.text).join("\n").slice(0, 6500),
    rows: raw.map(({ name, values: [rev, cost, margin, growth] }) => ({ name: name.slice(0, 100), revenue: rev * unit.multiplier,
      cost: cost * unit.multiplier, previousRevenue: null, sharePercent: rev * unit.multiplier / subtotal * 100,
      growthPercent: growth, grossMarginPercent: margin, derived: ["sharePercent"] })) };
}

function readRows(lines, columns) {
  const firstBoundary = columns[0] - (columns[1] - columns[0]) / 2;
  const numericRows = lines.flatMap((line) => {
    const values = columns.map(() => null);
    for (const item of line.items.filter((i) => i.x + i.width / 2 > firstBoundary)) {
      const value = numeric(item.text); if (value === null || !Number.isFinite(value)) continue;
      const center = item.x + item.width / 2;
      const index = columns.reduce((best, x, i) => Math.abs(x - center) < Math.abs(columns[best] - center) ? i : best, 0);
      if (Math.abs(columns[index] - center) > (columns[1] - columns[0]) * 0.45 || values[index] !== null) continue;
      values[index] = value;
    }
    return values[0] !== null ? [{ ...line, values }] : [];
  });
  return numericRows.map((row, index) => {
    const top = index ? (numericRows[index - 1].y + row.y) / 2 : row.y + 12;
    const bottom = index < numericRows.length - 1 ? (row.y + numericRows[index + 1].y) / 2 : row.y - 12;
    const name = lines.filter((l) => l.y <= top && l.y > bottom).flatMap((l) => l.items.filter((i) => i.x + i.width / 2 < firstBoundary))
      .map((i) => i.text).join("").replace(/\s+/g, "");
    return { name, values: row.values };
  });
}

export function extractRevenueTable(page, { scope, companyRevenue = null } = {}) {
  if (scope !== "consolidated") return null;
  const lines = reportLines(page.items), start = lines.findIndex((l) => /营业收入[、和及]营业成本的分解信息/.test(compact(l.text)));
  if (start < 0) return null;
  const tableLines = lines.slice(start), unit = unitOf(tableLines.slice(0, 8).map((l) => l.text).join(" "));
  const columns = fourColumns(tableLines.slice(0, 12));
  const product = tableLines.findIndex((l) => /^(商品类型|产品类型|按产品分类|按商品类型分类)$/.test(compact(l.text)));
  if (!unit || !columns || product < 0) return null;
  const end = tableLines.findIndex((l, i) => i > product && /^(小计|合计|按经营地区分类|按地区分类)$/.test(compact(l.text)));
  if (end < 0) return null;
  const rawRows = readRows(tableLines.slice(product + 1, end + 1), columns);
  const subtotal = rawRows.find((r) => /^(小计|合计)$/.test(r.name));
  const rows = rawRows.filter((r) => r.name && !/^(小计|合计)$/.test(r.name));
  if (!subtotal || !rows.length || rows.length > 30 || rows.some((r) => r.values[0] < 0 || r.values[1] === null)) return null;
  const sum = rows.reduce((s, r) => s + r.values[0], 0);
  if (Math.abs(sum - subtotal.values[0]) > Math.max(1, Math.abs(subtotal.values[0]) * 0.000001)) return null;
  const total = subtotal.values[0] * unit.multiplier;
  if (!(total > 0)) return null;
  // Ratios use this table's subtotal; never assume a contract-revenue table covers all revenue.
  return { scope: "consolidated", basis: "reported_table_subtotal", label: "营业收入、营业成本分解（商品类型）", currency: unit.currency,
    originalUnit: unit.unit, pdfPage: page.page, subtotal: total, companyRevenue,
    coveragePercent: companyRevenue?.value > 0 ? total / companyRevenue.value * 100 : null,
    excerpt: tableLines.slice(0, end + 1).map((l) => l.text).join("\n").slice(0, 6500),
    rows: rows.map(({ name, values: [rev, cost, previousRev] }) => {
      const revenue = rev * unit.multiplier, previousRevenue = previousRev === null ? null : previousRev * unit.multiplier;
      return { name: name.slice(0, 100), revenue, cost: cost * unit.multiplier, previousRevenue,
        sharePercent: revenue / total * 100,
        growthPercent: previousRevenue > 0 ? (revenue / previousRevenue - 1) * 100 : null,
        grossMarginPercent: revenue > 0 ? (1 - cost * unit.multiplier / revenue) * 100 : null,
        derived: ["sharePercent", "growthPercent", "grossMarginPercent"] };
    }) };
}

export async function extractBusinessReportPdf(bytes, document, identity, { signal } = {}) {
  if (bytes.length > 8 * 1024 * 1024 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("invalid_report_pdf");
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: false, cMapUrl: undefined, standardFontDataUrl: undefined });
  try {
    if (pdf.numPages > 400) throw new Error("report_page_limit");
    let scope = "unknown", companyRevenue = null, incomeTable = null, length = 0;
    const tables = [], notes = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      signal?.throwIfAborted();
      const p = await pdf.getPage(page), content = await p.getTextContent();
      const text = content.items.map((i) => typeof i.str === "string" ? i.str + (i.hasEOL ? "\n" : " ") : "").join("");
      length += text.length; if (length > 1500000) throw new Error("report_text_limit");
      const flat = compact(text);
      if (page === 1 && (!new RegExp(`(?:公司|股票|证券)代码[:：]?${identity.code}`).test(flat)
        || !flat.includes(identity.name) || !flat.includes(`${document.year}年${document.kind === "annual" ? "年度" : "半年度"}报告`))) throw new Error("report_identity_mismatch");
      if (/^[一二三四五六七八九十百0-9]+[、.．]\s*合并[^\n]{0,20}报表[^\n]{0,20}注释\s*$/m.test(text)) scope = "consolidated";
      if (/^[一二三四五六七八九十百0-9]+[、.．]\s*母公司[^\n]{0,20}报表[^\n]{0,20}注释\s*$/m.test(text)) { scope = "parent"; incomeTable = null; }
      const lines = reportLines(content.items);
      if (scope === "unknown" && tables.length < 3) {
        const main = extractMainBusinessTable({ page, items: content.items }); if (main) tables.push(main);
      }
      if (scope === "consolidated") {
        const income = lines.findIndex((l) => /营业收入(?:和|及|、)营业成本情况/.test(compact(l.text)));
        if (income >= 0) {
          const block = lines.slice(income), unit = unitOf(block.slice(0, 8).map((l) => l.text).join(" ")), columns = fourColumns(block.slice(0, 12));
          incomeTable = unit && columns ? { unit, columns } : null;
        }
        if (incomeTable) {
          const end = lines.findIndex((l) => /营业收入[、和及]营业成本的分解信息/.test(compact(l.text)));
          const incomeLines = lines.slice(income >= 0 ? income : 0, end < 0 ? undefined : end);
          const total = readRows(incomeLines, incomeTable.columns).find((r) => r.name === "合计");
          if (total && total.values[0] > 0) companyRevenue = { value: total.values[0] * incomeTable.unit.multiplier, pdfPage: page, currency: incomeTable.unit.currency };
          if (end >= 0) incomeTable = null;
        }
        const table = extractRevenueTable({ page, items: content.items }, { scope, companyRevenue });
        if (table && tables.length < 3) tables.push(table);
      }
      // Keep actual accounting caveats separately; do not infer that they apply to every row.
      if (notes.length < 3 && /净额法|总额法/.test(flat)) {
        const paragraphs = text.split(/\n/), at = paragraphs.findIndex((line) => /净额法|总额法/.test(line));
        if (at >= 0) notes.push({ pdfPage: page, excerpt: paragraphs.slice(Math.max(0, at - 1), at + 4).join(" ").replace(/\s+/g, " ").slice(0, 650) });
      }
      p.cleanup();
    }
    for (const table of tables) {
      if (!table.companyRevenue && companyRevenue && companyRevenue.value >= table.subtotal * 0.999999) {
        table.companyRevenue = companyRevenue; table.coveragePercent = table.subtotal / companyRevenue.value * 100;
      }
    }
    return { ...document, pageCount: pdf.numPages, tables, notes,
      status: tables.length ? "ok" : "unsupported_layout" };
  } finally { await pdf.loadingTask.destroy(); }
}

export async function fetchBusinessReports(symbol, { fetchImpl = fetch, now = Date.now(), extractPdf = extractBusinessReportPdf } = {}) {
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) return { status: "unsupported", symbol, reports: [] };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000), reports = [];
  let identity;
  try {
    identity = await discoverPeriodicReports(symbol, { fetchImpl, now, signal: controller.signal });
    for (const document of identity.reports) {
      try {
        const bytes = await bounded(await fetchImpl(document.url, { signal: controller.signal, redirect: "manual", headers: { "User-Agent": "Mozilla/5.0", Referer: CATALOG + "/" } }), 8 * 1024 * 1024);
        reports.push(await extractPdf(bytes, document, identity, { signal: controller.signal }));
      } catch { reports.push({ ...document, status: "unavailable", tables: [], notes: [] }); }
    }
    return { status: reports.some((r) => r.status === "ok") ? "ok" : identity.reports.length ? "unavailable" : "empty",
      symbol, name: identity.name, fetchedAt: new Date(now).toISOString(), reports };
  } catch { return { status: "unavailable", symbol, fetchedAt: new Date(now).toISOString(), reports }; }
  finally { clearTimeout(timer); }
}

const TABLE = `CREATE TABLE IF NOT EXISTS business_report_snapshots (symbol TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, saved_at TEXT NOT NULL, refresh_after INTEGER NOT NULL)`;
export function registerBusinessReports(app, { fetchReports = fetchBusinessReports, now = Date.now } = {}) {
  app.get("/api/my/business-reports", async (c) => {
    c.header("Cache-Control", "no-store");
    const symbol = c.req.query("symbol") || "";
    if (!/^(?:us[A-Za-z0-9.-]{1,16}|(?:sh|sz|bj)\d{6}|hk\d{1,8})$/.test(symbol)) return c.json({ error: "bad symbol" }, 400);
    const at = now(), key = new Request("https://business-reports.internal/v1/" + symbol), hit = await caches.default.match(key);
    if (hit) return c.json(await hit.json());
    let saved = null;
    try { await c.env.DB.prepare(TABLE).run(); saved = await c.env.DB.prepare("SELECT * FROM business_report_snapshots WHERE symbol=?").bind(symbol).first(); } catch { /* Storage failure does not block retrieval. */ }
    const cache = (value, ttl) => caches.default.put(key, Response.json(value, { headers: { "Cache-Control": `public, max-age=${ttl}` } }));
    let previous = null;
    try { previous = saved && JSON.parse(saved.snapshot_json); } catch { saved = null; }
    if (previous?.symbol !== symbol || !Array.isArray(previous?.reports)) { previous = null; saved = null; }
    if (saved && saved.refresh_after > at) {
      c.executionCtx.waitUntil(cache(previous, Math.max(1, Math.floor((saved.refresh_after - at) / 1000)))); return c.json(previous);
    }
    const fresh = await fetchReports(symbol), success = fresh.status === "ok";
    if (!success && saved) {
      const value = { ...previous, storage: { status: "refresh_failed", savedAt: saved.saved_at } };
      c.executionCtx.waitUntil(cache(value, 600)); return c.json(value);
    }
    if (success) {
      const ttl = fresh.reports.length === 2 && fresh.reports.every((r) => r.status === "ok") ? 21600 : 600;
      let retained = false;
      const reports = ["annual", "interim"].map((kind) => {
        const current = fresh.reports.find((r) => r.kind === kind), old = previous?.reports.find((r) => r.kind === kind && r.status === "ok");
        if (old && (!current || current.status !== "ok" || old.year > current.year
          || (old.year === current.year && (old.publishedTime || 0) > (current.publishedTime || 0)))) { retained = true; return old; }
        return current;
      }).filter(Boolean);
      const value = { ...fresh, reports, storage: { status: retained ? "refresh_failed" : "saved", savedAt: new Date(at).toISOString() } };
      const cacheTtl = retained ? 600 : ttl;
      try { await c.env.DB.prepare("INSERT INTO business_report_snapshots(symbol,snapshot_json,saved_at,refresh_after) VALUES(?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET snapshot_json=excluded.snapshot_json,saved_at=excluded.saved_at,refresh_after=excluded.refresh_after")
        .bind(symbol, JSON.stringify(value), value.storage.savedAt, at + cacheTtl * 1000).run(); } catch { /* Edge cache remains usable. */ }
      c.executionCtx.waitUntil(cache(value, cacheTtl)); return c.json(value);
    }
    return c.json(fresh);
  });
}
