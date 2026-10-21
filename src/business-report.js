// Original A-share periodic reports, discovered by security code rather than issuer adapters.
const CATALOG = "https://www.cninfo.com.cn";
const CDN = "https://static.cninfo.com.cn";
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const compact = (s) => String(s || "").replace(/\s+/g, "");
// Fullwidth digits/punctuation appear in some filings; percentages are kept as their numeric value.
const halfwidth = (s) => compact(s).replace(/[\uff10-\uff19\uff0c\uff0e\uff05\uff0d]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const numeric = (s) => { const v = halfwidth(s).replace(/%$/, ""); return /^-?[\d,]+(?:\.\d+)?$/.test(v) ? Number(v.replace(/,/g, "")) : null; };
export const REPORT_FAILURES = ["download_failed", "too_large", "not_pdf", "identity_mismatch", "page_limit", "timeout", "parse_failed"];
export function reportFailure(error) {
  const message = String(error?.message || "");
  if (error?.name === "AbortError" || error?.name === "TimeoutError" || /abort/i.test(message)) return "timeout";
  return { report_request_failed: "download_failed", report_too_large: "too_large", report_not_pdf: "not_pdf",
    report_identity_mismatch: "identity_mismatch", report_page_limit: "page_limit", report_text_limit: "page_limit" }[message] || "parse_failed";
}

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
  const company = identity.keyBoardList?.find((item) => item.code === code && item.plate === expectedPlate && /^[A-Za-z0-9]{1,32}$/.test(item.orgId));
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
    const text = item.str.trim(), width = Number(item.width) || 0;
    // pdf.js sometimes emits adjacent cells as one run ("59,920.77 59,806.65"); split so each amount keeps its own column.
    if (/^-?[\d,.]+%?(?:\s+-?[\d,.]+%?)+$/.test(text)) {
      const raw = item.str, perChar = width / Math.max(1, raw.length);
      for (const m of raw.matchAll(/\S+/g)) line.items.push({ text: m[0], x: x + m.index * perChar, width: m[0].length * perChar });
    } else line.items.push({ text, x, width });
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
  // A-share reports are in RMB unless the unit line names another currency; never guess a foreign currency.
  const t = compact(text), m = t.match(/单位[:：](人民币)?(亿元|万元|千元|百万元|元)(?:币种[:：](人民币|美元|港元|欧元|日元))?/);
  if (!m || (m[3] && m[3] !== "人民币") || /单位[:：](?:美元|港元|港币|欧元|日元)|币种[:：](?:美元|港元|欧元|日元)/.test(t)) return null;
  return { currency: "CNY", unit: m[2], multiplier: { 元: 1, 千元: 1000, 万元: 10000, 百万元: 1e6, 亿元: 1e8 }[m[2]] };
}
// Nearest unit line above (or on) a table start; a later table's unit must not leak upwards.
function unitNear(lines, from, to) {
  for (let i = Math.min(to, lines.length - 1); i >= Math.max(0, from); i--) {
    if (/单位[:：]/.test(compact(lines[i].text))) return unitOf(lines.slice(i, i + 2).map((l) => l.text).join(" "));
  }
  return null;
}

function fourColumns(lines) {
  return lines.map((line) => line.items.filter((i) => /^(营业)?(收入|成本)$/.test(compact(i.text))))
    .find((cells) => cells.length === 4 && cells.map((i) => compact(i.text).replace(/^营业/, "")).join() === "收入,成本,收入,成本")
    ?.map((i) => i.x + i.width / 2);
}
// Current-period-only layouts: either a single 营业收入/营业成本 pair, or several segment pairs whose last pair sits under 合计.
function pairColumns(lines) {
  const at = lines.findIndex((line) => {
    const cells = line.items.filter((i) => /^营业(收入|成本)$/.test(compact(i.text)));
    return cells.length >= 2 && cells.length % 2 === 0 && cells.length === line.items.length
      && cells.every((c, i) => compact(c.text) === (i % 2 ? "营业成本" : "营业收入"));
  });
  if (at < 0) return null;
  const cells = lines[at].items, pair = cells.slice(-2).map((i) => i.x + i.width / 2);
  if (cells.length > 2) {
    const total = lines.slice(Math.max(0, at - 4), at).flatMap((l) => l.items).find((i) => compact(i.text) === "合计");
    if (!total || Math.abs(total.x + total.width / 2 - (pair[0] + pair[1]) / 2) > (pair[1] - pair[0])) return null;
  }
  return { columns: pair, labelLimit: Math.min(...cells.map((i) => i.x)) - 2 };
}

