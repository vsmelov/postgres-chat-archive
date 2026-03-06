"""
Archive Bot — writes ALL Telegram messages to openclaw_chat_messages.
Handles new messages, edits, and media.
"""
import logging
import os

import asyncpg
from telegram import Update, Message
from telegram.ext import Application, MessageHandler, filters, ContextTypes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

BOT_TOKEN = os.environ["ARCHIVE_BOT_TOKEN"]
DATABASE_URL = os.environ["DATABASE_URL"].replace("postgresql://", "postgres://", 1)

# ─── DB pool (initialized in post_init) ──────────────────────────────────────

pool: asyncpg.Pool | None = None

async def post_init(app: Application) -> None:
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    log.info("DB pool ready")

async def post_shutdown(app: Application) -> None:
    if pool:
        await pool.close()
        log.info("DB pool closed")

# ─── Helpers ──────────────────────────────────────────────────────────────────

def extract_media(msg: Message) -> tuple[str | None, str | None]:
    if msg.photo:        return msg.photo[-1].file_id, "photo"
    if msg.video:        return msg.video.file_id, "video"
    if msg.voice:        return msg.voice.file_id, "voice"
    if msg.audio:        return msg.audio.file_id, "audio"
    if msg.document:     return msg.document.file_id, "document"
    if msg.sticker:      return msg.sticker.file_id, "sticker"
    if msg.animation:    return msg.animation.file_id, "animation"
    if msg.video_note:   return msg.video_note.file_id, "video_note"
    return None, None

async def insert_message(msg: Message) -> None:
    file_id, media_type = extract_media(msg)
    content = msg.text or msg.caption or (f"<media:{media_type}>" if media_type else None)
    sender = msg.from_user

    await pool.execute("""
        INSERT INTO openclaw_chat_messages (
            telegram_message_id, chat_id,
            sender_id, sender_username, sender_name,
            content, is_agent_mention, is_bot_reply,
            media_file_id, media_type, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,false,false,$7,$8,$9)
        ON CONFLICT DO NOTHING
    """,
        msg.message_id, msg.chat_id,
        sender.id if sender else None,
        sender.username if sender else None,
        sender.full_name if sender else None,
        content, file_id, media_type, msg.date,
    )
    log.info(f"INSERT chat={msg.chat_id} msg={msg.message_id} type={media_type or 'text'!r}")

async def update_message(msg: Message) -> None:
    file_id, media_type = extract_media(msg)
    content = msg.text or msg.caption or (f"<media:{media_type}>" if media_type else None)

    result = await pool.execute("""
        UPDATE openclaw_chat_messages
        SET content=$1, media_file_id=$2, media_type=$3, edited_at=$4
        WHERE chat_id=$5 AND telegram_message_id=$6
    """, content, file_id, media_type, msg.edit_date, msg.chat_id, msg.message_id)

    if result == "UPDATE 0":
        await insert_message(msg)
        log.info(f"UPSERT (edited before seen) chat={msg.chat_id} msg={msg.message_id}")
    else:
        log.info(f"UPDATE (edit) chat={msg.chat_id} msg={msg.message_id}")

# ─── Handlers ─────────────────────────────────────────────────────────────────

async def on_message(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message or update.channel_post
    if msg:
        await insert_message(msg)

async def on_edit(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.edited_message or update.edited_channel_post
    if msg:
        await update_message(msg)

async def on_error(update: object, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    log.error(f"Error: {ctx.error}", exc_info=ctx.error)

# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .post_shutdown(post_shutdown)
        .build()
    )
    app.add_handler(MessageHandler(filters.ALL & ~filters.UpdateType.EDITED_MESSAGE & ~filters.UpdateType.EDITED_CHANNEL_POST, on_message))
    app.add_handler(MessageHandler(filters.UpdateType.EDITED_MESSAGE | filters.UpdateType.EDITED_CHANNEL_POST, on_edit))
    app.add_error_handler(on_error)

    log.info("Archive bot starting polling...")
    app.run_polling(
        allowed_updates=["message", "edited_message", "channel_post", "edited_channel_post"],
        drop_pending_updates=False,
    )

if __name__ == "__main__":
    main()
