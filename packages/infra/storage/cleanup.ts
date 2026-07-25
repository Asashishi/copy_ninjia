import { readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LOCK_FILE_PATH, STATE_FILE_PATH, TMP_FILE_SUFFIX } from "../../consts/paths";
import { PROCESS_IDENTITY_PATTERN } from "../../consts/storage";
import { logger } from "../logger";
import { readLinuxProcessIdentity, type ProcessIdentity } from "./instanceLock";

export interface StorageCleanupOptions {
  stateFilePath?: string;
  lockFilePath?: string;
  readDirectory?: (path: string) => Promise<string[]>;
  removeFile?: (path: string) => Promise<void>;
  isInactiveLockOwner?: (path: string) => Promise<boolean>;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function hasInactiveCurrentFormatOwner(path: string): Promise<boolean> {
  const content: string = await readFile(path, "utf8");
  const match: RegExpExecArray | null = PROCESS_IDENTITY_PATTERN.exec(content);
  if (!match) return false;
  const owner: ProcessIdentity = {
    pid: Number(match[1]),
    startTimeTicks: match[2]!,
    bootId: match[3]!,
  };
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  const active: ProcessIdentity | null = await readLinuxProcessIdentity(owner.pid);
  return active?.pid !== owner.pid ||
    active?.startTimeTicks !== owner.startTimeTicks ||
    active?.bootId !== owner.bootId;
}

/** 持锁后清扫 state.json（含 .bak）/bot.lock 原子写中断留下的顶层临时文件。 */
export async function cleanupOrphanedTempFiles({
  stateFilePath = STATE_FILE_PATH,
  lockFilePath = LOCK_FILE_PATH,
  readDirectory = readdir,
  removeFile = unlink,
  isInactiveLockOwner = hasInactiveCurrentFormatOwner,
}: StorageCleanupOptions = {}): Promise<void> {
  const dir: string = dirname(stateFilePath);
  let entries: string[];
  try {
    entries = await readDirectory(dir);
  } catch (error: unknown) {
    logger.error("Failed to scan project root for orphaned temp files:", error);
    return;
  }
  const prefixes: string[] = [basename(stateFilePath), basename(lockFilePath)].map((name: string): string => `.${name}.`);
  const escapedLockName: string = basename(lockFilePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const guardCandidatePattern: RegExp = new RegExp(
    `^${escapedLockName}\\.guard\\.candidate\\.[1-9]\\d*\\.` +
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
  );
  const guardRecoveryName: string = `${basename(lockFilePath)}.guard.recovery`;
  for (const entry of entries) {
    const isAtomicTemp: boolean = entry.endsWith(TMP_FILE_SUFFIX) &&
      prefixes.some((prefix: string): boolean => entry.startsWith(prefix));
    const isGuardOrphan: boolean = entry === guardRecoveryName || guardCandidatePattern.test(entry);
    if (!isAtomicTemp && !isGuardOrphan) continue;
    const path: string = join(dir, entry);
    try {
      if (isGuardOrphan && !await isInactiveLockOwner(path)) {
        logger.error(
          `Refusing to remove lock helper ${entry}: owner is active or not in the current strict format.`
        );
        continue;
      }
      await removeFile(path);
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) logger.error(`Failed to remove orphaned temp file ${entry}:`, error);
    }
  }
}
