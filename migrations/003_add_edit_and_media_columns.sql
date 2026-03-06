-- Migration 003: edited_at + media_file_id + media_type columns
ALTER TABLE openclaw_chat_messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_file_id text,
  ADD COLUMN IF NOT EXISTS media_type text;