const MAIN_END = /^(?:主营业务分(?:地区|销售模式|行业|业务)情况|主营业务收入按地区分析|分地区|分销售模式|分行业|分业务|按地区|按销售模式|公司主营业务数据统计口径.*)$/;
// Column positions come from the numbers themselves; the header wording and line wrapping vary by exchange and issuer.
function numericClusters(lines, labelLimit) {
  const centers = lines.flatMap((line) => {
    const cells = line.items.filter((i) => numeric(i.text) !== null && i.x > labelLimit);
    return cells.length >= 3 ? cells.map((i) => i.x + i.width / 2) : [];
  }).sort((a, b) => a - b);
  const clusters = [];
  for (const x of centers) { const last = clusters.at(-1); if (last && x - last.max < 18) { last.max = x; last.sum += x; last.n++; } else clusters.push({ max: x, sum: x, n: 1 }); }
  return clusters.map((c) => c.sum / c.n);
}

export function extractMainBusinessTable(page) {
  const lines = reportLines(page.items);
  let start = lines.findIndex((l) => /^主营业务分产品情况$/.test(compact(l.text))), label = "主营业务分产品（经营分析）", top = start;
  if (start < 0) {
    // Shenzhen layout: one table with 分行业/分产品/分地区 subsections, listing items above 10% of revenue or profit.
    top = lines.findIndex((l) => /占公司营业收入或营业利润10%以上的/.test(compact(l.text)));
    if (top >= 0) start = lines.findIndex((l, i) => i > top && i < top + 40 && /^分产品$/.test(compact(l.text)));
    label = "主营业务分产品（占收入或利润 10% 以上的披露项）";
  }
  if (start < 0) return null;
  const unit = unitNear(lines, Math.max(0, top - 30), start);
  const end = lines.findIndex((l, i) => i > start && MAIN_END.test(compact(l.text)));
  if (!unit || end < 0) return null;
  const block = lines.slice(start + 1, end);
  const firstNumber = Math.min(...block.flatMap((l) => l.items.filter((i) => numeric(i.text) !== null).map((i) => i.x)));
  const columns = numericClusters(block, Number.isFinite(firstNumber) ? firstNumber - 1 : Infinity);
  if (columns.length < 3 || columns.length > 7) return null;
  const parsed = readRows(block, columns.slice(0, 4));
  const base = Math.min(...parsed.map((r) => r.labelX));
  // "其中" rows and indented rows are components of the row above; summing them would double count.
  const raw = parsed.filter((r) => !/^其中[:：]?/.test(r.name) && !(r.labelX > base + 4));
  const tolerance = 0.06;
  if (!raw.length || raw.length > 30 || raw.some((r) => !r.name || r.values[0] < 0 || r.values[1] === null
    || r.values[2] === null || (r.values[0] > 0 && Math.abs((1 - r.values[1] / r.values[0]) * 100 - r.values[2]) > tolerance))) return null;
  const subtotal = raw.reduce((sum, r) => sum + r.values[0] * unit.multiplier, 0);
  if (!(subtotal > 0)) return null;
  return { scope: "management", basis: "listed_main_business_sum", label, currency: unit.currency,
    originalUnit: unit.unit, pdfPage: page.page, subtotal, companyRevenue: null, coveragePercent: null,
    excerpt: lines.slice(start, end).map((l) => l.text).join("\n").slice(0, 6500),
    rows: raw.map(({ name, values: [rev, cost, margin, growth = null] }) => ({ name: name.slice(0, 100), revenue: rev * unit.multiplier,
      cost: cost * unit.multiplier, previousRevenue: null, sharePercent: rev * unit.multiplier / subtotal * 100,
      growthPercent: growth, grossMarginPercent: margin, derived: ["sharePercent"] })) };
}

