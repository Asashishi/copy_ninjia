/**
 * 滚动 24 小时入群事实的追加日志。文件按 `<chatId>.<东京日期>.json` 分开，
 * 写入沿用 appendOnlyDayFile.ts 的 JSON 对象末尾追写机制；启动恢复不扫描目录，
 * 只有首条入群事实或 `/batch_kick` 查询才接管相关文件。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  consumeJoinLogRejection,
  joinLogBuffer,
  joinLogCleanupDay,
  joinLogFileCaches,
  joinLogRetryAt,
  markJoinLogDirty,
} from "../../cache/workers/diskIO/joinLog";
import {
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_ENTRIES,
} from "../../consts/diskIO/appendOnly";
import {
  JOIN_LOG_ACCEPTED_EVENT_DAYS,
  JOIN_LOG_COMPACT_CHECK_BYTES,
  JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES,
  JOIN_LOG_COMPACT_REDUNDANT_ENTRIES,
  JOIN_LOG_FILE_PATTERN,
  JOIN_LOG_FILE_RETENTION_DAYS,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
  JOIN_LOG_REOPEN_RETRY_MS,
} from "../../consts/diskIO/joinLog";
import {
  DAY_MS,
  PERSISTED_FILE_MODE,
} from "../../consts/diskIO/common";
import { JOIN_LOG_MEMORY_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import { atomicWriteTextChunksSync } from "../../libs/atomicFile";
import { getTokyoDateKey } from "../../libs/time";
import type {
  JoinLogDiskMessage,
  ReadJoinLogRequest,
} from "../../types/diskIO";
import type {
  AppendOnlyFileState,
  BufferedJoinLogEntry,
  JoinLogFileCache,
  JoinLogRecord,
} from "../../types/diskIO/storage";
import {
  appendToAppendOnlyFile,
  openAppendOnlyFile,
} from "./appendOnlyDayFile";
import {
  assertJoinLogSchema,
  isRecentJoinLogDay,
  joinLogSnapshotEntryBytes,
  joinLogSnapshotChunks,
  latestJoinLogRecords,
  measureJoinLogSnapshotBytes,
  recentJoinLogDayKeys,
  serializeJoinLogSnapshotEntry,
  trimJoinLogRecordsToCapacity,
} from "./joinLogRecords";

function joinLogPath(chatId: number, day: string): string {
  return join(JOIN_LOG_MEMORY_DIR, `${chatId}.${day}.json`);
}

function fileKey(chatId: number, day: string): string {
  return `${chatId}:${day}`;
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

function maybeCompactJoinLogFile(
  path: string,
  cache: JoinLogFileCache
): void {
  if (
    cache.redundantEntries < JOIN_LOG_COMPACT_REDUNDANT_ENTRIES &&
    cache.appendedBytesSinceCompaction < JOIN_LOG_COMPACT_CHECK_BYTES
  ) {
    return;
  }
  const reclaimableBytes: number =
    cache.state.size - cache.snapshotBytes;
  if (reclaimableBytes < JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES) {
    // 本轮多数是不同用户，重写收不回空间；重新累计一段增量后再评估。
    cache.appendedBytesSinceCompaction = 0;
    cache.redundantEntries = 0;
    return;
  }
  rewriteJoinLogFile(path, cache);
}

/**
 * 首次接管某群某日文件时校验领域 schema；截断文件可由通用追写层裁掉最后
 * 一条残片，但可解析的错误结构必须原样拒绝。成功后恢复 latest-by-user 索引。
 */
