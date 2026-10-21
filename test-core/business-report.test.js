import { describe, it, expect, vi } from "vitest";
import { selectPeriodicReports, discoverPeriodicReports, extractRevenueTable, extractMainBusinessTable, fetchBusinessReports,
  extractRevenueTotal, reportIdentityMatches, reportFailure, extractBusinessReportPdf } from "../src/business-report.js";
import { cleanBusinessReports, businessReportFacts } from "../public/shared/valuation/business-report.js";
import { cleanFlowState } from "../public/shared/valuation/thesis-guide-ui.js";

const now = Date.parse("2026-10-21T08:00:00Z"), published = Date.parse("2026-08-28T16:00:00Z");
const announcement = { secCode: "600001", announcementTitle: "示例公司2026年半年度报告", announcementTime: published, adjunctUrl: "finalpage/2026-08-29/123.PDF" };
function notePage({ unit = "元", mismatch = false, missingCost = false } = {}) {
  const items = [], add = (str, x, y, width = 40) => items.push({ str, transform: [1, 0, 0, 10, x, y], width });
  add("(2) 营业收入、营业成本的分解信息", 40, 760);
  add(`单位：${unit} 币种：人民币`, 40, 740);
  for (const [i, label] of ["营业收入", "营业成本", "营业收入", "营业成本"].entries()) add(label, 170 + i * 100, 700);
  add("商品类型", 40, 680);
  for (const [index, [name, values]] of [["业务甲", [100, 60, 80, 50]], ["业务乙", [20, missingCost ? null : 5, null, 2]], ["小计", [mismatch ? 130 : 120, 65, 80, 52]]].entries()) {
    const y = 660 - index * 20; add(name, 40, y);
    values.forEach((v, i) => { if (v !== null) add(String(v), 170 + i * 100, y); });
  }
  add("按经营地区分类", 40, 600);
  return { page: 2, items };
}
const document = { kind: "interim", year: 2026, title: "示例公司2026年半年度报告", url: "https://static.cninfo.com.cn/finalpage/2026-08-29/123.PDF", publishedAt: "2026-08-29", pageCount: 10 };
const table = () => extractRevenueTable(notePage(), { scope: "consolidated", companyRevenue: { value: 200, pdfPage: 1, currency: "CNY" } });
const snapshot = () => ({ status: "ok", symbol: "sh600001", reports: [{ ...document, status: "ok", tables: [table()], notes: [{ pdfPage: 3, excerpt: "业务乙采用净额法核算，比较毛利率前须核对口径。" }] }] });

