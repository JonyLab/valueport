import { describe, it, expect } from "vitest";
import {
  presetBuckets,
  ALERT_METRICS,
  ALERT_TEMPLATE_GROUPS,
  ALERT_TEMPLATES,
  createAlertFromTemplate,
  inferAssetDefaults,
  metricQuickPresets,
  isAllocOnly,
  computeBucketSummary,
  evaluateSignalAlerts,
  extractAlertSeries,
  computeRebalancePlan,
  computeScheduleStatus,
  computeRiskMetrics,
} from "../public/shared/rebalance.js";

describe("bucket allocation summary", () => {
  const rows = [
    { symbol: "usVOO", name: "VOO", value: 60000, price: 500, currency: "USD", zone: -1 },
    { symbol: "usTLT", name: "TLT", value: 25000, price: 90, currency: "USD", zone: -1 },
    { symbol: "usGLD", name: "GLD", value: 5000, price: 240, currency: "USD", zone: -1 },
  ];
  const plan = {
    buckets: presetBuckets("balanced", "zh"), // 50 / 35 / 10 / 5
    assetClass: { usVOO: "equity", usTLT: "bond", usGLD: "commodity" },
    allocOnly: ["usVOO", "usTLT", "usGLD"],
    band: 5,
    rel: 25,
  };

  it("aggregates holdings and cash into buckets and flags 5/25 drift", () => {
    const sum = computeBucketSummary({ rows, cashValue: 10000, total: 100000, plan });
    expect(sum.active).toBe(true);
    expect(sum.hasTargets).toBe(true);
    expect(sum.allocated).toBe(100);

    const eq = sum.buckets.find((b) => b.id === "equity");
    const bd = sum.buckets.find((b) => b.id === "bond");
    const cm = sum.buckets.find((b) => b.id === "commodity");
    const ca = sum.buckets.find((b) => b.id === "cash");
    expect(eq.cur).toBeCloseTo(60);
    expect(eq.status).toBe("over"); // +10pp > 5pp
    expect(bd.cur).toBeCloseTo(25);
    expect(bd.status).toBe("under"); // -10pp < -5pp
    expect(cm.cur).toBeCloseTo(5);
    expect(cm.status).toBe("under"); // -5pp > rel 25% of 10 (2.5pp)
    expect(ca.cur).toBeCloseTo(10);
    expect(ca.status).toBe("over"); // +5pp > rel 25% of 5 (1.25pp)
    expect(sum.offCount).toBe(4);
    expect(sum.unclassified).toBeNull();
    expect(isAllocOnly(plan, "usVOO")).toBe(true);
  });

  it("places uncategorized holdings into unclassified without losing total value", () => {
    const sum = computeBucketSummary({
      rows: [...rows, { symbol: "hk00700", name: "Tencent", value: 10000, price: 400, currency: "HKD", zone: 1 }],
      cashValue: 0,
      total: 100000,
      plan,
    });
    expect(sum.unclassified).not.toBeNull();
    expect(sum.unclassified.value).toBe(10000);
    expect(sum.unclassified.cur).toBeCloseTo(10);
  });
});

