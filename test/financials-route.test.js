import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { SELF, fetchMock } from "cloudflare:test";
import FX from "../test-core/fixtures/em-financials.json";

// 测试环境没有长桥凭据 → /api/financials 应走东财 F10 兜底(出站请求全部由 fetchMock 拦截,录制数据)
beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const EMPTY = { result: null, success: false, code: 9201, message: "返回数据为空" };
function mockEastmoney(key, extra = {}) {
  const rec = { ...FX[key], ...extra };
  const reports = ["RPT_F10_FINANCE_GINCOME", "RPT_F10_FINANCE_GBALANCE", "RPT_F10_FINANCE_GCASHFLOW", "RPT_F10_FINANCE_MAINFINADATA", "RPT_SHAREBONUS_DET"];
  for (const name of reports) {
    fetchMock.get("https://datacenter.eastmoney.com")
      .intercept({ path: (p) => p.includes(`reportName=${name}&`) })
      .reply(200, rec[name] || EMPTY);
  }
}

describe("/api/financials eastmoney fallback", () => {
  it("serves A-share annual statements from eastmoney when Longbridge has no credentials", async () => {
    mockEastmoney("sh600519|af");
    const r = await SELF.fetch("https://x/api/financials?symbol=sh600519&period=annual&v=4");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.financialsSource).toBe("eastmoney");
    expect(j.valuationRefs).toBe(null);
    const rev = j.financials.IS.find((a) => a.field === "OperatingRevenue");
    expect(rev.values[0].period).toBe("FY 2025");
    expect(rev.values[0].value).toBeCloseTo(168838102514.79, 0);
    expect(j.financials.CF.find((a) => a.field === "NetFreeCashFlow").values[0].value).toBeGreaterThan(0);
    expect(j.latest).toMatchObject({ year: 2025 });
    expect(j.latest.revenue).toBeCloseTo(168838102514.79, 0);
    // 兜底数据缓存 1h(长桥恢复后尽快切回)
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
  });
  it("serves single-quarter statements for period=quarter", async () => {
    for (const name of ["RPT_F10_FINANCE_GINCOME", "RPT_F10_FINANCE_GBALANCE", "RPT_F10_FINANCE_GCASHFLOW"]) {
      fetchMock.get("https://datacenter.eastmoney.com")
        .intercept({ path: (p) => p.includes(`reportName=${name}&`) })
        .reply(200, FX["sh600519|qf"][name]);
    }
    const j = await (await SELF.fetch("https://x/api/financials?symbol=sh600519&period=quarter&v=4")).json();
    expect(j.financialsSource).toBe("eastmoney");
    expect(j.financials.IS.find((a) => a.field === "OperatingRevenue").values[0].period).toBe("Q2 2026");
  });
  it("returns financials:null (no-store) when eastmoney also has nothing", async () => {
    mockEastmoney("sh600519|af", { RPT_F10_FINANCE_GINCOME: EMPTY, RPT_F10_FINANCE_GBALANCE: EMPTY, RPT_F10_FINANCE_GCASHFLOW: EMPTY });
    const r = await SELF.fetch("https://x/api/financials?symbol=sh600519&period=annual&v=4");
    const j = await r.json();
    expect(j.financials).toBe(null);
    expect(j.financialsSource).toBe(null);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
