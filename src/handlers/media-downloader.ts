import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import type { Sql } from "../db.js";
import {
  getPendingMediaDownloads,
  markMediaDownloaded,
  markMediaError,
} from "../db.js";

async function downloadFile(url: string, destPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          const size = fs.statSync(destPath).size;
          resolve(size);
        });
      })
      .on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

async function getTelegramFileUrl(
  fileId: string,
  botToken: string
): Promise<{ url: string; filePath: string }> {
  const apiUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
  const response = await fetch(apiUrl);
  const data = (await response.json()) as {
    ok: boolean;
    result?: { file_path?: string };
    description?: string;
  };

  if (!data.ok || !data.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${data.description ?? "unknown"}`);
  }

  return {
    url: `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`,
    filePath: data.result.file_path,
  };
}

function getLocalPath(
  mediaStoragePath: string,
  chatId: bigint | number,
  fileType: string,
  telegramFilePath: string
): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const ext = path.extname(telegramFilePath) || `.${fileType}`;
  const basename = path.basename(telegramFilePath, path.extname(telegramFilePath));
  return path.join(mediaStoragePath, String(chatId), date, `${fileType}_${basename}${ext}`);
}

export async function runMediaDownloader(
  sql: Sql,
  opts: { botToken: string; mediaStoragePath: string; logger: { info: Function; error: Function; debug: Function } }
) {
  const pending = await getPendingMediaDownloads(sql, 10);
  if (pending.length === 0) return;

  opts.logger.info(`[media-downloader] ${pending.length} files to download`);

  for (const media of pending) {
    try {
      const { url, filePath } = await getTelegramFileUrl(media.file_id, opts.botToken);
      const localPath = getLocalPath(
        opts.mediaStoragePath,
        media.chat_id,
        media.file_type,
        filePath
      );

      const fileSize = await downloadFile(url, localPath);
      await markMediaDownloaded(sql, media.id, localPath, fileSize);

      opts.logger.info(
        `[media-downloader] downloaded ${media.file_type} → ${localPath} (${fileSize} bytes)`
      );
    } catch (err) {
      opts.logger.error(`[media-downloader] failed to download ${media.file_id}: ${err}`);
      await markMediaError(sql, media.id, String(err));
    }
  }
}
