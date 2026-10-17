-- Portfolio 资产曲线：每天一行快照（account_id = 0 表示全部账户合计）。金额按当天汇率分别折成 USD / HKD / CNY 存，
-- 切换显示币种时不受日后汇率变动影响。
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  user_id     INTEGER NOT NULL,
  day         TEXT    NOT NULL,                -- UTC 日期 YYYY-MM-DD
  account_id  INTEGER NOT NULL,
  v_usd       REAL    NOT NULL,
  v_hkd       REAL    NOT NULL,
  v_cny       REAL    NOT NULL,
  PRIMARY KEY (user_id, day, account_id)
);
