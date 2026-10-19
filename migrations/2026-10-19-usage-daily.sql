-- 站长后台的使用统计：每人每天一行（打开页面时占位 = 日活；ai = 当天 AI 请求数，ai_own = 其中用自己模型的），见 src/usage.js
CREATE TABLE IF NOT EXISTS usage_daily (
  day      TEXT    NOT NULL,                -- UTC 日期 YYYY-MM-DD
  user_id  INTEGER NOT NULL,
  ai       INTEGER NOT NULL DEFAULT 0,
  ai_own   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);
