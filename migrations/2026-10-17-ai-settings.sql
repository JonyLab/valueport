-- 用户自己的 AI 模型设置（没有记录 = 用站点默认）。Key 用 CREDENTIALS_KEY 加密，接口永不返回明文
CREATE TABLE IF NOT EXISTS ai_settings (
  user_id     INTEGER PRIMARY KEY,
  provider    TEXT    NOT NULL,                -- workers-ai | openai | anthropic
  model       TEXT    NOT NULL DEFAULT '',
  base_url    TEXT    NOT NULL DEFAULT '',
  key_enc     TEXT,
  updated_at  TEXT    NOT NULL
);
