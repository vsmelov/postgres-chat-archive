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
  opts: { archiveChannels: string[]; downloadMedia: boolean; botUsername?: string }
) {
  const botUsername = opts.botUsername ?? "vsm_a_ai_agent_bot";

  // ─── Outgoing: bot replies ─────────────────────────────────────────────────
  // message_sent: { to, content, success, error? }
  // ctx:          { channelId, accountId?, conversationId? }
  // Try message_sending (fires BEFORE send, confirmed pattern in plugin SDK)
  // message_sent fires AFTER — try both to see which works
  let _debugSending = true;
  api.on("message_sending", async (event, ctx) => {
    try {
      if (_debugSending) {
        api.logger.info(`[chat-archiver] DEBUG message_sending channelId=${ctx.channelId} to=${(event as any).to}`);
        _debugSending = false;
      }
      if (!opts.archiveChannels.includes(ctx.channelId)) return;

      const rawConvId = ctx.conversationId ?? (event as any).to ?? "";
      const chatIdStr = rawConvId.includes(":") ? rawConvId.split(":").pop()! : rawConvId;
      if (!chatIdStr) return;
      const chatId = BigInt(chatIdStr);

      await insertChatMessage(sql, {
        telegramMessageId: null,
        chatId,
        senderId: null,
        senderUsername: botUsername,
        senderName: "Alice AI",
        content: event.content,
        isAgentMention: false,
        isBotReply: true,
        agentSessionKey: null,
        threadId: null,
        createdAt: new Date(),
      });

      api.logger.info(`[chat-archiver] saved bot reply (message_sending) to chat ${chatId}`);
    } catch (err) {
      api.logger.error(`[chat-archiver] message_sending error: ${err}`);
    }
  });

  api.on("message_sent", async (event, ctx) => {
    try {
      if (!opts.archiveChannels.includes(ctx.channelId)) return;
      if (!event.success) return;

      const rawConvId = ctx.conversationId ?? event.to ?? "";
      const chatIdStr = rawConvId.includes(":") ? rawConvId.split(":").pop()! : rawConvId;
      if (!chatIdStr) return;
      const chatId = BigInt(chatIdStr);

      await insertChatMessage(sql, {
        telegramMessageId: null,   // we don't get the sent message_id from Telegram here
        chatId,
        senderId: null,
        senderUsername: botUsername,
        senderName: "Alice AI",
        content: event.content,
        isAgentMention: false,
        isBotReply: true,
        agentSessionKey: null,
        threadId: null,
        createdAt: new Date(),
      });

      api.logger.info(`[chat-archiver] saved bot reply to chat ${chatId}`);
    } catch (err) {
      api.logger.error(`[chat-archiver] message_sent error: ${err}`);
    }
  });

  // ─── Incoming: all messages ────────────────────────────────────────────────
  // Correct hook name is "message_received" (underscore), not "message:received"
  // event: { from, content, timestamp?, metadata? }
  // ctx:   { channelId, accountId?, conversationId? }
  api.on(
    "message_received",
    async (event, ctx) => {
      try {
        // Filter by channel
        if (!opts.archiveChannels.includes(ctx.channelId)) return;

        const content = event.content ?? "";
        const meta = (event.metadata ?? {}) as Record<string, unknown>;

        // conversationId has "telegram:CHATID" prefix — strip it
        const rawConvId = ctx.conversationId ?? "";
        const chatIdStr = rawConvId.includes(":") ? rawConvId.split(":").pop()! : rawConvId;
        if (!chatIdStr) return;
        const chatId = BigInt(chatIdStr);

        // messageId is in metadata
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

        // timestamp is already in milliseconds
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
          createdAt: event.timestamp ? new Date(event.timestamp) : new Date(),
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
