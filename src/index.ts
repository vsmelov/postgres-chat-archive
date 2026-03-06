import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createPgClient } from "./db.js";
import { registerAgentLogger } from "./handlers/agent-logger.js";
import { registerChatArchiver } from "./handlers/chat-archiver.js";
import { runMediaDownloader } from "./handlers/media-downloader.js";
import { runStorageMonitor } from "./utils/storage-monitor.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Plugin directory = where index.ts lives → go up one level (src/ → plugin root)
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PluginConfig {
  databaseUrl?: string;
  mediaStoragePath?: string;
  maxStorageGb?: number;
  archiveChannels?: string[];
  logAgentSessions?: boolean;
  downloadMedia?: boolean;
  botToken?: string;
}

const plugin = {
  id: "openclaw-chat-archive",
  name: "Chat Archive (PostgreSQL)",
  description: "Archives Telegram messages + agent sessions to PostgreSQL with local media storage",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;

    // ─── Config ──────────────────────────────────────────────────────────────
    const databaseUrl =
      cfg.databaseUrl ?? process.env.DATABASE_URL ?? "";
    // Default: ./media/ relative to plugin root (next to docker-compose.yml)
    const mediaStoragePath =
      cfg.mediaStoragePath ??
      path.join(PLUGIN_ROOT, "media");
    const maxStorageGb = cfg.maxStorageGb ?? 50;
    const archiveChannels = cfg.archiveChannels ?? ["telegram"];
    const logAgentSessions = cfg.logAgentSessions !== false;
    const downloadMedia = cfg.downloadMedia !== false;
    const botToken = cfg.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";

    if (!databaseUrl) {
      api.logger.warn(
        "[openclaw-chat-archive] No databaseUrl configured and DATABASE_URL not set — plugin disabled"
      );
      return;
    }

    // ─── DB connection ────────────────────────────────────────────────────────
    const sql = createPgClient(databaseUrl);

    let schemaReady = false;
    let initError: unknown = null;

    async function ensureReady() {
      if (schemaReady) return;
      if (initError) throw initError;
      try {
        await sql`SELECT 1`;
        schemaReady = true;
        api.logger.info("[openclaw-chat-archive] Database connection OK");
      } catch (err) {
        initError = err;
        api.logger.error(`[openclaw-chat-archive] DB init failed (will not retry): ${err}`);
        throw err;
      }
    }

    // ─── Agent logger (PR #19462 feature) ────────────────────────────────────
    if (logAgentSessions) {
      registerAgentLogger(api, sql);
      api.logger.info("[openclaw-chat-archive] Agent logger registered");
    }

    // ─── Chat archiver (all group messages) ───────────────────────────────────
    registerChatArchiver(api, sql, {
      archiveChannels,
      downloadMedia,
      botToken: botToken || undefined,
    });
    api.logger.info(
      `[openclaw-chat-archive] Chat archiver registered for channels: ${archiveChannels.join(", ")}`
    );

    // ─── Background: media downloader + storage monitor ───────────────────────
    // Run every 5 minutes after startup
    let backgroundTimer: ReturnType<typeof setInterval> | null = null;

    api.on(
      "gateway_stop",
      async () => {
        if (backgroundTimer) {
          clearInterval(backgroundTimer);
          backgroundTimer = null;
        }
        try {
          await sql.end({ timeout: 5 });
          api.logger.info("[openclaw-chat-archive] DB connections closed");
        } catch (err) {
          api.logger.error(`[openclaw-chat-archive] Error closing DB: ${err}`);
        }
      },
      { priority: 90 }
    );

    // Start background tasks after a short delay
    setTimeout(async () => {
      try {
        await ensureReady();
      } catch {
        return; // DB unavailable, don't start background tasks
      }

      api.logger.info("[openclaw-chat-archive] Starting background tasks");

      const runBackground = async () => {
        try {
          // Download pending media files
          if (downloadMedia && botToken) {
            await runMediaDownloader(sql, {
              botToken,
              mediaStoragePath,
              logger: api.logger,
            });
          }

          // Check storage quota (every 12 cycles = ~1h)
          const now = Date.now();
          if (!runBackground._lastStorageCheck || now - runBackground._lastStorageCheck > 3600000) {
            await runStorageMonitor(sql, { mediaStoragePath, maxStorageGb, logger: api.logger });
            runBackground._lastStorageCheck = now;
          }
        } catch (err) {
          api.logger.error(`[openclaw-chat-archive] Background task error: ${err}`);
        }
      };

      (runBackground as any)._lastStorageCheck = 0;

      // Run immediately, then every 5 minutes
      await runBackground();
      backgroundTimer = setInterval(runBackground, 5 * 60 * 1000);
    }, 5000);
  },
};

export default plugin;
