-- Migration 001: rename openclaw_messages → openclaw_agent_messages
-- Run: sudo docker exec openclaw_archive_postgres psql -U openclaw openclaw_archive -f /migrations/001_...sql

ALTER TABLE IF EXISTS openclaw_messages RENAME TO openclaw_agent_messages;
ALTER INDEX IF EXISTS idx_openclaw_messages_conversation
  RENAME TO idx_openclaw_agent_messages_conversation;
