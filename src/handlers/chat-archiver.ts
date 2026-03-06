import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Sql } from "../db.js";
import { insertChatMessage, insertMedia } from "../db.js";

// Matches: <media:photo>, <media:voice>, <media:video>, <media:document>, etc.
const MEDIA_PLACEHOLDER_RE = /<media:(\w+)(?:\s+file_id="([^"]+)")?(?:\s+size="(\d+)")?(?:\s+mime="([^"]+)")?[^>]*>/g;

function detectMention(content: string | undefined, botUsername: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes(`@${botUsername.toLowerCase()}`) ||
    lower.includes("alice") ||
    lower.includes("алиса") ||
    lower.includes("бот")
  );
}

export function registerChatArchiver(
  api: OpenClawPluginApi,
  sql: Sql,
  opts: { archiveChannels: string[]; downloadMedia: boolean; botUsername?: string }
) {
  const botUsername = opts.botUsername ?? "vsm_a_ai_agent_bot";

  api.on(
    "message:received",
    async (event, _ctx) => {
      try {
        const ctx = (event as any).context ?? {};
        const channelId: string = ctx.channelId ?? "";

        // Only archive configured channels
        if (!opts.archiveChannels.includes(channelId)) return;

        const content: string = ctx.content ?? "";
        const meta = ctx.metadata ?? {};

        const chatId = BigInt(ctx.conversationId ?? ctx.groupId ?? 0);
        if (!chatId) return; // skip DMs without conversation id

        const senderId = meta.senderId ? BigInt(meta.senderId) : null;
        const telegramMessageId = ctx.messageId ? BigInt(ctx.messageId) : null;
        if (!telegramMessageId) return;

        const isAgentMention = detectMention(content, botUsername);
        const threadId = meta.threadId ? BigInt(meta.threadId) : null;

        const row = await insertChatMessage(sql, {
          telegramMessageId,
          chatId,
          senderId,
          senderUsername: meta.senderUsername ?? null,
          senderName: meta.senderName ?? null,
          content: content || null,
          isAgentMention,
          agentSessionKey: null, // will be linked later by agent-logger if mention
          threadId,
          createdAt: ctx.timestamp ? new Date(ctx.timestamp * 1000) : new Date(),
        });

        // Queue media for download
        if (opts.downloadMedia && row) {
          const mediaMatches = [...content.matchAll(MEDIA_PLACEHOLDER_RE)];
          for (const match of mediaMatches) {
            const fileType = match[1] ?? "unknown";
            const fileId = match[2] ?? null;
            const fileSize = match[3] ? parseInt(match[3]) : null;
            const mimeType = match[4] ?? null;

            if (!fileId) {
              // No file_id in placeholder — can't download without it
              // Will need Telegram update object which comes via plugin API if available
              api.logger.debug(`[chat-archiver] media placeholder without file_id: ${match[0]}`);
              continue;
            }

            await insertMedia(sql, {
              fileId,
              fileType,
              fileSize,
              mimeType,
              chatId,
              messageId: row.id,
            });
          }
        }

        api.logger.debug(
          `[chat-archiver] saved message ${telegramMessageId} from chat ${chatId} (mention=${isAgentMention})`
        );
      } catch (err) {
        api.logger.error(`[chat-archiver] message:received error: ${err}`);
      }
    },
    { priority: 40 }
  );
}
