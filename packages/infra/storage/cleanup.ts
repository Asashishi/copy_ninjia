import { CANDIDATE_OWNER_PID_PATTERN, PROCESS_IDENTITY_PATTERN } from "../../consts/storage";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { GLOBAL_STATE_FILE_PATH, LOCK_FILE_PATH, TMP_FILE_SUFFIX } from "../../consts/paths";
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
    // 0 字节孤儿：candidate 先 `open(..., "wx")` 建空文件、再写身份行（见
    // instanceLock.ts 的 acquirePidFileLock），中途被 SIGKILL/OOM/掉电打断会留下
    // 这个形态。内容为空，属主 PID 写在文件名上，因此按文件名判定。非空却认不出
    // 的内容不走这条路，仍按人工修复处理。
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

/** 一个待清扫目录：只认其中这些目标文件的原子写临时件，lockFileName 非 null 时也认锁的辅助文件。 */
interface CleanupDirectory {
  readonly directory: string;
  readonly atomicTempPrefixes: readonly string[];
  readonly lockFileName: string | null;
}

/** 按目录归并状态文件与锁文件；两者同目录时合成一项。 */
function cleanupDirectories(stateFilePath: string, lockFilePath: string): readonly CleanupDirectory[] {
  const lockDirectory: CleanupDirectory = {
    directory: dirname(lockFilePath),
    atomicTempPrefixes: [`.${basename(lockFilePath)}.`],
    lockFileName: basename(lockFilePath),
  };
  const statePrefix: string = `.${basename(stateFilePath)}.`;
  if (dirname(stateFilePath) === lockDirectory.directory) {
    return [{ ...lockDirectory, atomicTempPrefixes: [statePrefix, ...lockDirectory.atomicTempPrefixes] }];
  }
  return [
    lockDirectory,
    { directory: dirname(stateFilePath), atomicTempPrefixes: [statePrefix], lockFileName: null },
  ];
}

/**
 * 持锁后清扫全局状态文件（memory/global/）与 bot.lock（数据根）原子写中断留下的临时文件，
 * 以及锁的孤儿辅助文件。目录尚不存在时跳过。
 */
export async function cleanupOrphanedTempFiles({
  stateFilePath = GLOBAL_STATE_FILE_PATH,
  lockFilePath = LOCK_FILE_PATH,
  readDirectory = readdir,
  removeFile = (path: string): Promise<void> => Bun.file(path).delete(),
  isInactiveLockOwner = hasInactiveCurrentFormatOwner,
}: StorageCleanupOptions = {}): Promise<void> {
  for (const target of cleanupDirectories(stateFilePath, lockFilePath)) {
    let entries: string[];
    try {
      entries = await readDirectory(target.directory);
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) {
        logger.error(`Failed to scan ${target.directory} for orphaned temp files:`, error);
      }
      continue;
    }
    const lockFileName: string | null = target.lockFileName;
    const guardCandidatePattern: RegExp | null = lockFileName === null ? null : new RegExp(
      `^${lockFileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.guard\\.candidate\\.[1-9]\\d*\\.` +
      "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    );
    for (const entry of entries) {
      const isAtomicTemp: boolean = entry.endsWith(TMP_FILE_SUFFIX) &&
        target.atomicTempPrefixes.some((prefix: string): boolean => entry.startsWith(prefix));
      const isGuardOrphan: boolean = lockFileName !== null &&
        (entry === `${lockFileName}.guard.recovery` || guardCandidatePattern?.test(entry) === true);
      if (!isAtomicTemp && !isGuardOrphan) continue;
      const path: string = join(target.directory, entry);
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
}
