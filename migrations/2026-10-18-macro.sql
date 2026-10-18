-- 宏观看板：月度序列（FRED / multpl / 东方财富），每周最多刷新一次，见 src/macro.js
CREATE TABLE IF NOT EXISTS macro_series (
  series  TEXT NOT NULL,                -- US_10Y / US_REAL10Y / US_EQUITY / US_GDP / US_CAPE / CN_10Y / CN_PE
  date    TEXT NOT NULL,                -- YYYY-MM
  value   REAL NOT NULL,
  PRIMARY KEY (series, date)
);
CREATE TABLE IF NOT EXISTS macro_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
