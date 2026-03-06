-- postgres-chat-archive schema
-- Prefix: openclaw_ (no conflicts with user tables)
-- Requires: PostgreSQL 13+

-- ─────────────────────────────────────────────
-- Agent logger (from PR #19462 concept)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS openclaw_conversations (
  id          serial PRIMARY KEY,
  session_key text UNIQUE NOT NULL,   -- e.g. agent:main:telegram:-5194232540
  channel     text,                   -- 'telegram', 'discord', etc
  started_at  timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS openclaw_messages (
  id              serial PRIMARY KEY,
  conversation_id int NOT NULL REFERENCES openclaw_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         text,
  metadata        jsonb,              -- tool calls, model info, etc
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_openclaw_messages_conversation
  ON openclaw_messages(conversation_id, created_at);

-- ─────────────────────────────────────────────
-- Chat archiver (ALL messages, incl. no-mention)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS openclaw_chat_messages (
  id                  serial PRIMARY KEY,
  telegram_message_id bigint NOT NULL,
  chat_id             bigint NOT NULL,
  sender_id           bigint,
  sender_username     text,
  sender_name         text,
  content             text,           -- raw text or '<media:photo>' placeholder
  is_agent_mention    boolean NOT NULL DEFAULT false,
  agent_session_key   text REFERENCES openclaw_conversations(session_key) ON DELETE SET NULL,
  thread_id           bigint,         -- forum topic id if applicable
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_openclaw_chat_messages_chat
  ON openclaw_chat_messages(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_openclaw_chat_messages_sender
  ON openclaw_chat_messages(sender_id, created_at DESC);

-- ─────────────────────────────────────────────
-- Media storage (local files, metadata in DB)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS openclaw_media (
  id              serial PRIMARY KEY,
  file_id         text UNIQUE NOT NULL, -- Telegram file_id
  file_type       text NOT NULL,        -- 'photo', 'video', 'voice', 'document', 'audio', 'sticker'
  file_size       bigint,               -- bytes
  mime_type       text,
  local_path      text,                 -- absolute path on disk (null = not downloaded yet)
  chat_id         bigint,
  message_id      int REFERENCES openclaw_chat_messages(id) ON DELETE SET NULL,
  downloaded_at   timestamptz,
  deleted_at      timestamptz,          -- soft delete for cleanup
  download_error  text,                 -- last error if failed
  retry_count     int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_openclaw_media_pending
  ON openclaw_media(downloaded_at, deleted_at)
  WHERE local_path IS NULL AND deleted_at IS NULL AND download_error IS NULL;

CREATE INDEX IF NOT EXISTS idx_openclaw_media_cleanup
  ON openclaw_media(downloaded_at ASC)
  WHERE local_path IS NOT NULL AND deleted_at IS NULL;

-- ─────────────────────────────────────────────
-- Storage monitoring
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS openclaw_storage_stats (
  id              serial PRIMARY KEY,
  total_size_bytes bigint NOT NULL,
  file_count      int NOT NULL,
  deleted_count   int NOT NULL DEFAULT 0,
  checked_at      timestamptz NOT NULL DEFAULT now()
);
