import { CANDIDATE_OWNER_PID_PATTERN } from "../../consts/storage";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LOCK_FILE_PATH, STATE_FILE_PATH, TMP_FILE_SUFFIX } from "../../consts/paths";
import { PROCESS_IDENTITY_PATTERN } from "../../consts/storage";
import { isErrno } from "../../libs/errno";
import { logger } from "../logger";
import { readLinuxProcessIdentity } from "./instanceLock";
import type { ProcessIdentity } from "../../types/storage";

export interface StorageCleanupOptions {
  stateFilePath?: string;
  lockFilePath?: string;
  readDirectory?: (path: string) => Promise<string[]>;
  removeFile?: (path: string) => Promise<void>;
  isInactiveLockOwner?: (path: string) => Promise<boolean>;
}

/**
 * 按 guard candidate 文件名里的 PID 判定属主是否已死：只有 /proc 下查不到这个
 * PID 才算死。PID 被别的活进程复用、或本来就还活着时一律返回 false，因此这条
 * 兜底只可能错向「拒绝删除」，不可能删掉一个仍然活着的属主留下的文件。
 * candidate 本身也从不是已发布的 guard——cleanupOrphanedTempFiles 不扫
 * `<lock>.guard`，删掉一个 candidate 不影响任何实例锁。
 */
async function hasDeadCandidateFilenameOwner(path: string): Promise<boolean> {
  const named: RegExpExecArray | null = CANDIDATE_OWNER_PID_PATTERN.exec(basename(path));
  if (!named) return false;
  const pid: number = Number(named[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  return await readLinuxProcessIdentity(pid) === null;
}

async function hasInactiveCurrentFormatOwner(path: string): Promise<boolean> {
  const content: string = await Bun.file(path).text();
  const match: RegExpExecArray | null = PROCESS_IDENTITY_PATTERN.exec(content);
  if (!match) {
    // 0 字节孤儿：candidate 是先 `open(..., "wx")` 建空文件、再写身份行的（见
    // instanceLock.ts 的 acquirePidFileLock），这中间被 SIGKILL/OOM/掉电打断就
    // 留下这个形态。内容里什么都没有，但足以证明属主已死的 PID 就明明白白写在
    // 文件名上——只按内容判的话这种孤儿一个都回收不掉，每次启动还照着报一行
    // 「属主还活着或格式不对」，而两半都不成立。
    // 非空却认不出的内容不走这条路：那是「不认识的格式」，仍按人工修复处理。
    if (content.trim().length > 0) return false;
    return await hasDeadCandidateFilenameOwner(path);
  }
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
  removeFile = (path: string): Promise<void> => Bun.file(path).delete(),
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
          `Refusing to remove lock helper ${entry}: its owner is still active or could not be determined.`
        );
        continue;
      }
      await removeFile(path);
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) logger.error(`Failed to remove orphaned temp file ${entry}:`, error);
    }
  }
}