// "营业收入合计" in the Shenzhen revenue-composition table is the company total used as a share denominator.
export function extractRevenueTotal(page) {
  const lines = reportLines(page.items), at = lines.findIndex((l) => compact(l.items[0]?.text) === "营业收入合计" && l.items.slice(1).some((i) => numeric(i.text) !== null));
  if (at < 0 || !lines.slice(Math.max(0, at - 12), at).some((l) => /营业收入构成|营业收入整体情况/.test(compact(l.text)))) return null;
  const unit = unitNear(lines, Math.max(0, at - 12), at), value = numeric(lines[at].items.find((i, n) => n && numeric(i.text) !== null).text);
  return unit && value > 0 ? { value: value * unit.multiplier, pdfPage: page.page, currency: unit.currency } : null;
}

function readRows(lines, columns, labelLimit) {
  const firstBoundary = labelLimit ?? columns[0] - (columns[1] - columns[0]) / 2;
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
    const labels = lines.filter((l) => l.y <= top && l.y > bottom).flatMap((l) => l.items.filter((i) => i.x + i.width / 2 < firstBoundary));
    return { name: labels.map((i) => i.text).join("").replace(/\s+/g, ""), labelX: Math.min(...labels.map((i) => i.x)), values: row.values };
  });
}

const PRODUCT_GROUP = /^(?:商品类型|产品类型|业务类型|商品或服务类型|按产品分类|按商品类型分类|按产品类型分类|按业务类型分类|按商品或服务类型分类)$/;
const NEXT_GROUP = /^(?:小计|合计|按.{1,14}分类|(?:市场或客户|合同|客户|服务|销售渠道|经营地区)类型|按.{0,10}(?:地区|渠道|时间|期限|客户)|其他分类)$/;
export function extractRevenueTable(page, { scope, companyRevenue = null } = {}) {
  if (scope !== "consolidated") return null;
  const lines = reportLines(page.items), start = lines.findIndex((l) => /营业收入[、和及]营业成本的分解信息/.test(compact(l.text)));
  if (start < 0) return null;
  const tableLines = lines.slice(start), unit = unitNear(tableLines, 0, 8);
  const four = fourColumns(tableLines.slice(0, 12)), pair = four ? null : pairColumns(tableLines.slice(0, 12));
  const columns = four || pair?.columns;
  const product = tableLines.findIndex((l) => PRODUCT_GROUP.test(compact(l.items[0]?.text)));
  if (!unit || !columns || product < 0) return null;
  const end = tableLines.findIndex((l, i) => i > product && NEXT_GROUP.test(compact(l.items[0]?.text)));
  if (end < 0) return null;
  const rawRows = readRows(tableLines.slice(product, end + 1), columns, pair?.labelLimit);
  let subtotal = rawRows.find((r) => /^(小计|合计)$/.test(r.name));
  // A group heading that carries amounts is that group's subtotal; otherwise the table's final 合计 closes a single-pair table.
  const heading = rawRows.find((r) => PRODUCT_GROUP.test(r.name));
  if (!subtotal && heading) subtotal = heading;
  if (!subtotal) {
    const stop = tableLines.findIndex((l, i) => i > end && /^(?:[（(]\d+[)）]|\d+[、.．]|[一二三四五六七八九十]+[、.．])/.test(compact(l.text)));
    subtotal = readRows(tableLines.slice(end, stop < 0 ? end + 40 : stop), columns, pair?.labelLimit).find((r) => r.name === "合计");
  }
  const rows = rawRows.filter((r) => r.name && !/^(小计|合计)$/.test(r.name) && !PRODUCT_GROUP.test(r.name) && !/^其中[:：]?$/.test(r.name))
    .map((r) => ({ ...r, name: r.name.replace(/^其中[:：]/, "") }));
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
    rows: rows.map(({ name, values: [rev, cost, previousRev = null] }) => {
      const revenue = rev * unit.multiplier, previousRevenue = previousRev === null ? null : previousRev * unit.multiplier;
      return { name: name.slice(0, 100), revenue, cost: cost * unit.multiplier, previousRevenue,
        sharePercent: revenue / total * 100,
        growthPercent: previousRevenue > 0 ? (revenue / previousRevenue - 1) * 100 : null,
        grossMarginPercent: revenue > 0 ? (1 - cost * unit.multiplier / revenue) * 100 : null,
        derived: ["sharePercent", "growthPercent", "grossMarginPercent"] };
    }) };
}

