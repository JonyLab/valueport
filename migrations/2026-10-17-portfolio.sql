-- Portfolio：每个用户的券商账户（长桥 / IBKR Flex / 手动），持仓与现金为最近一次同步或录入的快照。
CREATE TABLE IF NOT EXISTS broker_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  broker        TEXT    NOT NULL,              -- longbridge | ibkr | manual
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
