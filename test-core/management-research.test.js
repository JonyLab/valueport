import { describe, it, expect, vi } from "vitest";
import { earningsNewsScore, extractNewsPassages, fetchManagementResearch, relatedNews, reportedPeriod } from "../src/management-research.js";
import { cleanManagementResearch, managementReferences, managementPrompt } from "../public/shared/valuation/management-research.js";
import { cleanFlowState } from "../public/shared/valuation/thesis-guide-ui.js";
import { buildSystemPrompt, buildThesisGuidePrompt, guideReferences, validateChat } from "../src/ai.js";
import { validateItem } from "../src/items.js";

const now = Date.parse("2026-10-21T08:00:00Z");
const credentials = { LONGBRIDGE_APP_KEY: "test", LONGBRIDGE_APP_SECRET: "test", LONGBRIDGE_ACCESS_TOKEN: "test" };
const guidance = "公司预计下一季收入继续增长，管理层重申资本预算维持不变，但投产和产能利用率仍需观察。";
const forecast = "德银分析师在研报中预测明年资本开支增加至840亿美元，这是机构预测，仍需等待公司确认。";
const article = { id: "101", title: "示例公司2026年第三季度财报与法说会", body: guidance + "\n\n" + forecast,
  author: { name: "Example news" }, published_at: String(now / 1000 - 86400), tickers: ["TEST.US"] };
const snapshot = { status: "ok", symbol: "usTEST", fetchedAt: new Date(now).toISOString(), sources: [{
  id: "101", title: article.title, publishedAt: "2026-10-20T08:00:00Z", reportPeriod: "2026 Q3", publisher: "Example news",
  passages: [{ kind: "reported_guidance", excerpt: guidance }, { kind: "third_party", excerpt: forecast }],
}] };
const list = [{ ...article, url: "https://longbridge.com/news/101", description: guidance }];

describe("management news attribution and retrieval", () => {
  it("preserves original passages and separates explicit third-party forecasts from management attribution", () => {
    const passages = extractNewsPassages(article.body);
    expect(passages).toContainEqual({ kind: "reported_guidance", excerpt: guidance });
    expect(passages).toContainEqual({ kind: "third_party", excerpt: forecast });
    expect(extractNewsPassages("德银研报称，CEO表示公司将扩产，分析师预测利润率也会继续改善。" )[0].kind).toBe("mixed");
    expect(extractNewsPassages(guidance, true)[0].kind).toBe("mixed");
    expect(extractNewsPassages("从管理层给出的指引来看，收入增长确定性很高，媒体预计产品价格还会继续上涨。" )[0].kind).toBe("mixed");
    expect(reportedPeriod("2026 年第 3 季财报，公司预计2027年增长")).toBe("2026 Q3");
    expect(reportedPeriod("FY2026 Q2 results")).toBe("2026 Q2");
    expect(reportedPeriod("2026年全年资本预算600亿美元")).toBe("");
    expect(reportedPeriod("公司预计2027 Q1收入增长")).toBe("");
    expect(earningsNewsScore({ title: "台股开盘，法人关注科技财报" })).toBeLessThan(earningsNewsScore(article));
  });

  it("uses only bounded numeric Longbridge related links", () => {
    const links = relatedNews("[示例公司 Q3 财报](https://longbridge.com/zh-CN/news/202.md)\n[bad](https://evil.test/news/99)\n[bad](https://longbridge.com/topics/88.md)\n[bad](https://longbridge.com/news/../../private)");
    expect(links).toEqual([{ id: "202", title: "示例公司 Q3 财报", description: "" }]);
  });

  it("retrieves signed source detail, checks issuer and age, and does not promote related-page text into evidence", async () => {
    const calls = [], get = vi.fn(async (path, query) => {
      calls.push([path, query]);
      if (path.endsWith("/TEST.US/news")) return { code: 0, data: { items: list } };
      if (path === "/v1/search/news") return { code: 0, data: { news_list: [] } };
      if (path.endsWith("/101")) return { code: 0, data: { item: article } };
      // An unrelated issuer surfaced by related content must not become a company source.
      if (path.endsWith("/202")) return { code: 0, data: { item: { ...article, id: "202", title: "Other issuer earnings", tickers: ["OTHER.US"] } } };
      throw new Error("unexpected path");
    });
    const out = await fetchManagementResearch(credentials, "usTEST", "示例公司", { now, get, fetchImpl: async () => new Response("[Other issuer earnings](https://longbridge.com/news/202.md)\nInvented guidance from public discovery page") });
    expect(out.status).toBe("ok"); expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ id: "101", reportPeriod: "2026 Q3", url: "https://longbridge.com/news/101" });
    expect(JSON.stringify(out)).not.toContain("Invented guidance");
    expect(calls).toContainEqual(["/v1/search/news", "k=" + encodeURIComponent("示例公司")]);
    expect(out.coverage).toBe("recent_news_and_related");
  });

  it("degrades for missing credentials, auth errors, empty lists, stale and unavailable details", async () => {
    const unused = vi.fn();
    expect((await fetchManagementResearch({}, "usTEST", "", { get: unused })).status).toBe("not_configured"); expect(unused).not.toHaveBeenCalled();
    expect((await fetchManagementResearch(credentials, "usTEST", "", { get: async () => ({ code: 401003 }) })).status).toBe("unavailable");
    expect((await fetchManagementResearch(credentials, "usTEST", "", { get: async () => ({ code: 0, data: { items: [] } }) })).status).toBe("empty");
    for (const stale of [true, false]) {
      const get = async (path) => path.endsWith("/TEST.US/news") ? { code: 0, data: { items: list } }
        : stale ? { code: 0, data: { item: { ...article, published_at: "1700000000" } } } : { code: 403208 };
      const result = await fetchManagementResearch(credentials, "usTEST", "", { now, get, fetchImpl: async () => new Response("") });
      expect(result.status).toBe(stale ? "empty" : "unavailable"); expect(result.sources).toEqual([]);
    }
  });

  it("limits discovery response bodies and never follows its redirects", async () => {
    const get = async (path) => path.endsWith("/TEST.US/news") ? { code: 0, data: { items: list } } : { code: 0, data: { item: article } };
    for (const response of [new Response("x".repeat(256001)), new Response("", { status: 302, headers: { location: "https://evil.test" } })]) {
      const fetcher = vi.fn(async (_, options) => { expect(options.redirect).toBe("manual"); return response; });
      expect((await fetchManagementResearch(credentials, "usTEST", "", { now, get, fetchImpl: fetcher })).sources).toHaveLength(1);
    }
  });
});