describe("original report discovery", () => {
  it("selects full reports, latest corrections and both periods by exact security identity", () => {
    const annual = { ...announcement, announcementTitle: "示例公司2025年年度报告", announcementTime: published - 100000 };
    const corrected = { ...annual, announcementTitle: "示例公司2025年年度报告（更正版）", adjunctUrl: "finalpage/2026-08-29/124.PDF", announcementTime: published - 1 };
    const rejected = [
      { ...announcement, announcementTitle: "示例公司2026年半年度报告摘要" },
      { ...announcement, announcementTitle: "关于2026年半年度报告的说明" },
      { ...announcement, secCode: "600002" }, { ...announcement, adjunctUrl: "https://evil.test/a.pdf" },
      { ...announcement, announcementTime: now + 1 }, { ...annual, announcementTitle: "示例公司2026年年度报告" },
    ];
    const result = selectPeriodicReports([annual, corrected, announcement, ...rejected], "600001", now);
    expect(result).toHaveLength(2); expect(result[0].url).toContain("124.PDF"); expect(result[1].period).toBe("2026 H1");
    expect(result[1].publishedAt).toBe("2026-08-29");
  });
  it("discovers an unregistered issuer's org id, scopes the catalog and never fetches arbitrary URLs", async () => {
    const calls = [], fetchImpl = vi.fn(async (url, options) => {
      calls.push({ url, params: new URLSearchParams(options.body), redirect: options.redirect });
      return Response.json(calls.length === 1 ? { keyBoardList: [{ code: "600002", orgId: "99", plate: "sse" }, { code: "600001", orgId: "12345", plate: "sse", zwjc: "示例公司" }] } : { announcements: [announcement] });
    });
    const result = await discoverPeriodicReports("sh600001", { fetchImpl, now });
    expect(result.name).toBe("示例公司"); expect(result.reports).toHaveLength(1);
    expect(calls[1].params.get("stock")).toBe("600001,12345"); expect(calls.every((c) => c.url.startsWith("https://www.cninfo.com.cn/") && c.redirect === "manual")).toBe(true);
    expect(await discoverPeriodicReports("usTEST", { fetchImpl })).toBeNull(); expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("downloads only discovered PDFs with manual redirects supported by Workers", async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      expect(options.redirect).toBe("manual"); expect(options.headers["User-Agent"]).toBe("Mozilla/5.0");
      if (url.endsWith("detailOfQuery")) return Response.json({ keyBoardList: [{ code: "600001", plate: "sse", orgId: "1", zwjc: "示例公司" }] });
      if (url.endsWith("query")) return Response.json({ announcements: [announcement] });
      expect(url).toBe("https://static.cninfo.com.cn/finalpage/2026-08-29/123.PDF");
      return new Response("%PDF-fixture");
    });
    const extractPdf = vi.fn(async (_bytes, doc) => ({ ...doc, status: "ok", tables: [] }));
    expect((await fetchBusinessReports("sh600001", { fetchImpl, now, extractPdf })).status).toBe("ok");
    expect(extractPdf).toHaveBeenCalledTimes(1);
  });
  it("keeps retrieval failures explicit and reports unsupported markets without network calls", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("offline"); });
    expect((await fetchBusinessReports("usTEST", { fetchImpl })).status).toBe("unsupported"); expect(fetchImpl).not.toHaveBeenCalled();
    expect((await fetchBusinessReports("sh600001", { fetchImpl, now })).status).toBe("unavailable");
  });
});

