import { readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LOCK_FILE_PATH, STATE_FILE_PATH, TMP_FILE_SUFFIX } from "../../consts/paths";
import { logger } from "../logger";

export interface StorageCleanupOptions {
  stateFilePath?: string;
  lockFilePath?: string;
  readDirectory?: (path: string) => Promise<string[]>;
  removeFile?: (path: string) => Promise<void>;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/** 持锁后清扫 state.json（含 .bak）/bot.lock 原子写中断留下的顶层临时文件。 */
export async function cleanupOrphanedTempFiles(options: StorageCleanupOptions = {}): Promise<void> {
  const stateFilePath: string = options.stateFilePath ?? STATE_FILE_PATH;
  const lockFilePath: string = options.lockFilePath ?? LOCK_FILE_PATH;
  const readDirectory: (path: string) => Promise<string[]> = options.readDirectory ?? readdir;
  const removeFile: (path: string) => Promise<void> = options.removeFile ?? unlink;
  const dir: string = dirname(stateFilePath);
  let entries: string[];
  try {
    entries = await readDirectory(dir);
  } catch (error: unknown) {
    logger.error("Failed to scan project root for orphaned temp files:", error);
    return;
  }
  const prefixes: string[] = [basename(stateFilePath), basename(lockFilePath)].map((name) => `.${name}.`);
  for (const entry of entries) {
    if (!entry.endsWith(TMP_FILE_SUFFIX) || !prefixes.some((prefix) => entry.startsWith(prefix))) continue;
    try {
      await removeFile(join(dir, entry));
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) logger.error(`Failed to remove orphaned temp file ${entry}:`, error);
    }
  }
}
