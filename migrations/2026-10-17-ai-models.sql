-- 用户自己配置的 AI 模型（设置页只管配置；在 AI 面板里切换用哪个，选择记在 settings 的内部键 _ai_active）
-- 站点默认与 Workers AI 模型不用配置，不进这张表
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
-- 早先的单条设置表（从未上线，可直接删）
DROP TABLE IF EXISTS ai_settings;
