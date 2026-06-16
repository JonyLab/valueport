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
