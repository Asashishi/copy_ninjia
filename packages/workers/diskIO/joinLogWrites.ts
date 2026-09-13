/**
 * 入群日志的文件接管与追加写入。按 `<chatId>.<东京日期>.json` 定位文件，首次
 * 接管时严格校验并重建 latest-by-user 索引，随后按批追写或在超出单群单日容量
 * 线时原子重写整份快照。
 *
 * 路由、flush 调度与按需读取在 diskIO/joinLogFiles.ts；纯序列化与容量裁剪算法
 * 在 diskIO/joinLogRecords.ts。
 */

import {
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { BigIntStats } from "node:fs";
import {
  joinLogFileCaches,
  joinLogRetryAt,
} from "../../cache/workers/diskIO/joinLog";
import {
  JOIN_LOG_COMPACT_CHECK_BYTES,
  JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES,
  JOIN_LOG_COMPACT_REDUNDANT_ENTRIES,
  JOIN_LOG_ENTRY_SEPARATOR_BYTES,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
  JOIN_LOG_REOPEN_RETRY_MS,
} from "../../consts/diskIO/joinLog";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { JOIN_LOG_MEMORY_DIR } from "../../consts/paths";
import { atomicWriteTextChunksSync, syncDirectorySync } from "../../libs/atomicFile";
import { invalidInput } from "../../libs/inputValidation";
import type {
  AppendOnlyFileState,
  BufferedJoinLogEntry,
  JoinLogFileCache,
  JoinLogRecord,
} from "../../types/diskIO/storage";
import {
  appendToAppendOnlyFile,
  openAppendOnlyFile,
  openValidatedAppendOnlyFile,
} from "./appendOnlyDayFile";
import {
  joinLogSnapshotEntryBytes,
  joinLogSnapshotChunks,
  latestJoinLogRecords,
  measureJoinLogSnapshotBytes,
  newestBufferedJoinLogRecords,
  serializeJoinLogSnapshotEntry,
  trimJoinLogRecordsToCapacity,
} from "./joinLogRecords";
import { readValidatedJoinLogFile } from "./joinLogRecovery";
import type { ValidatedJoinLogFile } from "./joinLogRecovery";

export function joinLogPath(chatId: number, day: string): string {
  return join(JOIN_LOG_MEMORY_DIR, `${chatId}.${day}.json`);
}

export function fileKey(chatId: number, day: string): string {
  return `${chatId}:${day}`;
}

/** 取 fileKey 里的日期部分；chat id 可能带负号，日期永远在最后一个冒号之后。 */
export function dayOfFileKey(key: string): string {
  return key.slice(key.lastIndexOf(":") + 1);
}

function rewriteJoinLogFile(path: string, cache: JoinLogFileCache): void {
  const size: number = atomicWriteTextChunksSync(
    path,
    joinLogSnapshotChunks(cache.latestByUser),
    PERSISTED_FILE_MODE
  );
  if (size !== cache.snapshotBytes) {
    throw new Error(
      `Join log snapshot size mismatch: expected ${cache.snapshotBytes}, wrote ${size}.`
    );
  }
  cache.state = {
    size,
    empty: cache.latestByUser.size === 0,
  };
  cache.appendedBytesSinceCompaction = 0;
  cache.redundantEntries = 0;
}

/** 目标路径当前目录项指向的文件；不存在时为 undefined。 */
function statJoinLogFile(path: string): BigIntStats | undefined {
  return statSync(path, { bigint: true, throwIfNoEntry: false });
}

/**
 * 判断原子重写失败后目标路径是否已换成另一个文件（新快照已 rename 上去）。
 * 无法重新 stat 时按已替换处理。
 */
function joinLogFileReplaced(path: string, before: BigIntStats | undefined): boolean {
  let after: BigIntStats | undefined;
  try {
    after = statJoinLogFile(path);
  } catch {
    return true;
  }
  if (before === undefined || after === undefined) return before !== after;
  return before.ino !== after.ino || before.dev !== after.dev;
}

/**
 * 按累计计数评估并执行压缩。替换前失败只记录日志并重新累计增量；已替换时
 * 必须补齐父目录同步，失败则交由写入边界拒绝确认。持久化约束见 docs/cn/04-invariants.md。
 *
 * 原子重写在 rename 之前失败时，目标文件与 cache 均未改变，cache 继续有效；
 * rename 之后失败（目录 fsync、快照字节数不符）时目标路径已是新快照，
 * cache.state 描述的是被替换掉的文件，补齐目录同步后仍需重新接管。
 * @returns cache 是否仍描述目标路径上的文件；false 时调用方必须丢弃 cache 并从磁盘重建。
 */
function maybeCompactJoinLogFile(
  path: string,
  cache: JoinLogFileCache
): boolean {
  if (
    cache.redundantEntries < JOIN_LOG_COMPACT_REDUNDANT_ENTRIES &&
    cache.appendedBytesSinceCompaction < JOIN_LOG_COMPACT_CHECK_BYTES
  ) {
    return true;
  }
  const reclaimableBytes: number =
    cache.state.size - cache.snapshotBytes;
  if (reclaimableBytes < JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES) {
    // 本轮多数是不同用户，重写收不回空间；重新累计一段增量后再评估。
    cache.appendedBytesSinceCompaction = 0;
    cache.redundantEntries = 0;
    return true;
  }
  let sampled: boolean = false;
  let before: BigIntStats | undefined;
  try {
    before = statJoinLogFile(path);
    sampled = true;
    rewriteJoinLogFile(path, cache);
    return true;
  } catch (error: unknown) {
    cache.appendedBytesSinceCompaction = 0;
    cache.redundantEntries = 0;
    const replaced: boolean = sampled && joinLogFileReplaced(path, before);
    if (replaced) syncDirectorySync(path);
    console.error(
      `[diskIOWorker] failed to compact join log ${path}; ` +
      (replaced
        ? "the snapshot was already published, so the file will be reopened:"
        : "keeping the current file and re-evaluating after more appends:"),
      error
    );
    return !replaced;
  }
}

/**
 * 严格校验领域 schema、容量与规范追加格式后接管文件，不评估压缩；任何
 * 损坏都保留原始字节并拒绝接管。已有文件先同步父目录，再恢复 latest-by-user
 * 索引；包括此前原子替换已发布、目录同步失败后丢弃缓存的重试接管。
 */
async function takeOverJoinLogFile(path: string): Promise<JoinLogFileCache> {
  const existing: ValidatedJoinLogFile | null = await Bun.file(path).exists()
    ? await readValidatedJoinLogFile(path)
    : null;
  if (existing !== null) syncDirectorySync(path);
  const parsed: Record<string, JoinLogRecord> = existing === null
    ? {}
    : existing.parsed;
  const state: AppendOnlyFileState = existing === null
    ? await openAppendOnlyFile(path, PERSISTED_FILE_MODE)
    : openValidatedAppendOnlyFile({
      path,
      content: existing.content,
      empty: Object.keys(parsed).length === 0,
    });
  const latestByUser: Map<number, JoinLogRecord> =
    latestJoinLogRecords(parsed);
  if (latestByUser.size > JOIN_LOG_MAX_USERS_PER_CHAT_DAY) {
    return invalidInput(
      path,
      "$",
      `at most ${JOIN_LOG_MAX_USERS_PER_CHAT_DAY} distinct users per chat day`
    );
  }
  const cache: JoinLogFileCache = {
    state,
    latestByUser,
    snapshotBytes: measureJoinLogSnapshotBytes(latestByUser),
    appendedBytesSinceCompaction:
      state.size >= JOIN_LOG_COMPACT_CHECK_BYTES
        ? JOIN_LOG_COMPACT_CHECK_BYTES
        : 0,
    redundantEntries: 0,
    capacityWarningEmitted: false,
  };
  return cache;
}

/**
 * 首次接管某群某日文件，并按接管时的文件大小评估一次压缩。替换前的压缩失败
 * 不阻止接管；新快照已持久发布时再接管一次，这次不再评估压缩。
 */
async function openJoinLogFile(
  chatId: number,
  day: string
): Promise<JoinLogFileCache> {
  const path: string = joinLogPath(chatId, day);
  const cache: JoinLogFileCache = await takeOverJoinLogFile(path);
  if (maybeCompactJoinLogFile(path, cache)) return cache;
  return takeOverJoinLogFile(path);
}

/** 取该群该日的接管缓存；未接管过时先按磁盘现状严格重建。 */
export async function getJoinLogFileCache(
  chatId: number,
  day: string
): Promise<JoinLogFileCache> {
  const key: string = fileKey(chatId, day);
  const cached: JoinLogFileCache | undefined = joinLogFileCaches.get(key);
  if (cached !== undefined) return cached;
  const cache: JoinLogFileCache = await openJoinLogFile(chatId, day);
  joinLogFileCaches.set(key, cache);
  return cache;
}

/**
 * 把一个 `chatId:day` 分组的待写条目落到该文件；成功后清掉该键的退避。
 * @returns 是否已落盘；false 时调用方保留条目并按退避重试。
 */
export async function writeFileEntries(
  chatId: number,
  day: string,
  entries: readonly BufferedJoinLogEntry[]
): Promise<boolean> {
  if (entries.length === 0) return true;
  mkdirSync(JOIN_LOG_MEMORY_DIR, { recursive: true });
  const key: string = fileKey(chatId, day);
  const path: string = joinLogPath(chatId, day);
  const now: number = Date.now();
  if (!joinLogFileCaches.has(key) && now < (joinLogRetryAt.get(key) ?? 0)) {
    return false;
  }
  try {
    const cache: JoinLogFileCache = await getJoinLogFileCache(chatId, day);
    const newest: BufferedJoinLogEntry[] =
      newestBufferedJoinLogRecords(entries, cache.latestByUser);
    if (newest.length === 0) {
      joinLogRetryAt.delete(key);
      return true;
    }

    let newUsers: number = 0;
    for (const entry of newest) {
      if (!cache.latestByUser.has(entry.record.userId)) newUsers++;
    }
    if (
      cache.latestByUser.size + newUsers >
      JOIN_LOG_MAX_USERS_PER_CHAT_DAY
    ) {
      for (const entry of newest) {
        const current: JoinLogRecord | undefined =
          cache.latestByUser.get(entry.record.userId);
        const nextBytes: number =
          joinLogSnapshotEntryBytes(entry.record);
        cache.snapshotBytes += current === undefined
          ? JOIN_LOG_ENTRY_SEPARATOR_BYTES + nextBytes
          : nextBytes - joinLogSnapshotEntryBytes(current);
        cache.latestByUser.set(entry.record.userId, entry.record);
      }
      const evicted: number = trimJoinLogRecordsToCapacity(
        cache.latestByUser,
        JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
        (record: JoinLogRecord): void => {
          cache.snapshotBytes -=
            JOIN_LOG_ENTRY_SEPARATOR_BYTES + joinLogSnapshotEntryBytes(record);
        }
      );
      // 先改可丢弃的内存索引、再原子发布；失败时 catch 丢掉索引并从未改变的
      // 权威文件重建，因此无需复制整张 Map 作为回滚副本。
      rewriteJoinLogFile(path, cache);
      if (!cache.capacityWarningEmitted) {
        cache.capacityWarningEmitted = true;
        console.error(
          `[diskIOWorker] join log for chat ${chatId} on ${day} exceeded ` +
          `${JOIN_LOG_MAX_USERS_PER_CHAT_DAY} users; retained the newest records and evicted ${evicted}.`
        );
      }
      joinLogRetryAt.delete(key);
      return true;
    }

    const texts: string[] = [];
    for (const entry of newest) {
      texts.push(serializeJoinLogSnapshotEntry(entry.record));
    }
    const chunk: string = texts.join(",\n");
    await appendToAppendOnlyFile({
      path,
      state: cache.state,
      chunk,
      mode: PERSISTED_FILE_MODE,
    });
    cache.appendedBytesSinceCompaction += Buffer.byteLength(chunk);
    // 索引记账复用上面已经序列化好的 texts：每条记录的快照字节数就是它自己那
    // 段文本的长度，重新调用 joinLogSnapshotEntryBytes 等于把整批再序列化一遍。
    for (let index: number = 0; index < newest.length; index += 1) {
      const record: JoinLogRecord = newest[index]!.record;
      const current: JoinLogRecord | undefined =
        cache.latestByUser.get(record.userId);
      const nextBytes: number = Buffer.byteLength(texts[index]!);
      if (current !== undefined) {
        cache.redundantEntries++;
        cache.snapshotBytes +=
          nextBytes - joinLogSnapshotEntryBytes(current);
      } else {
        cache.snapshotBytes += JOIN_LOG_ENTRY_SEPARATOR_BYTES + nextBytes;
      }
      cache.latestByUser.set(record.userId, record);
    }
    // 追加和可能发生的快照替换均已持久化后才确认；替换后缓存需重新接管。
    if (!maybeCompactJoinLogFile(path, cache)) joinLogFileCaches.delete(key);
    joinLogRetryAt.delete(key);
    return true;
  } catch (error: unknown) {
    joinLogFileCaches.delete(key);
    joinLogRetryAt.set(key, now + JOIN_LOG_REOPEN_RETRY_MS);
    console.error("[diskIOWorker] failed to persist join log:", error);
    return false;
  }
}