describe("rebalance engine", () => {
  const rows = [
    { symbol: "usVOO", name: "VOO", value: 60000, price: 500, currency: "USD", zone: -1 },
    { symbol: "usTLT", name: "TLT", value: 25000, price: 100, currency: "USD", zone: -1 },
    { symbol: "usGLD", name: "GLD", value: 5000, price: 250, currency: "USD", zone: -1 },
  ];
  const plan = {
    buckets: presetBuckets("balanced", "en"), // 50 / 35 / 10 / 5
    assetClass: { usVOO: "equity", usTLT: "bond", usGLD: "commodity" },
    targets: { usVOO: 50, usTLT: 35, usGLD: 10 },
    cash: 5,
    allocOnly: ["usVOO", "usTLT", "usGLD"],
    band: 5,
    rel: 25,
  };

  it("computes standard buy & sell rebalance back to exact targets", () => {
    const r = computeRebalancePlan({ rows, cashValue: 10000, total: 100000, plan, scope: "bucket", mode: "standard" });
    expect(r.canSwitchScope).toBe(true);
    expect(r.totalSell).toBeCloseTo(10000);
    expect(r.totalBuy).toBeCloseTo(15000);
    expect(r.afterCash).toBeCloseTo(5000);
    expect(r.afterCashPct).toBeCloseTo(5);
    expect(r.sells.map((x) => x.bucketId)).toEqual(["equity"]);
    expect(r.buys.map((x) => [x.bucketId, Math.round(x.execDelta)])).toEqual([["bond", 10000], ["commodity", 5000]]);
  });

  it("computes cash-flow-only rebalance with zero sells proportional to shortfall", () => {
    // New total = 110,000. Targets: eq=55k (cur 60k, no sell), bond=38.5k (shortfall 13.5k), gold=11k (shortfall 6k)
    // Total shortfall = 19.5k > 10k added cash → allocate 10k proportionally
    const r = computeRebalancePlan({
      rows, cashValue: 10000, total: 100000, plan,
      scope: "symbol", mode: "cashflow", cashAdded: 10000,
    });
    expect(r.sells).toHaveLength(0);
    expect(r.totalSell).toBe(0);
    expect(r.totalBuy).toBeCloseTo(10000);
    expect(r.afterCash).toBeCloseTo(10000);
    const bondBuy = r.buys.find((x) => x.symbol === "usTLT");
    const goldBuy = r.buys.find((x) => x.symbol === "usGLD");
    expect(bondBuy.execDelta).toBeCloseTo(10000 * 13500 / 19500);
    expect(goldBuy.execDelta).toBeCloseTo(10000 * 6000 / 19500);
    expect(bondBuy.shares).toBe(Math.floor(bondBuy.execDelta / 100));
  });

  it("pauses buys on overvalued stocks and sells on undervalued stocks when guardrail is enabled", () => {
    const stockRows = [
      { symbol: "usAAPL", name: "Apple", value: 20000, price: 200, currency: "USD", zone: 4 },   // bubble, underweight (target 50%)
      { symbol: "hk00700", name: "Tencent", value: 70000, price: 350, currency: "HKD", zone: 0 }, // strike, overweight (target 40%)
    ];
    const stockPlan = { targets: { usAAPL: 50, hk00700: 40 }, cash: 10, band: 5, rel: 25 };

    const guarded = computeRebalancePlan({ rows: stockRows, cashValue: 10000, total: 100000, plan: stockPlan, scope: "symbol", mode: "standard", useGuardrail: true });
    expect(guarded.buys).toHaveLength(0);
    expect(guarded.sells).toHaveLength(0);
    expect(guarded.holds.find((x) => x.symbol === "usAAPL").reason).toBe("guard_wait_hot");
    expect(guarded.holds.find((x) => x.symbol === "hk00700").reason).toBe("guard_hold_cheap");

    const mechanical = computeRebalancePlan({ rows: stockRows, cashValue: 10000, total: 100000, plan: stockPlan, scope: "symbol", mode: "standard", useGuardrail: false });
    expect(mechanical.buys.map((x) => x.symbol)).toEqual(["usAAPL"]);
    expect(mechanical.sells.map((x) => x.symbol)).toEqual(["hk00700"]);
  });
});

describe("rebalance schedule status", () => {
  it("handles quarterly review due dates and month-end clamping", () => {
    const ok = computeScheduleStatus({ freq: "quarterly", lastRebalancedAt: "2026-10-01" }, "2026-11-27");
    expect(ok.active).toBe(true);
    expect(ok.nextReviewAt).toBe("2027-01-01");
    expect(ok.overdue).toBe(false);
    expect(ok.daysLeft).toBe(35);

    const overdue = computeScheduleStatus({ freq: "monthly", lastRebalancedAt: "2026-01-31" }, "2026-03-01");
    expect(overdue.nextReviewAt).toBe("2026-02-28");
    expect(overdue.overdue).toBe(true);

    const never = computeScheduleStatus({ freq: "quarterly" }, "2026-11-27");
    expect(never.overdue).toBe(true);
    expect(never.neverDone).toBe(true);
  });
});

