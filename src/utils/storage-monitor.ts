import fs from "node:fs";
import path from "node:path";
import type { Sql } from "../db.js";
import {
  getOldestMediaForCleanup,
  markMediaDeleted,
  insertStorageStat,
} from "../db.js";

function getDirSizeBytes(dir: string): { totalBytes: number; fileCount: number } {
  if (!fs.existsSync(dir)) return { totalBytes: 0, fileCount: 0 };

  let totalBytes = 0;
  let fileCount = 0;

  function walk(current: string) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          totalBytes += fs.statSync(full).size;
          fileCount++;
        } catch {}
      }
    }
  }

  walk(dir);
  return { totalBytes, fileCount };
}

export async function runStorageMonitor(
  sql: Sql,
  opts: {
    mediaStoragePath: string;
    maxStorageGb: number;
    logger: { info: Function; warn: Function; error: Function };
  }
) {
  const maxBytes = opts.maxStorageGb * 1024 * 1024 * 1024;
  const { totalBytes, fileCount } = getDirSizeBytes(opts.mediaStoragePath);
  const usedGb = (totalBytes / 1024 / 1024 / 1024).toFixed(2);

  opts.logger.info(
    `[storage-monitor] Used: ${usedGb}GB / ${opts.maxStorageGb}GB (${fileCount} files)`
  );

  let deletedCount = 0;
  let currentSize = totalBytes;

  if (currentSize > maxBytes) {
    opts.logger.warn(
      `[storage-monitor] Over quota! ${usedGb}GB > ${opts.maxStorageGb}GB — cleaning up oldest files`
    );

    // Delete oldest files in batches until under quota
    while (currentSize > maxBytes * 0.9) {
      // Clean to 90% of limit
      const batch = await getOldestMediaForCleanup(sql, 20);
      if (batch.length === 0) break;

      for (const file of batch) {
        try {
          if (file.local_path && fs.existsSync(file.local_path)) {
            const size = fs.statSync(file.local_path).size;
            fs.unlinkSync(file.local_path);
            currentSize -= size;
            deletedCount++;
          }
          await markMediaDeleted(sql, file.id);
        } catch (err) {
          opts.logger.error(`[storage-monitor] failed to delete ${file.local_path}: ${err}`);
        }
      }
    }

    opts.logger.info(
      `[storage-monitor] Cleanup done: deleted ${deletedCount} files, freed ${((totalBytes - currentSize) / 1024 / 1024).toFixed(1)}MB`
    );
  }

  await insertStorageStat(sql, {
    totalSizeBytes: currentSize,
    fileCount: fileCount - deletedCount,
    deletedCount,
  });
}
