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
        // Plugin API: fields may be directly on event OR in event.context
        const ev = event as any;
        const channelId: string = ev.channelId ?? ev.context?.channelId ?? ev.channel ?? "";

        api.logger.debug(`[chat-archiver] message:received fired, channelId=${channelId}`);

        // Only archive configured channels
        if (!opts.archiveChannels.includes(channelId)) return;

        const content: string = ev.content ?? ev.context?.content ?? "";
        const meta = ev.metadata ?? ev.context?.metadata ?? {};
        const convId = ev.conversationId ?? ev.context?.conversationId ?? ev.groupId ?? ev.context?.groupId;

        const chatId = convId ? BigInt(convId) : 0n;
        if (!chatId) return; // skip if no conversation id

        const senderId = meta.senderId ? BigInt(meta.senderId) : null;
        const msgId = ev.messageId ?? ev.context?.messageId;
        const telegramMessageId = msgId ? BigInt(msgId) : null;
        if (!telegramMessageId) return;

        const isAgentMention = detectMention(content, botUsername);
        const threadId = meta.threadId ? BigInt(meta.threadId) : null;
        const ts = ev.timestamp ?? ev.context?.timestamp;

        const row = await insertChatMessage(sql, {
          telegramMessageId,
          chatId,
          senderId,
          senderUsername: meta.senderUsername ?? null,
          senderName: meta.senderName ?? null,
          content: content || null,
          isAgentMention,
          agentSessionKey: null,
          threadId,
          createdAt: ts ? new Date(ts * 1000) : new Date(),
        });

        // Queue media for download
        if (opts.downloadMedia && row && content) {
          const mediaMatches = [...content.matchAll(MEDIA_PLACEHOLDER_RE)];
          for (const match of mediaMatches) {
            const fileType = match[1] ?? "unknown";
            const fileId = match[2] ?? null;
            const fileSize = match[3] ? parseInt(match[3]) : null;
            const mimeType = match[4] ?? null;

            if (!fileId) {
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