describe("news evidence in valuation", () => {
  it("sanitizes and bounds stored snapshots, reconstructs trusted links, and strips unknown fields", () => {
    const clean = cleanManagementResearch({ ...snapshot, secret: "DROP", sources: [{ ...snapshot.sources[0], url: "javascript:alert(1)", verified: true,
      passages: [{ kind: "__proto__", excerpt: "<script>text</script>" }, { kind: "third_party", excerpt: "x".repeat(900) }] }] });
    expect(clean.sources[0].url).toBe("https://longbridge.com/news/101");
    expect(clean.sources[0].passages[0]).toEqual({ kind: "context", excerpt: "text" });
    expect(clean.sources[0].passages[1].excerpt).toHaveLength(650);
    expect(JSON.stringify(clean)).not.toMatch(/DROP|javascript|verified/);
    expect(cleanManagementResearch(clean)).toEqual(clean);
    expect(managementReferences(clean)[0]).toContain("未核实");
  });

  it("adds distinct unverified references to guide prompts while leaving verified facts intact", () => {
    const context = { stock: { name: "示例公司", code: "TEST" }, business: ["Company business"], verified: ["Reported revenue"], managementResearch: snapshot };
    const refs = guideReferences(context);
    expect(refs.slice(0, 2)).toEqual(["Company business", "Reported revenue"]);
    expect(refs[2]).toContain("新闻资料 M1"); expect(refs[3]).toContain("第三方判断");
    expect(context.verified).toEqual(["Reported revenue"]);
    const prompt = buildThesisGuidePrompt({ context, scenario: "both", turns: [], thesis: {} }, "zh");
    expect(prompt).toContain("分类只是初筛"); expect(prompt).toContain("季度/年度预测不能直接充当多年复合增速");
    expect(managementPrompt(snapshot)).toContain("来源 M1/M2/M3");
    expect(guideReferences({ business: Array(20).fill("business"), verified: Array(20).fill("fact"), managementResearch: snapshot })).toHaveLength(24);
    const fields = [{ k: "growth", col: "dual" }];
    expect(buildSystemPrompt({ ...context, fields }, "zh")).toContain("840亿美元");
    expect(validateChat({ context: { ...context, fields }, messages: [{ role: "user", content: "Suggest inputs" }] })).toBeNull();
  });

  it("preserves the bounded source snapshot through draft restoration and valuation saving", () => {
    const flow = cleanFlowState({ stage: "story", turns: [], history: [], managementResearch: snapshot });
    expect(flow.managementResearch).toEqual(cleanManagementResearch(snapshot));
    const item = validateItem({ ticker: "TEST", symbol: "usTEST", mos: 30, ext: 50, valuations: [{ id: "one", method: "fcff", inputs: {}, low: 10, high: 20, managementResearch: snapshot }] });
    expect(item.ok).toBe(true);
    expect(item.value.valuations[0].managementResearch).toEqual(flow.managementResearch);
    expect(item.value.valuations[0].inputs).toEqual({});
  });
});