describe("revenue table boundaries and calculations", () => {
  it("separates consolidated and parent statements, retains units, and calculates only same-table comparatives", () => {
    expect(extractRevenueTable(notePage(), { scope: "parent" })).toBeNull();
    expect(extractRevenueTable(notePage(), { scope: "unknown" })).toBeNull();
    const result = table(); expect(result.pdfPage).toBe(2); expect(result.rows[0]).toMatchObject({ revenue: 100, cost: 60, previousRevenue: 80, growthPercent: 25, grossMarginPercent: 40 });
    expect(result.rows[1].previousRevenue).toBeNull(); expect(result.rows[1].growthPercent).toBeNull();
    expect(result.rows[0].sharePercent).toBeCloseTo(100 / 120 * 100); expect(result.coveragePercent).toBe(60);
    expect(extractRevenueTable(notePage({ unit: "万元" }), { scope: "consolidated" }).subtotal).toBe(1200000);
  });
  it("retains disclosed management-table margins and growth", () => {
    const items = [], add = (str, x, y) => items.push({ str, transform: [1,0,0,10,x,y], width: 20 });
    add("单位：元 币种：人民币", 30, 800); add("主营业务分产品情况", 30, 780);
    ["营业收入", "营业成本", "毛利率比"].forEach((s,i) => add(s, 340+i*65, 760));
    add("分产品", 30, 740);
    ["营业收入", "营业成本", "毛利率"].forEach((s,i) => add(s, 130+i*65, 740));
    add("业务甲", 30, 710); [100,60,40,25,10,5].forEach((s,i) => add(String(s), [130,195,260,340,405,470][i], 710));
    add("主营业务分地区情况", 30, 680);
    const table = extractMainBusinessTable({ page: 21, items });
    expect(table.rows[0]).toMatchObject({ revenue: 100, cost: 60, grossMarginPercent: 40, growthPercent: 25, derived: ["sharePercent"] });
    items.find(i => i.str === "40").str = "99";
    expect(extractMainBusinessTable({ page: 21, items })).toBeNull();
  });
  it("rejects unreconciled totals, missing current costs and unknown currencies instead of guessing", () => {
    expect(extractRevenueTable(notePage({ mismatch: true }), { scope: "consolidated" })).toBeNull();
    expect(extractRevenueTable(notePage({ missingCost: true }), { scope: "consolidated" })).toBeNull();
    const page = notePage(); page.items.find((i) => i.str.startsWith("单位")).str = "单位：元 币种：美元";
    expect(extractRevenueTable(page, { scope: "consolidated" })).toBeNull();
  });
  it("restores page provenance, recomputes derived values and rejects unsafe source links or shifted totals", () => {
    const raw = snapshot(); raw.reports[0].tables[0].rows[0].grossMarginPercent = 999;
    const clean = cleanBusinessReports(raw); expect(clean.reports[0].tables[0].rows[0].grossMarginPercent).toBe(40);
    expect(clean.reports[0].tables[0].rows[0].companySharePercent).toBe(50);
    expect(cleanBusinessReports(clean)).toEqual(clean);
    expect(cleanBusinessReports({ ...raw, reports: [{ ...raw.reports[0], url: "https://evil.test/a.pdf" }] }).status).toBe("unavailable");
    raw.reports[0].tables[0].subtotal = 1; expect(cleanBusinessReports(raw).reports[0].tables).toEqual([]);
  });
  it("supplies bounded source facts and accounting caveats to valuation prompts without annualizing or merging", () => {
    for (const lang of ["zh", "en"]) {
      const facts = businessReportFacts(snapshot(), lang); expect(facts.length).toBeLessThanOrEqual(20); expect(facts.every((s) => s.length <= 300)).toBe(true);
      expect(facts.join("\n")).toContain("https://static.cninfo.com.cn/"); expect(facts.join("\n")).toContain("2026 H1");
      expect(facts.join("\n")).toContain("净额法");
    }
    const facts = businessReportFacts(snapshot()); expect(facts.join("\n")).toContain("不得当成完整业务构成");
    const state = cleanFlowState({ stage: "story", turns: [], businessReports: snapshot() });
    expect(state.businessReports.reports[0].tables[0].pdfPage).toBe(2); expect(cleanFlowState(state)).toEqual(state);
  });
});

