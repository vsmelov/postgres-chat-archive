# persist-postgres

OpenClaw plugin — PostgreSQL persistence for conversations + full Telegram media storage.

## Features

- Saves all user prompts + assistant responses to Postgres
- Stores full Telegram media (images, videos, voice, documents) as bytea/S3 refs
- Auto-creates schema (lp_conversations, lp_messages, lp_media)
- Session-key based conversation tracking
- Extension-only — no core schema changes

## Install

```bash
openclaw plugins install @your-scope/persist-postgres
```

## Config

```json5
plugins: {
  entries: {
    "persist-postgres": {
      enabled: true,
      config: {
        databaseUrl: "postgresql://user:pass@host/db",
        storeMedia: true,       // store media inline (bytea) or false to skip
        mediaStorage: "inline"  // "inline" | "s3" (s3 TBD)
      }
    }
  }
}
```

## Schema

```sql
lp_conversations  -- one row per session_key
lp_messages       -- user/assistant messages with content
lp_media          -- media files linked to messages (bytea or s3 ref)
```
