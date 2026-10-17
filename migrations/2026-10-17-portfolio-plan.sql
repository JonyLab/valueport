-- 资产页「目标仓位」：每个用户一份计划（JSON），见 src/portfolio.js validatePlan
CREATE TABLE IF NOT EXISTS portfolio_plans (
  user_id     INTEGER PRIMARY KEY,
  plan        TEXT    NOT NULL,                -- {targets:{symbol:pct}, cash:pct|null, band:pp, rel:%}
  updated_at  TEXT    NOT NULL
);
