# postgres-chat-archive

OpenClaw plugin — archives **all** Telegram group messages + agent sessions to PostgreSQL.
Media files (photos, videos, voice) stored locally on disk.

## What gets archived

| Event | Where |
|-------|-------|
| Every message in any group | `openclaw_chat_messages` |
| Agent prompt (mention) | `openclaw_messages` (role=user) |
| Agent response | `openclaw_messages` (role=assistant) |
| Photos, videos, voice | Local file + `openclaw_media` metadata |
| Storage stats | `openclaw_storage_stats` |

## Quick Start

### 1. Start Postgres

```bash
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD
docker compose up -d
```

Postgres listens on `127.0.0.1:5432` only — not exposed to external network.

### 2. Install plugin into OpenClaw

```bash
# Copy/symlink into openclaw extensions
ln -s $(pwd) ~/.openclaw/extensions/openclaw-chat-archive

# Install dependencies
cd ~/.openclaw/extensions/openclaw-chat-archive
npm install
```

### 3. Configure openclaw.json

```json5
{
  plugins: {
    entries: {
      "openclaw-chat-archive": {
        enabled: true,
        config: {
          databaseUrl: "postgresql://openclaw:yourpassword@127.0.0.1:5432/openclaw_archive",
          mediaStoragePath: "/home/user/.openclaw/workspace/persist-postgres/media",
          maxStorageGb: 50,
          archiveChannels: ["telegram"],
          logAgentSessions: true,
          downloadMedia: true
          // botToken: auto-read from TELEGRAM_BOT_TOKEN env
        }
      }
    }
  }
}
```

### 4. Restart gateway

```bash
openclaw gateway restart
```

## Schema

```sql
openclaw_conversations   -- agent sessions (one per session_key)
openclaw_messages        -- agent prompts + responses
openclaw_chat_messages   -- ALL group messages (with/without mention)
openclaw_media           -- media file metadata + local paths
openclaw_storage_stats   -- storage monitoring history
```

## Storage Management

- Media stored at: `mediaStoragePath/{chat_id}/{YYYY-MM-DD}/{type}_{name}.ext`
- Storage checked every hour
- When over `maxStorageGb`: oldest files deleted until under 90% of limit
- Soft delete: metadata kept in DB, only file removed from disk

## Docker

```bash
# Start
docker compose up -d

# Check logs
docker compose logs -f

# Connect to DB
docker compose exec postgres psql -U openclaw openclaw_archive

# Stop (data preserved in volume)
docker compose down

# Destroy everything including data
docker compose down -v
```
