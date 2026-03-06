import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function createPgClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

// ─── Conversations ────────────────────────────────────────────────────────────

export async function upsertConversation(
  sql: Sql,
  params: { sessionKey: string; channel: string; lastMessageAt: Date }
) {
  const [row] = await sql`
    INSERT INTO openclaw_conversations (session_key, channel, last_message_at)
    VALUES (${params.sessionKey}, ${params.channel}, ${params.lastMessageAt})
    ON CONFLICT (session_key) DO UPDATE
      SET last_message_at = EXCLUDED.last_message_at
    RETURNING id, session_key
  `;
  return row as { id: number; session_key: string };
}

// ─── Agent messages ───────────────────────────────────────────────────────────

export async function insertAgentMessage(
  sql: Sql,
  params: {
    conversationId: number;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    metadata?: Record<string, unknown>;
  }
) {
  await sql`
    INSERT INTO openclaw_agent_messages (conversation_id, role, content, metadata)
    VALUES (
      ${params.conversationId},
      ${params.role},
      ${params.content},
      ${params.metadata ? sql.json(params.metadata) : null}
    )
  `;
}

// ─── Chat messages ────────────────────────────────────────────────────────────

export async function insertChatMessage(
  sql: Sql,
  params: {
    telegramMessageId?: bigint | number | null;
    chatId: bigint | number;
    senderId?: bigint | number | null;
    senderUsername?: string | null;
    senderName?: string | null;
    content?: string | null;
    isAgentMention: boolean;
    isBotReply?: boolean;
    agentSessionKey?: string | null;
    threadId?: bigint | number | null;
    createdAt?: Date;
  }
) {
  const [row] = await sql`
    INSERT INTO openclaw_chat_messages (
      telegram_message_id, chat_id, sender_id, sender_username, sender_name,
      content, is_agent_mention, is_bot_reply, agent_session_key, thread_id, created_at
    ) VALUES (
      ${params.telegramMessageId ?? null},
      ${params.chatId},
      ${params.senderId ?? null},
      ${params.senderUsername ?? null},
      ${params.senderName ?? null},
      ${params.content ?? null},
      ${params.isAgentMention},
      ${params.isBotReply ?? false},
      ${params.agentSessionKey ?? null},
      ${params.threadId ?? null},
      ${params.createdAt ?? new Date()}
    )
    ON CONFLICT (chat_id, telegram_message_id) WHERE telegram_message_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  return row as { id: number } | undefined;
}

// ─── Media ───────────────────────────────────────────────────────────────────

export async function insertMedia(
  sql: Sql,
  params: {
    fileId: string;
    fileType: string;
    fileSize?: number | null;
    mimeType?: string | null;
    chatId?: bigint | number | null;
    messageId?: number | null;
  }
) {
  const [row] = await sql`
    INSERT INTO openclaw_media (file_id, file_type, file_size, mime_type, chat_id, message_id)
    VALUES (
      ${params.fileId},
      ${params.fileType},
      ${params.fileSize ?? null},
      ${params.mimeType ?? null},
      ${params.chatId ?? null},
      ${params.messageId ?? null}
    )
    ON CONFLICT (file_id) DO NOTHING
    RETURNING id
  `;
  return row as { id: number } | undefined;
}

export async function getPendingMediaDownloads(sql: Sql, limit = 10) {
  return sql<
    { id: number; file_id: string; file_type: string; chat_id: bigint }[]
  >`
    SELECT id, file_id, file_type, chat_id
    FROM openclaw_media
    WHERE local_path IS NULL
      AND deleted_at IS NULL
      AND (download_error IS NULL OR retry_count < 3)
    ORDER BY id ASC
    LIMIT ${limit}
  `;
}

export async function markMediaDownloaded(
  sql: Sql,
  id: number,
  localPath: string,
  fileSize: number
) {
  await sql`
    UPDATE openclaw_media
    SET local_path = ${localPath},
        file_size = ${fileSize},
        downloaded_at = now(),
        download_error = NULL
    WHERE id = ${id}
  `;
}

export async function markMediaError(sql: Sql, id: number, error: string) {
  await sql`
    UPDATE openclaw_media
    SET download_error = ${error},
        retry_count = retry_count + 1
    WHERE id = ${id}
  `;
}

export async function getOldestMediaForCleanup(sql: Sql, limit = 50) {
  return sql<{ id: number; local_path: string; file_size: bigint }[]>`
    SELECT id, local_path, file_size
    FROM openclaw_media
    WHERE local_path IS NOT NULL
      AND deleted_at IS NULL
    ORDER BY downloaded_at ASC
    LIMIT ${limit}
  `;
}

export async function markMediaDeleted(sql: Sql, id: number) {
  await sql`
    UPDATE openclaw_media
    SET deleted_at = now(), local_path = NULL
    WHERE id = ${id}
  `;
}

export async function insertStorageStat(
  sql: Sql,
  params: { totalSizeBytes: number; fileCount: number; deletedCount: number }
) {
  await sql`
    INSERT INTO openclaw_storage_stats (total_size_bytes, file_count, deleted_count)
    VALUES (${params.totalSizeBytes}, ${params.fileCount}, ${params.deletedCount})
  `;
}
