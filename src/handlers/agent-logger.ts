import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Sql } from "../db.js";
import { upsertConversation, insertAgentMessage } from "../db.js";

// Extract plain text from Claude-style content (string | ContentBlock[])
function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as any[])
      .filter((b) => b?.type === "text" && typeof b?.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return String(content);
}

export function registerAgentLogger(api: OpenClawPluginApi, sql: Sql) {
  // Use llm_input / llm_output instead of before_agent_start / agent_end
  // because they have runId for deduplication and fire exactly once per LLM call

  // Track runIds we've already saved to avoid duplicates
  const savedRunIds = new Set<string>();
  // Limit size to avoid memory leak
  const MAX_SAVED = 500;

  // ─── LLM Input: save user prompt + full context ────────────────────────────
  api.on("llm_input", async (event, ctx) => {
    try {
      // Deduplicate by runId
      if (savedRunIds.has(event.runId)) return;
      if (savedRunIds.size > MAX_SAVED) {
        const first = savedRunIds.values().next().value;
        savedRunIds.delete(first);
      }
      savedRunIds.add(event.runId);

      const sessionKey = ctx.sessionKey ?? event.sessionId ?? "unknown";
      const channel = ctx.messageProvider ?? "unknown";

      const conv = await upsertConversation(sql, {
        sessionKey,
        channel,
        lastMessageAt: new Date(),
      });

      await insertAgentMessage(sql, {
        conversationId: conv.id,
        role: "user",
        content: event.prompt,
        metadata: {
          runId: event.runId,
          sessionId: event.sessionId,
          provider: event.provider,
          model: event.model,
          imagesCount: event.imagesCount,
          historyMessagesCount: event.historyMessages?.length ?? 0,
        },
      });

      api.logger.info(
        `[agent-logger] user prompt saved runId=${event.runId} session=${sessionKey}`
      );
    } catch (err) {
      api.logger.error(`[agent-logger] llm_input error: ${err}`);
    }
  });

  // ─── LLM Output: save assistant response ──────────────────────────────────
  api.on("llm_output", async (event, ctx) => {
    try {
      const sessionKey = ctx.sessionKey ?? event.sessionId ?? "unknown";
      const channel = ctx.messageProvider ?? "unknown";

      const conv = await upsertConversation(sql, {
        sessionKey,
        channel,
        lastMessageAt: new Date(),
      });

      const content = event.assistantTexts?.join("\n") ?? extractText(event.lastAssistant);
      if (!content) return;

      await insertAgentMessage(sql, {
        conversationId: conv.id,
        role: "assistant",
        content,
        metadata: {
          runId: event.runId,
          sessionId: event.sessionId,
          provider: event.provider,
          model: event.model,
          usage: event.usage,
        },
      });

      api.logger.info(
        `[agent-logger] assistant response saved runId=${event.runId} session=${sessionKey}`
      );
    } catch (err) {
      api.logger.error(`[agent-logger] llm_output error: ${err}`);
    }
  });

  // ─── Gateway stop: close DB cleanly ───────────────────────────────────────
  api.on("gateway_stop", async () => {
    savedRunIds.clear();
  });
}
