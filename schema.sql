CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE,
  pass_hash   TEXT    NOT NULL,
  pass_salt   TEXT    NOT NULL,
  board_slug  TEXT    NOT NULL UNIQUE,
  board_name  TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  ticker      TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  symbol      TEXT    NOT NULL,
  fair_low    REAL    NOT NULL,
  fair_high   REAL    NOT NULL,
  mos         REAL    NOT NULL,
  ext         REAL    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  valuations            TEXT NOT NULL DEFAULT '[]',
  selected_valuation_id TEXT,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);
CREATE TABLE IF NOT EXISTS settings (
  user_id  INTEGER NOT NULL,
  key      TEXT    NOT NULL,
  value    TEXT    NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS activation_codes (
  code        TEXT PRIMARY KEY,
  used_by     INTEGER,
  created_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE TABLE IF NOT EXISTS broker_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  broker        TEXT    NOT NULL,              -- longbridge | ibkr | tiger | schwab | etrade | webull | manual
  name          TEXT    NOT NULL DEFAULT '',
  cred_enc      TEXT,                          -- AES-GCM 加密的凭证 JSON（manual 为空），见 src/crypto.js
  last_sync_at  TEXT,
  last_error    TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broker_accounts_user ON broker_accounts(user_id);
CREATE TABLE IF NOT EXISTS holdings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  symbol      TEXT    NOT NULL,                -- 腾讯格式：usAAPL / hk00700 / sh600519
  name        TEXT    NOT NULL DEFAULT '',
  quantity    REAL    NOT NULL,
  cost_price  REAL,
  currency    TEXT    NOT NULL,
  market      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_holdings_account ON holdings(account_id);
CREATE TABLE IF NOT EXISTS cash_balances (
  account_id  INTEGER NOT NULL,
  currency    TEXT    NOT NULL,
  amount      REAL    NOT NULL,
  PRIMARY KEY (account_id, currency)
);
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  user_id     INTEGER NOT NULL,
  day         TEXT    NOT NULL,                -- UTC 日期 YYYY-MM-DD
  account_id  INTEGER NOT NULL,
  v_usd       REAL    NOT NULL,
  v_hkd       REAL    NOT NULL,
  v_cny       REAL    NOT NULL,
  PRIMARY KEY (user_id, day, account_id)
);
CREATE TABLE IF NOT EXISTS portfolio_plans (
  user_id     INTEGER PRIMARY KEY,
  plan        TEXT    NOT NULL,                -- {targets:{symbol:pct}, cash:pct|null, band:pp, rel:%}
  updated_at  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_models (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  provider    TEXT    NOT NULL,                -- openai（OpenAI 兼容）| anthropic
  name        TEXT    NOT NULL DEFAULT '',
  model       TEXT    NOT NULL,
  base_url    TEXT    NOT NULL DEFAULT '',
  key_enc     TEXT    NOT NULL,                -- AES-GCM 加密的 {apiKey}，见 src/crypto.js
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_models_user ON ai_models(user_id);

-- AI 估值助手的对话记录：按用户 + 标的保存，面板打开时恢复最近一次，可在「历史」里切换 / 删除（见 src/ai-chats.js）
CREATE TABLE IF NOT EXISTS ai_chats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  symbol      TEXT    NOT NULL,                -- 本项目代码，如 usAAPL / hk00700 / sh600519
  method      TEXT    NOT NULL DEFAULT '',     -- 对话时的估值方法 key
  title       TEXT    NOT NULL DEFAULT '',     -- 第一句提问（截断）
  messages    TEXT    NOT NULL,                -- JSON：[{role, content, view?}]，view 是 AI 回复的结构化内容（建议参数、情景、组件）
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_chats_user_symbol ON ai_chats(user_id, symbol, updated_at);
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
