import { describe, it, expect } from "vitest";
import { parseRating, parseForecastEps, fetchResearch } from "../src/research.js";

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
    expect(calls.map((c) => c[1])).toEqual(["symbol=700.HK", "symbol=700.HK"]);
    expect(r.rating.total).toBe(1);
    expect(r.forecastEps).toBeNull();
    expect(await fetchResearch({}, "usAAPL", get)).toBeNull(); // 没配长桥凭据
  });
});
