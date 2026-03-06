import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Sql } from "../db.js";
import { upsertConversation, insertAgentMessage } from "../db.js";

// Extract plain text from Claude-style content (string | ContentBlock[])
function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  }
  return String(content);
}

// Strip OpenClaw channel envelope headers from prompt
function stripEnvelope(text: string): string {
  // Envelope lines look like: [System Message], Conversation info:, etc.
  return text
    .replace(/^(\[System Message\].*\n?)/gm, "")
    .replace(/^(Conversation info.*\n?)/gm, "")
    .replace(/^(```json[\s\S]*?```\n?)/m, "")
    .trim();
}

function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  // Format: agent:main:telegram:user123 → "telegram"
  if (parts.length >= 3 && parts[0] === "agent") return parts[2];
  return "unknown";
}

export function registerAgentLogger(api: OpenClawPluginApi, sql: Sql) {
  // ─── User prompt: save when agent run starts ───────────────────────────────
  api.on(
    "before_agent_start",
    async (event, ctx) => {
      try {
        if (!event.prompt) return {};

        const sessionKey = ctx?.sessionKey ?? "unknown";
        const channel = (ctx as any)?.messageProvider ?? deriveChannel(sessionKey);

        const conv = await upsertConversation(sql, {
          sessionKey,
          channel,
          lastMessageAt: new Date(),
        });

        const rawPrompt = event.prompt;
        const strippedPrompt = stripEnvelope(rawPrompt);
        const hasEnvelope = strippedPrompt !== rawPrompt;
        const userText = strippedPrompt.trim();

        const content = hasEnvelope
          ? JSON.stringify({
              text: userText,
              envelope: rawPrompt.slice(0, rawPrompt.length - userText.length).trim(),
            })
          : userText;

        await insertAgentMessage(sql, {
          conversationId: conv.id,
          role: "user",
          content,
          metadata: hasEnvelope ? { hasEnvelope: true, sessionKey } : { sessionKey },
        });

        api.logger.info(`[agent-logger] user prompt saved for session ${sessionKey}`);
      } catch (err) {
        api.logger.error(`[agent-logger] before_agent_start error: ${err}`);
      }
      return {};
    },
    { priority: 50 }
  );

  // ─── Assistant response: save when agent run ends ──────────────────────────
  api.on(
    "agent_end",
    async (event, ctx) => {
      try {
        type Msg = { role?: string; content?: unknown };
        const messages = ((event as any).messages ?? []) as Msg[];
        const lastAssistant = messages.toReversed().find((m) => m.role === "assistant");
        if (!lastAssistant) return;

        const sessionKey = ctx?.sessionKey ?? "unknown";
        const channel = (ctx as any)?.messageProvider ?? deriveChannel(sessionKey);

        const conv = await upsertConversation(sql, {
          sessionKey,
          channel,
          lastMessageAt: new Date(),
        });

        const content = extractText(lastAssistant.content);
        if (!content) return;

        await insertAgentMessage(sql, {
          conversationId: conv.id,
          role: "assistant",
          content,
          metadata: { sessionKey },
        });

        api.logger.info(`[agent-logger] assistant response saved for session ${sessionKey}`);
      } catch (err) {
        api.logger.error(`[agent-logger] agent_end error: ${err}`);
      }
    },
    { priority: 50 }
  );
}
