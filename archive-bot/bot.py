"""
Archive Bot — writes ALL Telegram messages to openclaw_chat_messages.
Handles new messages, edits, and media.
"""
import asyncio
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

# ─── DB ───────────────────────────────────────────────────────────────────────

pool: asyncpg.Pool | None = None

async def get_pool() -> asyncpg.Pool:
    global pool
    if pool is None:
        pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    return pool

def extract_media(msg: Message) -> tuple[str | None, str | None]:
    """Returns (file_id, media_type) from a Telegram message."""
    if msg.photo:
        return msg.photo[-1].file_id, "photo"
    if msg.video:
        return msg.video.file_id, "video"
    if msg.voice:
        return msg.voice.file_id, "voice"
    if msg.audio:
        return msg.audio.file_id, "audio"
    if msg.document:
        return msg.document.file_id, "document"
    if msg.sticker:
        return msg.sticker.file_id, "sticker"
    if msg.animation:
        return msg.animation.file_id, "animation"
    if msg.video_note:
        return msg.video_note.file_id, "video_note"
    return None, None

async def insert_message(msg: Message) -> None:
    db = await get_pool()
    file_id, media_type = extract_media(msg)
    content = msg.text or msg.caption or (f"<media:{media_type}>" if media_type else None)
    sender = msg.from_user

    await db.execute("""
        INSERT INTO openclaw_chat_messages (
            telegram_message_id, chat_id,
            sender_id, sender_username, sender_name,
            content, is_agent_mention, is_bot_reply,
            media_file_id, media_type,
            created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT DO NOTHING
    """,
        msg.message_id,
        msg.chat_id,
        sender.id if sender else None,
        sender.username if sender else None,
        sender.full_name if sender else None,
        content,
        False,  # is_agent_mention — archive bot doesn't process mentions
        False,  # is_bot_reply
        file_id,
        media_type,
        msg.date,
    )
    log.info(f"INSERT chat={msg.chat_id} msg={msg.message_id} type={media_type or 'text'}")

async def update_message(msg: Message) -> None:
    db = await get_pool()
    file_id, media_type = extract_media(msg)
    content = msg.text or msg.caption or (f"<media:{media_type}>" if media_type else None)

    result = await db.execute("""
        UPDATE openclaw_chat_messages
        SET content = $1,
            media_file_id = $2,
            media_type = $3,
            edited_at = $4
        WHERE chat_id = $5 AND telegram_message_id = $6
    """,
        content, file_id, media_type, msg.edit_date,
        msg.chat_id, msg.message_id,
    )
    if result == "UPDATE 0":
        # Message was edited before we saw the original — insert it
        await insert_message(msg)
        log.info(f"UPSERT (edited before original) chat={msg.chat_id} msg={msg.message_id}")
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

async def main() -> None:
    db = await get_pool()
    log.info("DB connected")

    app = Application.builder().token(BOT_TOKEN).build()

    # All message types
    app.add_handler(MessageHandler(filters.ALL, on_message))
    # Edited messages
    app.add_handler(MessageHandler(filters.UpdateType.EDITED_MESSAGE, on_edit))
    app.add_handler(MessageHandler(filters.UpdateType.EDITED_CHANNEL_POST, on_edit))
    app.add_error_handler(on_error)

    log.info("Archive bot starting...")
    await app.run_polling(
        allowed_updates=["message", "edited_message", "channel_post", "edited_channel_post"],
        drop_pending_updates=False,
    )

if __name__ == "__main__":
    asyncio.run(main())