function openJoinLogFile(chatId: number, day: string): JoinLogFileCache {
  const path: string = joinLogPath(chatId, day);
  let parsed: Record<string, JoinLogRecord> = {};
  let schemaValidated: boolean = false;
  if (existsSync(path)) {
    const content: string = readFileSync(path, "utf8");
    try {
      const candidate: unknown = JSON.parse(content);
      assertJoinLogSchema(path, candidate);
      parsed = candidate;
      schemaValidated = true;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const state: AppendOnlyFileState =
    openAppendOnlyFile(path, PERSISTED_FILE_MODE);
  if (!schemaValidated && existsSync(path)) {
    const candidate: unknown = JSON.parse(readFileSync(path, "utf8"));
    assertJoinLogSchema(path, candidate);
    parsed = candidate;
  }
  const latestByUser: Map<number, JoinLogRecord> =
    latestJoinLogRecords(parsed);
  const evicted: number = trimJoinLogRecordsToCapacity(
    latestByUser,
    JOIN_LOG_MAX_USERS_PER_CHAT_DAY
  );
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
  if (evicted > 0) {
    rewriteJoinLogFile(path, cache);
    cache.capacityWarningEmitted = true;
    console.error(
      `[diskIOWorker] join log for chat ${chatId} on ${day} exceeded ` +
      `${JOIN_LOG_MAX_USERS_PER_CHAT_DAY} users while opening; retained ` +
      `the newest records and evicted ${evicted}.`
    );
  }
  maybeCompactJoinLogFile(path, cache);
  return cache;
}

function getJoinLogFileCache(
  chatId: number,
  day: string
): JoinLogFileCache {
  const key: string = fileKey(chatId, day);
  const cached: JoinLogFileCache | undefined = joinLogFileCaches.get(key);
  if (cached !== undefined) return cached;
  const cache: JoinLogFileCache = openJoinLogFile(chatId, day);
  joinLogFileCaches.set(key, cache);
  return cache;
}

/** 按文件名清掉保留窗口以外的入群日志和遗留临时文件，不读取日志内容。 */
function cleanupExpiredDays(today: string): void {
  mkdirSync(JOIN_LOG_MEMORY_DIR, { recursive: true });
  const retainedDays: ReadonlySet<string> =
    recentJoinLogDayKeys(today, JOIN_LOG_FILE_RETENTION_DAYS);
  for (const name of readdirSync(JOIN_LOG_MEMORY_DIR)) {
    const path: string = join(JOIN_LOG_MEMORY_DIR, name);
    if (name.endsWith(TMP_FILE_SUFFIX)) {
      try {
        unlinkSync(path);
      } catch {
        // 权限异常不阻断当天记录；下一次跨日清理仍会重试。
      }
      continue;
    }
    const match: RegExpExecArray | null = JOIN_LOG_FILE_PATTERN.exec(name);
    if (match === null || retainedDays.has(match[2]!)) continue;
    try {
      unlinkSync(path);
      const key: string = fileKey(Number(match[1]!), match[2]!);
      joinLogFileCaches.delete(key);
      joinLogRetryAt.delete(key);
    } catch {
      // 清理失败不应丢掉窗口内入群事实；旧文件留给下一次跨日清理重试。
    }
  }
  joinLogCleanupDay.current = today;
}

function ensureCurrentDayPrepared(today: string): void {
  if (joinLogCleanupDay.current === today) return;
  // 先提交跨日前仍在缓冲中的记录，再清理保留窗口外文件，不能先删后刷。
  if (!flushJoinLogBuffer()) {
    throw new Error("Failed to flush join logs before day rollover cleanup.");
  }
  cleanupExpiredDays(today);
}

function newestBufferedRecords(
  entries: readonly BufferedJoinLogEntry[],
  persisted: ReadonlyMap<number, JoinLogRecord>
): BufferedJoinLogEntry[] {
  const newestByUser: Map<number, BufferedJoinLogEntry> = new Map();
  for (const entry of entries) {
    const candidate: BufferedJoinLogEntry | undefined =
      newestByUser.get(entry.record.userId);
    if (
      candidate === undefined ||
      entry.record.joinedAt > candidate.record.joinedAt
    ) {
      newestByUser.set(entry.record.userId, entry);
    }
  }
  const newest: BufferedJoinLogEntry[] = [];
  for (const entry of newestByUser.values()) {
    const current: JoinLogRecord | undefined =
      persisted.get(entry.record.userId);
    if (current === undefined || entry.record.joinedAt > current.joinedAt) {
      newest.push(entry);
    }
  }
  return newest;
}

function writeFileEntries(
  chatId: number,
  day: string,
  entries: readonly BufferedJoinLogEntry[]
): boolean {
  if (entries.length === 0) return true;
  mkdirSync(JOIN_LOG_MEMORY_DIR, { recursive: true });
  const key: string = fileKey(chatId, day);
  const path: string = joinLogPath(chatId, day);
  const now: number = Date.now();
  if (!joinLogFileCaches.has(key) && now < (joinLogRetryAt.get(key) ?? 0)) {
    return false;
  }
  try {
    const cache: JoinLogFileCache = getJoinLogFileCache(chatId, day);
    const newest: BufferedJoinLogEntry[] =
      newestBufferedRecords(entries, cache.latestByUser);
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
          ? Buffer.byteLength(",\n") + nextBytes
          : nextBytes - joinLogSnapshotEntryBytes(current);
        cache.latestByUser.set(entry.record.userId, entry.record);
      }
      const evicted: number = trimJoinLogRecordsToCapacity(
        cache.latestByUser,
        JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
        (record: JoinLogRecord): void => {
          cache.snapshotBytes -=
            Buffer.byteLength(",\n") + joinLogSnapshotEntryBytes(record);
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
    appendToAppendOnlyFile({
      path,
      state: cache.state,
      chunk,
      mode: PERSISTED_FILE_MODE,
    });
    cache.appendedBytesSinceCompaction += Buffer.byteLength(chunk);
    for (const entry of newest) {
      const current: JoinLogRecord | undefined =
        cache.latestByUser.get(entry.record.userId);
      const nextBytes: number = joinLogSnapshotEntryBytes(entry.record);
      if (current !== undefined) {
        cache.redundantEntries++;
        cache.snapshotBytes +=
          nextBytes - joinLogSnapshotEntryBytes(current);
      } else {
        cache.snapshotBytes += Buffer.byteLength(",\n") + nextBytes;
      }
      cache.latestByUser.set(entry.record.userId, entry.record);
    }
    maybeCompactJoinLogFile(path, cache);
    joinLogRetryAt.delete(key);
    return true;
  } catch (error: unknown) {
    joinLogFileCaches.delete(key);
    joinLogRetryAt.set(key, now + JOIN_LOG_REOPEN_RETRY_MS);
    console.error("[diskIOWorker] failed to persist join log:", error);
    return false;
  }
}

function scheduleJoinLogFlush(delayMs: number = FLUSH_INTERVAL_MS): void {
  if (joinLogBuffer.timer !== null) return;
  joinLogBuffer.timer = setTimeout((): void => {
    joinLogBuffer.timer = null;
    flushJoinLogBuffer();
  }, delayMs);
  joinLogBuffer.timer.unref();
}

/** 立即把所有群的待写入群事实按目标文件分组追写；失败分组原样保留并退避。 */
export function flushJoinLogBuffer(): boolean {
  if (joinLogBuffer.timer !== null) {
    clearTimeout(joinLogBuffer.timer);
    joinLogBuffer.timer = null;
  }
  if (joinLogBuffer.entries.length === 0) return true;
  const entries: BufferedJoinLogEntry[] = joinLogBuffer.entries;
  joinLogBuffer.entries = [];
  const groups: Map<string, {
    chatId: number;
    day: string;
    entries: BufferedJoinLogEntry[];
  }> = new Map();
  for (const entry of entries) {
    const key: string = fileKey(entry.chatId, entry.day);
    let group: {
      chatId: number;
      day: string;
      entries: BufferedJoinLogEntry[];
    } | undefined = groups.get(key);
    if (group === undefined) {
      group = {
        chatId: entry.chatId,
        day: entry.day,
        entries: [],
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }

  const failedEntries: BufferedJoinLogEntry[] = [];
  for (const group of groups.values()) {
    if (!writeFileEntries(group.chatId, group.day, group.entries)) {
      failedEntries.push(...group.entries);
    }
  }
  if (failedEntries.length === 0) return true;
  // flush 是同步 owner，新消息不能在循环中插入；仍使用 prepend 语义明确保证
  // 失败的旧事实排在未来新事实之前。
  joinLogBuffer.entries = failedEntries.concat(joinLogBuffer.entries);
  scheduleJoinLogFlush(JOIN_LOG_REOPEN_RETRY_MS);
  return false;
}

/**
 * 统一 flush 的 joinLog 领域出口：缓冲全部写盘成功、且这一轮没有被拒收的入群
 * 事实，才算该领域落盘成功。
 *
 * 与 flushJoinLogBuffer 分开的理由：跨日准备与按需读取用后者判断的是「缓冲里
 * 这些条目写进去了没有」，不能被一条压根没进缓冲的事实反复卡住（那会让每一条
 * 新入群事件都在同一个跨日检查上抛错）。拒收标记只在这一个出口消费。
 */
export function flushJoinLogDomain(): boolean {
  const flushed: boolean = flushJoinLogBuffer();
  return consumeJoinLogRejection() ? false : flushed;
}

/**
 * 缓冲一条仍可能落在滚动 24 小时窗口内的入群事件。
 *
 * 本函数不吞异常：调用方（diskIOWorker 的 joinLog 分支）负责兜底并记下拒收，
 * 缺了那层兜底异常会逸出 Worker 的 onmessage、被 Bun 直接终止整条落盘线程。
 */
export function handleJoinLogMessage(msg: JoinLogDiskMessage): void {
  const today: string = getTokyoDateKey();
  if (!isRecentJoinLogDay(msg.day, today, JOIN_LOG_ACCEPTED_EVENT_DAYS)) {
    return;
  }
  ensureCurrentDayPrepared(today);
  const length: number = markJoinLogDirty({
    chatId: msg.chatId,
    day: msg.day,
    record: {
      userId: msg.userId,
      joinedAt: msg.joinedAt,
    },
  });
  if (length >= FLUSH_MAX_ENTRIES) {
    flushJoinLogBuffer();
    return;
  }
  scheduleJoinLogFlush();
}

/**
 * 按命令读取本群滚动窗口。先刷 FIFO 中更早到达的入群消息，再读取窗口覆盖的
 * 一至两个东京日期；同一用户多次重入只返回最后一次。
 */
export function readJoinLog(
  request: ReadJoinLogRequest
): readonly JoinLogRecord[] {
  if (
    !Number.isSafeInteger(request.since) ||
    !Number.isSafeInteger(request.now) ||
    request.since < 0 ||
    request.now < request.since ||
    request.now - request.since > DAY_MS
  ) {
    throw new RangeError("Join log read window must be a safe rolling interval of at most 24 hours.");
  }
  const today: string = getTokyoDateKey();
  ensureCurrentDayPrepared(today);
  if (!flushJoinLogBuffer()) {
    throw new Error("Failed to flush pending join logs before reading.");
  }

  const firstDay: string = getTokyoDateKey(new Date(request.since));
  const lastDay: string = getTokyoDateKey(new Date(request.now));
  const requestedDays: string[] =
    firstDay === lastDay ? [firstDay] : [firstDay, lastDay];
  const latestByUser: Map<number, JoinLogRecord> = new Map();
  for (const day of requestedDays) {
    if (!isRecentJoinLogDay(day, today, JOIN_LOG_FILE_RETENTION_DAYS)) {
      continue;
    }
    const path: string = joinLogPath(request.chatId, day);
    if (!existsSync(path)) continue;
    const cache: JoinLogFileCache =
      getJoinLogFileCache(request.chatId, day);
    for (const record of cache.latestByUser.values()) {
      if (record.joinedAt < request.since || record.joinedAt > request.now) {
        continue;
      }
      const current: JoinLogRecord | undefined =
        latestByUser.get(record.userId);
      if (current === undefined || record.joinedAt > current.joinedAt) {
        latestByUser.set(record.userId, record);
      }
    }
  }
  const records: JoinLogRecord[] = [...latestByUser.values()];
  records.sort((
    left: JoinLogRecord,
    right: JoinLogRecord
  ): number => left.joinedAt - right.joinedAt);
  return records;
}
