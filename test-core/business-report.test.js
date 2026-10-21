import { describe, it, expect, vi } from "vitest";
import { selectPeriodicReports, discoverPeriodicReports, extractRevenueTable, extractMainBusinessTable, fetchBusinessReports } from "../src/business-report.js";
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
