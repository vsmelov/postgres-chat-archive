import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Sql } from "../db.js";
import { insertChatMessage, insertMedia } from "../db.js";

const MEDIA_PLACEHOLDER_RE = /<media:(\w+)(?:\s+file_id="([^"]+)")?(?:\s+size="(\d+)")?(?:\s+mime="([^"]+)")?[^>]*>/g;

const MENTION_PATTERNS = ["alice", "алиса", "бот", "@vsm_a_ai_agent_bot", "vsm_a_ai_agent_bot"];

function hasMention(text: string): boolean {
  const lower = text.toLowerCase();
  return MENTION_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

export function registerChatArchiver(
  api: OpenClawPluginApi,
  sql: Sql,
  opts: { archiveChannels: string[]; downloadMedia: boolean }
) {
  // Correct hook name is "message_received" (underscore), not "message:received"
  // event: { from, content, timestamp?, metadata? }
  // ctx:   { channelId, accountId?, conversationId? }
  // Debug: dump first message to understand real structure
  let _debugDumped = false;

  api.on(
    "message_received",
    async (event, ctx) => {
      try {
        if (!_debugDumped) {
          api.logger.info(`[chat-archiver] DEBUG event=${JSON.stringify(event)} ctx=${JSON.stringify(ctx)}`);
          _debugDumped = true;
        }

        // Filter by channel
        if (!opts.archiveChannels.includes(ctx.channelId)) return;

        const content = event.content ?? "";
        const meta = (event.metadata ?? {}) as Record<string, unknown>;

        // conversationId = Telegram chat_id
        const chatId = ctx.conversationId ? BigInt(ctx.conversationId) : null;
        if (!chatId) return;

        // Telegram message_id comes from metadata
        const telegramMessageId = meta.messageId
          ? BigInt(meta.messageId as string | number)
          : null;
        if (!telegramMessageId) return;

        const senderId = meta.senderId
          ? BigInt(meta.senderId as string | number)
          : null;

        const isAgentMention = hasMention(content);
        const threadId = meta.threadId
          ? BigInt(meta.threadId as string | number)
          : null;

        const row = await insertChatMessage(sql, {
          telegramMessageId,
          chatId,
          senderId,
          senderUsername: (meta.senderUsername as string) ?? null,
          senderName: (meta.senderName as string) ?? null,
          content: content || null,
          isAgentMention,
          agentSessionKey: null,
          threadId,
          createdAt: event.timestamp ? new Date(event.timestamp * 1000) : new Date(),
        });

        api.logger.info(
          `[chat-archiver] saved msg ${telegramMessageId} from chat ${chatId} (mention=${isAgentMention})`
        );

        // Queue media for download
        if (opts.downloadMedia && row && content) {
          for (const match of content.matchAll(MEDIA_PLACEHOLDER_RE)) {
            const fileType = match[1] ?? "unknown";
            const fileId = match[2] ?? null;
            if (!fileId) continue;
            await insertMedia(sql, {
              fileId,
              fileType,
              fileSize: match[3] ? parseInt(match[3]) : null,
              mimeType: match[4] ?? null,
              chatId,
              messageId: row.id,
            });
          }
        }
      } catch (err) {
        api.logger.error(`[chat-archiver] message_received error: ${err}`);
      }
    },
    { priority: 40 }
  );
}