// Layouts observed in real 2025/2026 filings (Shanghai, Shenzhen, STAR); coordinates are simplified.
const pageOf = (rows, page = 9) => {
  const items = [];
  for (const [y, cells] of rows) for (const [str, x, width = 40] of cells) items.push({ str, transform: [1, 0, 0, 10, x, y], width });
  return { page, items };
};
describe("real report layouts", () => {
  it("accepts alphanumeric cninfo org ids such as gssh0600519", async () => {
    const fetchImpl = vi.fn(async (url) => Response.json(url.endsWith("detailOfQuery")
      ? { keyBoardList: [{ code: "600001", orgId: "gssh0600001", plate: "sse", zwjc: "示例公司" }] } : { announcements: [announcement] }));
    const result = await discoverPeriodicReports("sh600001", { fetchImpl, now });
    expect(result.reports).toHaveLength(1);
    const bad = vi.fn(async () => Response.json({ keyBoardList: [{ code: "600001", orgId: "../x", plate: "sse" }] }));
    expect((await discoverPeriodicReports("sh600001", { fetchImpl: bad, now })).reports).toEqual([]);
  });
  it("matches report identity on Shenzhen covers without codes, traditional script and 年度报告 titles", () => {
    const id = { code: "000001", name: "平安银行" }, annual = { year: 2025, kind: "annual" }, interim = { year: 2026, kind: "interim" };
    expect(reportIdentityMatches("平安银行股份有限公司2025年年度报告", id, annual)).toBe(true);
    expect(reportIdentityMatches("宜宾五粮液股份有限公司2025年度报告", { code: "000858", name: "五粮液" }, annual)).toBe(true);
    expect(reportIdentityMatches("2026年半年度報告A股股票代碼：600036招商銀行股份有限公司", { code: "600036", name: "招商银行" }, interim)).toBe(true);
    expect(reportIdentityMatches("平安银行股份有限公司2026年半年度报告", id, annual)).toBe(false);
    expect(reportIdentityMatches("其他银行股份有限公司2025年年度报告", id, annual)).toBe(false);
    expect(reportIdentityMatches("公司代码：0000012平安2025年年度报告", { code: "000001", name: "X" }, annual)).toBe(false);
  });
  it("reads the Shenzhen 10% table: percent cells, glued amounts and 其中 components are not double counted", () => {
    const page = pageOf([
      [642, [["（2）占公司营业收入或营业利润10%以上的行业、产品、地区、销售模式的情况", 57, 300]]],
      [589, [["单位：千元", 494]]],
      [555, [["营业收入", 161], ["营业成本", 229], ["毛利率", 302]]],
      [451, [["分产品", 42]]],
      [430, [["智能家居业务", 42], ["299,927,239", 167], ["210,259,540", 235], ["29.90%", 321], ["11.28%", 390], ["11.40%", 458]]],
      [410, [["商业及工业解决方案", 42], ["122,752,958 97,204,037", 167, 108], ["20.81%", 321], ["17.47%", 389], ["18.33%", 458]]],
      [390, [["其中：楼宇科技", 42], ["35,790,825", 171], ["24,846,935", 240], ["30.58%", 321], ["25.72%", 389], ["24.99%", 458]]],
      [369, [["机器人与自动化", 68], ["31,010,933", 171], ["24,403,714", 240], ["21.31%", 321], ["8.05%", 394], ["9.01%", 462]]],
      [308, [["其他", 42], ["33,771,534", 171], ["28,525,951", 240], ["15.53%", 321], ["1.96%", 394], ["-0.60%", 459]]],
      [288, [["分地区", 42]]],
    ], 50);
    const table = extractMainBusinessTable(page);
    expect(table.rows.map((r) => r.name)).toEqual(["智能家居业务", "商业及工业解决方案", "其他"]);
    expect(table.originalUnit).toBe("千元"); expect(table.rows[1]).toMatchObject({ revenue: 122752958000, grossMarginPercent: 20.81, growthPercent: 17.47 });
    expect(table.subtotal).toBe((299927239 + 122752958 + 33771534) * 1000);
  });
  it("reads Shanghai main-business tables with wrapped names and one-decimal margins", () => {
    const page = pageOf([
      [709, [["单位：千元 币种：人民币", 379, 100]]],
      [637, [["主营业务分产品情况", 263, 80]]],
      [616, [["主营业务", 172], ["主营业务", 235], ["毛利率", 294]]], [610, [["分产品", 107]]], [603, [["收入", 182], ["成本", 246], ["（%）", 296]]],
      [582, [["集成电路晶圆", 90, 50], ["增加 2.7 个", 479]]],
      [575, [["62,794,043", 167], ["49,450,277", 230], ["21.3", 304, 15], ["17.9", 375, 15], ["14.1", 446, 15]]],
      [568, [["制造代工", 90, 40], ["百分点", 500]]],
      [547, [["其他主营业务", 90, 50], ["3,786,198", 172, 35], ["2,574,795", 236, 35], ["32.0", 304, 15], ["-2.0", 375, 15], ["-17.0", 441, 20]]],
      [526, [["主营业务分销售模式情况", 253, 90]]],
    ], 26);
    const table = extractMainBusinessTable(page);
    expect(table.rows.map((r) => r.name)).toEqual(["集成电路晶圆制造代工", "其他主营业务"]);
    expect(table.rows[0].revenue).toBe(62794043000);
  });
  it("reads single-pair notes tables that close with the table total, and segment tables under 合计", () => {
    const single = pageOf([
      [382, [["(2).营业收入、营业成本的分解信息", 90, 150]]], [347, [["单位：元", 416], ["币种：人民币", 468]]],
      [333, [["合计", 357]]], [326, [["合同分类", 134]]], [319, [["营业收入", 276], ["营业成本", 418]]],
      [305, [["商品类型", 90]]],
      [291, [["茅台酒", 111], ["146,499,906,480.49", 268, 70], ["9,484,757,825.54", 420, 65]]],
      [276, [["其他系列酒", 111], ["22,274,678,707.16", 274, 65], ["5,321,142,314.05", 420, 65]]],
      [262, [["其他业务", 111], ["63,517,327.14", 295, 50], ["86,377,431.32", 436, 50]]],
      [248, [["按经营地区分类", 90, 60]]],
      [234, [["国内", 111], ["163,979,986,160.04", 268, 70], ["14,489,319,958.16", 415, 70]]],
      [163, [["合计", 145], ["168,838,102,514.79", 268, 70], ["14,892,277,570.91", 415, 70]]],
      [133, [["(3).履约义务的说明", 90, 80]]],
    ], 107);
    const table = extractRevenueTable(single, { scope: "consolidated" });
    expect(table.rows.map((r) => r.name)).toEqual(["茅台酒", "其他系列酒", "其他业务"]);
    expect(table.subtotal).toBeCloseTo(168838102514.79, 1); expect(table.rows[0].previousRevenue).toBeNull(); expect(table.rows[0].growthPercent).toBeNull();
    const segments = pageOf([
      [525, [["营业收入、营业成本的分解信息：", 57, 150]]], [511, [["单位：千元", 494]]],
      [495, [["分部甲", 172], ["分部乙", 316], ["合计", 461]]],
      [477, [["营业收入", 164], ["营业成本", 233], ["营业收入", 296], ["营业成本", 354], ["营业收入", 417], ["营业成本", 486]]],
      [460, [["业务类型", 62], ["100", 166], ["60", 235], ["20", 302], ["10", 360], ["120", 419], ["70", 488]]],
      [443, [["产品甲", 62], ["100", 166], ["60", 235], ["100", 419], ["60", 488]]],
      [426, [["产品乙", 62], ["20", 302], ["10", 360], ["20", 419], ["10", 488]]],
      [408, [["按经营地区分类", 62]]],
    ], 195);
    const grouped = extractRevenueTable(segments, { scope: "consolidated" });
    expect(grouped.rows.map((r) => [r.name, r.revenue, r.cost])).toEqual([["产品甲", 100000, 60000], ["产品乙", 20000, 10000]]);
    expect(grouped.subtotal).toBe(120000);
  });
  it("takes the Shenzhen revenue-composition total as the company denominator", () => {
    const page = pageOf([[328, [["（1）营业收入构成", 86, 80]]], [271, [["单位：千元", 494]]], [220, [["营业收入合计", 62, 50], ["423,701,834", 183], ["100.00%", 272]]]], 24);
    expect(extractRevenueTotal(page)).toEqual({ value: 423701834000, pdfPage: 24, currency: "CNY" });
  });
  it("names each failure so the UI can explain it and logs can tell causes apart", async () => {
    expect(reportFailure(new Error("report_too_large"))).toBe("too_large");
    expect(reportFailure(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
    expect(reportFailure(new Error("weird"))).toBe("parse_failed");
    await expect(extractBusinessReportPdf(new TextEncoder().encode("<html>"), document, { code: "600001", name: "示例公司" })).rejects.toThrow("report_not_pdf");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("detailOfQuery")) return Response.json({ keyBoardList: [{ code: "600001", plate: "sse", orgId: "1", zwjc: "示例公司" }] });
      if (url.endsWith("query")) return Response.json({ announcements: [announcement] });
      return new Response("x", { headers: { "content-length": String(17 * 1024 * 1024) } });
    });
    const result = await fetchBusinessReports("sh600001", { fetchImpl, now });
    expect(result.reports[0]).toMatchObject({ status: "unavailable", reason: "too_large" });
    expect(warn).toHaveBeenCalledWith("business_report_failed", "sh600001", "2026 H1", "too_large", "report_too_large"); warn.mockRestore();
    const clean = cleanBusinessReports(result); expect(clean.reports[0].reason).toBe("too_large"); expect(clean.reports[0].pageCount).toBeNull();
    expect(cleanBusinessReports({ ...result, reports: [{ ...result.reports[0], reason: "<script>" }] }).reports[0].reason).toBeUndefined();
  });
});
