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
