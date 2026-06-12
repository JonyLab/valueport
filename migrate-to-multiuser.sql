-- 一次性迁移：旧（无 user 概念）→ 多用户。仅在已有数据的库上跑一次。
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL, board_slug TEXT NOT NULL UNIQUE, board_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activation_codes (code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL, used_at TEXT);

-- 占位初始用户（pass_hash/salt 先留空，迁移后用站长后台「重置密码」生成可用密码）
INSERT OR IGNORE INTO users (id, username, pass_hash, pass_salt, board_slug, board_name, created_at)
VALUES (1, 'owner', '', '', 'main', '默认看板', datetime('now'));

ALTER TABLE items ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE settings RENAME TO settings_old;
CREATE TABLE settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
INSERT INTO settings (user_id, key, value) SELECT 1, key, value FROM settings_old;
DROP TABLE settings_old;