// Traditional-script covers (e.g. dual-listed banks) must still match the catalog's simplified short name.
const SIMPLIFIED = { 銀: "银", 國: "国", 華: "华", 業: "业", 電: "电", 東: "东", 證: "证", 發: "发", 開: "开", 達: "达", 齊: "齐", 長: "长", 實: "实", 興: "兴", 機: "机", 車: "车", 鐵: "铁", 廣: "广", 豐: "丰", 寶: "宝", 礦: "矿", 藥: "药", 險: "险", 億: "亿", 報: "报", 碼: "码", 團: "团", 動: "动", 際: "际", 環: "环", 灣: "湾", 創: "创", 務: "务", 產: "产", 設: "设", 衛: "卫", 網: "网", 訊: "讯", 聯: "联", 貿: "贸", 運: "运", 遠: "远", 陽: "阳", 雲: "云", 順: "顺", 風: "风", 飛: "飞", 馬: "马", 龍: "龙" };
const simplify = (s) => s.replace(/[\u3400-\u9fff]/g, (c) => SIMPLIFIED[c] || c);
export function reportIdentityMatches(opening, identity, document) {
  const flat = simplify(halfwidth(opening));
  // Some issuers title the annual report "2025年度报告"; "半年度" can never satisfy the annual pattern.
  const period = new RegExp(`${document.year}年${document.kind === "annual" ? "年?度" : "半年度"}报告`);
  const name = simplify(compact(identity.name)).replace(/^\*?ST|^XD|^XR|^DR/i, "");
  const issuer = new RegExp(`(?:公司|股票|证券|A股股票)代码[:：]?${identity.code}(?!\\d)`).test(flat) || (name.length >= 2 && flat.includes(name));
  return issuer && period.test(flat);
}