describe("conservative risk metrics", () => {
  it("computes max drawdown, peak/trough dates, current drawdown and volatility gating", () => {
    const shortPts = [
      ["2026-11-01", 100],
      ["2026-11-02", 120],
      ["2026-11-03", 96],  // -20% from 120
      ["2026-11-04", 108], // -10% from 120
    ];
    const m = computeRiskMetrics(shortPts);
    expect(m.maxDrawdownPct).toBeCloseTo(-20);
    expect(m.peakDay).toBe("2026-11-02");
    expect(m.troughDay).toBe("2026-11-03");
    expect(m.currentDrawdownPct).toBeCloseTo(-10);
    expect(m.atHigh).toBe(false);
    expect(m.annVolPct).toBeNull(); // < 14 samples

    const longPts = Array.from({ length: 20 }, (_, i) => [
      `2026-10-${String(i + 1).padStart(2, "0")}`,
      100 + (i % 2 === 0 ? 1 : -1) * 2 + i * 0.5,
    ]);
    const mLong = computeRiskMetrics(longPts);
    expect(mLong.annVolPct).toBeGreaterThan(0);
    expect(Number.isFinite(mLong.annVolPct)).toBe(true);
  });
});

describe("indicator threshold alerts and scenario profiles", () => {
  const buckets = presetBuckets("balanced", "zh"); // 50 / 35 / 10 / 5
  const rows = [
    { symbol: "usVOO", name: "VOO", value: 50000, price: 500, currency: "USD", zone: -1 },
    { symbol: "usTLT", name: "TLT", value: 35000, price: 100, currency: "USD", zone: -1 },
    { symbol: "usGLD", name: "GLD", value: 10000, price: 250, currency: "USD", zone: -1 },
  ];
  const macroSample = {
    markets: [
      { key: "cn", level: 20, zone: 1, indicators: [{ key: "cn_erp", value: 4.9, unit: "pp", pct: 99, expensive: 1, date: "2026-11" }] },
      { key: "us", level: 92, zone: 4, indicators: [{ key: "us_erp", value: 0.4, unit: "pp", pct: 1, expensive: 99, date: "2026-11" }] },
    ],
    rates: [{ key: "cn10y", value: 1.59, date: "2026-11" }],
  };
  const profiles = [
    { id: "defensive", name: "防守过冬", targets: { equity: 30, bond: 45, commodity: 15, cash: 10 } },
    { id: "offensive", name: "熊市进攻", targets: { equity: 65, bond: 20, commodity: 10, cash: 5 } },
  ];

  it("triggers alerts on true historical percentile (1% / 99%) and numeric thresholds without inverting", () => {
    const alerts = [
      { id: "a1", enabled: true, metric: "cn_erp", mode: "pct", op: "gte", threshold: 99, note: "A股性价比达历史99%", suggestProfileId: "offensive" },
      { id: "a2", enabled: true, metric: "us_erp", mode: "pct", op: "lte", threshold: 1, note: "美股性价比跌至历史1%", suggestProfileId: "defensive" },
      { id: "a3", enabled: true, metric: "cn10y", mode: "value", op: "lte", threshold: 1.8, note: "国债利率低位" },
      { id: "a4", enabled: true, metric: "us10y", mode: "value", op: "gte", threshold: 5.0, note: "缺失数据不误报" },
      { id: "a5", enabled: false, metric: "cn10y", mode: "value", op: "lte", threshold: 2.0, note: "已关闭不触发" },
    ];
    const res = evaluateSignalAlerts(alerts, macroSample, profiles);
    expect(res.triggered.map((x) => x.id)).toEqual(["a1", "a2", "a3"]);
    expect(res.triggered[0].actual).toBe(99);
    expect(res.triggered[0].suggestProfile.id).toBe("offensive");
    expect(res.triggered[1].actual).toBe(1);
    expect(res.triggered[1].suggestProfile.id).toBe("defensive");
    expect(res.items[3].available).toBe(false);
    expect(res.items[3].triggered).toBe(false);

    const tpl = createAlertFromTemplate("cn_erp_high", "zh");
    expect(tpl).toMatchObject({ metric: "cn_erp", mode: "pct", op: "gte", threshold: 90 });

    // Every preset template references a valid metric, mode, op, and group
    expect(ALERT_TEMPLATES.length).toBeGreaterThanOrEqual(16);
    const metricMap = new Map(ALERT_METRICS.map((m) => [m.key, m]));
    const groupKeys = new Set(ALERT_TEMPLATE_GROUPS.map((g) => g.key));
    for (const item of ALERT_TEMPLATES) {
      const m = metricMap.get(item.metric);
      expect(m).toBeTruthy();
      expect(m.modes).toContain(item.mode);
      expect(["gte", "lte"]).toContain(item.op);
      expect(groupKeys.has(item.group)).toBe(true);
      const created = createAlertFromTemplate(item.key, "en");
      expect(created.metric).toBe(item.metric);
      expect(created.note.length).toBeGreaterThan(0);
    }
  });

  it("applies selected scenario profile in computeRebalancePlan without mutating base targets", () => {
    const plan = {
      buckets,
      assetClass: { usVOO: "equity", usTLT: "bond", usGLD: "commodity" },
      allocOnly: ["usVOO", "usTLT", "usGLD"],
      profiles,
    };
    const reb = computeRebalancePlan({ rows, cashValue: 5000, total: 100000, plan, profileId: "defensive", scope: "bucket", mode: "standard" });
    expect(reb.activeProfile.id).toBe("defensive");
    expect(reb.sells.map((x) => [x.bucketId, Math.round(Math.abs(x.execDelta))])).toEqual([["equity", 20000]]);
    expect(reb.buys.map((x) => [x.bucketId, Math.round(x.execDelta)])).toEqual([["bond", 10000], ["commodity", 5000]]);
    expect(reb.afterCashPct).toBeCloseTo(10);
  });

  it("extracts monthly series and empirical quantile threshold line for alert charts", () => {
    const macroWithGravity = {
      gravity: {
        cn: {
          ey: [["2024-01", 5.0], ["2024-02", 6.0], ["2024-03", 7.0], ["2024-04", 8.0]],
          y10: [["2024-01", 2.5], ["2024-02", 2.2], ["2024-03", 1.9], ["2024-04", 1.6]],
        },
      },
    };
    const rateSer = extractAlertSeries(macroWithGravity, "cn10y", "value", 1.8);
    expect(rateSer.points).toHaveLength(4);
    expect(rateSer.current).toBe(1.6);
    expect(rateSer.thresholdVal).toBe(1.8);

    const erpSer = extractAlertSeries(macroWithGravity, "cn_erp", "pct", 100);
    expect(erpSer.points.map((p) => p[1])).toEqual([2.5, 3.8, 5.1, 6.4]);
    expect(erpSer.thresholdVal).toBe(6.4);
  });

  it("auto-infers ETF bucket & allocOnly defaults, quick metric presets, and per-item guardrail override", () => {
    const bkts = presetBuckets("balanced", "zh");
    expect(inferAssetDefaults("usVOO", "S&P 500 ETF", bkts)).toMatchObject({ kind: "equity", allocOnly: true, bucketId: "equity" });
    expect(inferAssetDefaults("usTLT", "20Y Treasury", bkts)).toMatchObject({ kind: "bond", allocOnly: true, bucketId: "bond" });
    expect(inferAssetDefaults("sh518880", "黄金ETF", bkts)).toMatchObject({ kind: "commodity", allocOnly: true, bucketId: "commodity" });
    expect(inferAssetDefaults("hk00700", "腾讯控股", bkts)).toMatchObject({ kind: null, allocOnly: false, bucketId: "equity" });

    expect(metricQuickPresets("cn_erp", "zh")).toHaveLength(3);
    expect(metricQuickPresets("cn10y", "zh")[0]).toMatchObject({ mode: "value", op: "lte", threshold: 1.8 });

    // Per-item guardrail override lets user explicitly include a bubble stock without disabling guardrail globally
    const stockRows = [
      { symbol: "usAAPL", name: "Apple", value: 20000, price: 200, currency: "USD", zone: 4 },
      { symbol: "hk00700", name: "Tencent", value: 70000, price: 350, currency: "HKD", zone: 0 },
    ];
    const stockPlan = { targets: { usAAPL: 50, hk00700: 40 }, cash: 10, band: 5, rel: 25 };
    const overridden = computeRebalancePlan({
      rows: stockRows, cashValue: 10000, total: 100000, plan: stockPlan,
      scope: "symbol", mode: "standard", useGuardrail: true, overrideGuardrailKeys: ["usAAPL"],
    });
    expect(overridden.buys.map((x) => x.symbol)).toEqual(["usAAPL"]);
    expect(overridden.holds.find((x) => x.symbol === "hk00700").reason).toBe("guard_hold_cheap");
  });
});
