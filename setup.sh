#!/usr/bin/env bash
# setup.sh — one-command install for openclaw-chat-archive
# Usage: bash setup.sh

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$PLUGIN_DIR/.env"

echo "╔══════════════════════════════════════════╗"
echo "║   openclaw-chat-archive  setup           ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Step 1: Generate .env if missing ────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  echo "✅ .env already exists — skipping password generation"
else
  echo "🔑 Generating random password..."
  PG_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
  cat > "$ENV_FILE" <<EOF
POSTGRES_DB=openclaw_archive
POSTGRES_USER=openclaw
POSTGRES_PASSWORD=${PG_PASS}

DATABASE_URL=postgresql://openclaw:${PG_PASS}@127.0.0.1:5436/openclaw_archive
EOF
  echo "✅ .env created with auto-generated password"
fi

# Load env vars
set -a; source "$ENV_FILE"; set +a

# ─── Step 2: Start Postgres ───────────────────────────────────────────────────
echo ""
echo "🐳 Starting PostgreSQL..."
cd "$PLUGIN_DIR"
sudo docker compose up -d

echo "⏳ Waiting for healthy..."
for i in $(seq 1 20); do
  STATUS=$(sudo docker inspect openclaw_archive_postgres --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  if [ "$STATUS" = "healthy" ]; then
    echo "✅ PostgreSQL is healthy"
    break
  fi
  sleep 2
done

# ─── Step 3: Install npm deps ─────────────────────────────────────────────────
echo ""
echo "📦 Installing dependencies..."
cd "$PLUGIN_DIR"
npm install --silent

# ─── Step 4: Install plugin into OpenClaw ────────────────────────────────────
echo ""
echo "🔌 Installing plugin into OpenClaw..."
openclaw plugins install --link "$PLUGIN_DIR"

# ─── Step 5: Configure OpenClaw ───────────────────────────────────────────────
echo ""
echo "⚙️  Configuring OpenClaw..."
openclaw config set plugins.entries.openclaw-chat-archive.config.databaseUrl "$DATABASE_URL"
openclaw config set plugins.entries.openclaw-chat-archive.config.mediaStoragePath "$PLUGIN_DIR/media"
openclaw config set plugins.entries.openclaw-chat-archive.config.maxStorageGb 50
openclaw config set plugins.entries.openclaw-chat-archive.config.logAgentSessions true
openclaw config set plugins.entries.openclaw-chat-archive.config.downloadMedia false

# ─── Step 6: Restart gateway ─────────────────────────────────────────────────
echo ""
echo "🔄 Restarting OpenClaw gateway..."
openclaw gateway restart

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✅  Setup complete!                    ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "DB:     $DATABASE_URL"
echo "Media:  $PLUGIN_DIR/media"
echo ""
echo "Check status:  openclaw plugins list"
echo "View DB:       sudo docker exec openclaw_archive_postgres psql -U openclaw openclaw_archive"