export async function extractBusinessReportPdf(bytes, document, identity, { signal } = {}) {
  if (bytes.length > MAX_PDF_BYTES) throw new Error("report_too_large");
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("report_not_pdf");
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false, disableFontFace: true,
    useWorkerFetch: false, cMapUrl: undefined, standardFontDataUrl: undefined });
  try {
    if (pdf.numPages > 400) throw new Error("report_page_limit");
    let scope = "unknown", companyRevenue = null, managementRevenue = null, incomeTable = null, length = 0, opening = "";
    const tables = [], notes = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      signal?.throwIfAborted();
      const p = await pdf.getPage(page), content = await p.getTextContent();
      const text = content.items.map((i) => typeof i.str === "string" ? i.str + (i.hasEOL ? "\n" : " ") : "").join("");
      length += text.length; if (length > 1500000) throw new Error("report_text_limit");
      const flat = compact(text);
      // Shenzhen covers often omit the security code and carry only the issuer name; check the first pages together.
      if (page <= 5) opening += flat;
      if ((page === Math.min(5, pdf.numPages)) && !reportIdentityMatches(opening, identity, document)) throw new Error("report_identity_mismatch");
      if (/^[一二三四五六七八九十百0-9]+[、.．]\s*合并[^\n]{0,20}报表[^\n]{0,20}注释\s*$/m.test(text)) scope = "consolidated";
      if (/^[一二三四五六七八九十百0-9]+[、.．]\s*母公司[^\n]{0,20}报表[^\n]{0,20}注释\s*$/m.test(text)) { scope = "parent"; incomeTable = null; }
      const lines = reportLines(content.items);
      if (scope === "unknown") {
        managementRevenue ||= extractRevenueTotal({ page, items: content.items });
        if (tables.length < 3) { const main = extractMainBusinessTable({ page, items: content.items }); if (main) tables.push(main); }
      }
      if (scope === "consolidated") {
        const income = lines.findIndex((l) => /营业收入(?:和|及|、)营业成本(?:情况)?$/.test(compact(l.text).replace(/^(?:[（(]?\d+[)）.．]|\d+[、.．])\.?/, "")));
        if (income >= 0) {
          const block = lines.slice(income), unit = unitNear(block, 0, 8), columns = fourColumns(block.slice(0, 12));
          incomeTable = unit && columns ? { unit, columns } : null;
        }
        if (incomeTable) {
          const end = lines.findIndex((l) => /营业收入[、和及]营业成本的分解信息/.test(compact(l.text)));
          const incomeLines = lines.slice(income >= 0 ? income : 0, end < 0 ? undefined : end);
          const total = readRows(incomeLines, incomeTable.columns).find((r) => r.name === "合计");
          if (total && total.values[0] > 0 && !companyRevenue) companyRevenue = { value: total.values[0] * incomeTable.unit.multiplier, pdfPage: page, currency: incomeTable.unit.currency };
          if (end >= 0 || total) incomeTable = null;
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
    const denominator = companyRevenue || managementRevenue;
    for (const table of tables) {
      if (!table.companyRevenue && denominator && denominator.value >= table.subtotal * 0.999999) {
        table.companyRevenue = denominator; table.coveragePercent = table.subtotal / denominator.value * 100;
      }
    }
    return { ...document, pageCount: pdf.numPages, tables, notes,
      status: tables.length ? "ok" : "unsupported_layout", ...(tables.length ? {} : { reason: "no_table" }) };
  } finally { await pdf.loadingTask.destroy(); }
}

export async function fetchBusinessReports(symbol, { fetchImpl = fetch, now = Date.now(), extractPdf = extractBusinessReportPdf, timeoutMs = 35000 } = {}) {
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) return { status: "unsupported", symbol, reports: [] };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs), reports = [];
  let identity;
  try {
    identity = await discoverPeriodicReports(symbol, { fetchImpl, now, signal: controller.signal });
    for (const document of identity.reports) {
      try {
        const response = await fetchImpl(document.url, { signal: controller.signal, redirect: "manual", headers: { "User-Agent": "Mozilla/5.0", Referer: CATALOG + "/" } })
          .catch((error) => { throw controller.signal.aborted ? error : new Error("report_request_failed"); });
        const bytes = await bounded(response, MAX_PDF_BYTES);
        const report = await extractPdf(bytes, document, identity, { signal: controller.signal });
        if (report.status !== "ok") console.warn("business_report_no_table", symbol, document.period, `pages=${report.pageCount}`);
        reports.push(report);
      } catch (error) {
        const reason = reportFailure(error);
        // One line per failed report: enough to tell size, download, identity and parser failures apart in wrangler logs.
        console.warn("business_report_failed", symbol, document.period, reason, String(error?.message || error).slice(0, 120));
        reports.push({ ...document, status: "unavailable", reason, tables: [], notes: [] });
      }
    }
    return { status: reports.some((r) => r.status === "ok") ? "ok" : identity.reports.length ? "unavailable" : "empty",
      symbol, name: identity.name, fetchedAt: new Date(now).toISOString(), reports };
  } catch (error) {
    console.warn("business_report_discovery_failed", symbol, String(error?.message || error).slice(0, 120));
    return { status: "unavailable", symbol, fetchedAt: new Date(now).toISOString(), reports };
  } finally { clearTimeout(timer); }
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
