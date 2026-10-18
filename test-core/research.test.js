import { describe, it, expect } from "vitest";
import { parseRating, parseForecastEps, parseProfile, parseSegments, fetchResearch } from "../src/research.js";
import { businessFacts } from "../public/shared/valuation/facts.js";

describe("research parsing", () => {
  it("parses the institution rating snapshot", () => {
    const r = parseRating({ code: 0, data: { evaluate: { buy: 19, over: 6, hold: 13, under: 3, sell: 3, total: 46 }, target: { highest_price: "405.000", lowest_price: "215.000", prev_close: "343.46" }, industry_name: "硬件", industry_rank: 1, industry_total: 33 } });
    expect(r).toEqual({ buy: 19, over: 6, hold: 13, under: 3, sell: 3, total: 46, targetHigh: 405, targetLow: 215, prevClose: 343.46, industry: { name: "硬件", rank: 1, total: 33 } });
    expect(parseRating({ code: 0, data: null })).toBeNull();
    expect(parseRating({ data: { evaluate: { total: 0 } } })).toBeNull();
  });
  it("takes the latest forecast EPS snapshot", () => {
    const f = parseForecastEps({ data: { items: [{ forecast_eps_median: "9.1" }, { forecast_eps_median: "9.235", forecast_eps_mean: "9.287", forecast_eps_lowest: "8.292", forecast_eps_highest: "10.454" }] } });
    expect(f).toEqual({ median: 9.235, mean: 9.287, low: 8.292, high: 10.454 });
    expect(parseForecastEps({ data: { items: [] } })).toBeNull();
  });
  it("fetches both endpoints with the Longbridge symbol and tolerates failures", async () => {
    const env = { LONGBRIDGE_APP_KEY: "k", LONGBRIDGE_APP_SECRET: "s", LONGBRIDGE_ACCESS_TOKEN: "t" };
    const calls = [];
    const get = async (e, path, q) => { calls.push([path, q]); if (path.includes("forecast")) throw new Error("throttled"); return { data: { evaluate: { buy: 1, total: 1 }, target: {} } }; };
    const r = await fetchResearch(env, "hk00700", get);
    expect(calls.map((c) => c[1])).toEqual(["symbol=700.HK", "symbol=700.HK", "symbol=700.HK", "symbol=700.HK"]);
    expect(r.rating.total).toBe(1);
    expect(r.forecastEps).toBeNull();
    expect(await fetchResearch({}, "usAAPL", get)).toBeNull(); // 没配长桥凭据
  });
});

describe("company profile and revenue mix", () => {
  it("parses the profile and segments, dropping eliminations, and states them as business facts", () => {
    const profile = parseProfile({ data: { name: "紫金矿业", company_name: "紫金矿业集团股份有限公司", profile: "矿产资源勘查;金矿采选;铜矿采选", employees: "69559" } });
    expect(profile).toMatchObject({ name: "紫金矿业集团股份有限公司", profile: "矿产资源勘查;金矿采选;铜矿采选", employees: 69559 });
    const segments = parseSegments({ data: { report_txt: "2026.H1", business: [{ name: "矿产品", percent: "33.71", yoy: "57.9" }, { name: "部门间冲销", percent: "", yoy: "-48" }], regionals: [{ name: "中国大陆", percent: "65", yoy: "7.5" }] } });
    expect(segments).toEqual({ period: "2026.H1", business: [{ name: "矿产品", percent: 33.71, yoy: 57.9 }], regions: [{ name: "中国大陆", percent: 65, yoy: 7.5 }] });
    const f = businessFacts({ research: { rating: { industry: { name: "黄金" } }, profile, segments }, lang: "zh" });
    expect(f).toEqual(["所属行业：黄金", "业务描述：矿产资源勘查;金矿采选;铜矿采选（员工约 69559 人）", "收入构成（2026.H1，按业务）：矿产品 33.7%（同比 +57.9%）", "收入构成（2026.H1，按地区）：中国大陆 65.0%（同比 +7.5%）"]);
    expect(businessFacts({ research: { profile: { profile: "x".repeat(400) } } })[0].length).toBeLessThan(300);
  });
});
