-- Migration 002: add bot reply support to openclaw_chat_messages
-- Allows storing outgoing bot messages alongside incoming user messages

ALTER TABLE openclaw_chat_messages
  ADD COLUMN IF NOT EXISTS is_bot_reply boolean NOT NULL DEFAULT false,
  ALTER COLUMN telegram_message_id DROP NOT NULL,
  ALTER COLUMN sender_id DROP NOT NULL;

-- Replace old unique constraint with partial index (allows NULL telegram_message_ids for bot replies)
ALTER TABLE openclaw_chat_messages
  DROP CONSTRAINT IF EXISTS openclaw_chat_messages_chat_id_telegram_message_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_inbound
  ON openclaw_chat_messages(chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;
