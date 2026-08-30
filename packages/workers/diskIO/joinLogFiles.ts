/**
 * 滚动 24 小时入群事实的追加日志。文件按 `<chatId>.<东京日期>.json` 分开，
 * 写入沿用 appendOnlyDayFile.ts 的 JSON 对象末尾追写机制；启动恢复先扫描保留
 * 窗口内的全部文件，运行期再按首条事实或 `/batch_kick` 查询建立有界 LRU。
 */

import {
  existsSync,
  mkdirSync,
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
  JOIN_LOG_ENTRY_SEPARATOR_BYTES,
  JOIN_LOG_FILE_RETENTION_DAYS,
  JOIN_LOG_MAX_USERS_PER_CHAT_DAY,
  JOIN_LOG_REOPEN_RETRY_MS,
} from "../../consts/diskIO/joinLog";
import {
  DAY_MS,
  PERSISTED_FILE_MODE,
} from "../../consts/diskIO/common";
import { JOIN_LOG_MEMORY_DIR } from "../../consts/paths";
import { atomicWriteTextChunksSync } from "../../libs/atomicFile";
import { invalidInput } from "../../libs/inputValidation";
import { getTokyoDateKey } from "../../libs/time";
import type {
  JoinLogDiskMessage,
  ReadJoinLogRequest,
} from "../../types/diskIO/messages";
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
  isRecentJoinLogDay,
  joinLogSnapshotEntryBytes,
  joinLogSnapshotChunks,
  latestJoinLogRecords,
  measureJoinLogSnapshotBytes,
  newestBufferedJoinLogRecords,
  recentJoinLogDayKeys,
  serializeJoinLogSnapshotEntry,
  trimJoinLogRecordsToCapacity,
} from "./joinLogRecords";
import {
  cleanupExpiredJoinLogDays,
  readValidatedJoinLogFile,
} from "./joinLogRecovery";
import type { ValidatedJoinLogFile } from "./joinLogRecovery";
export {
  inspectJoinLogFiles,
  maintainJoinLogFiles,
} from "./joinLogRecovery";
export type { JoinLogRecoveryInspection } from "./joinLogRecovery";

function joinLogPath(chatId: number, day: string): string {
  return join(JOIN_LOG_MEMORY_DIR, `${chatId}.${day}.json`);
}

function fileKey(chatId: number, day: string): string {
  return `${chatId}:${day}`;
}

/** 取 fileKey 里的日期部分；chat id 可能带负号，日期永远在最后一个冒号之后。 */
function dayOfFileKey(key: string): string {
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
 * 首次接管某群某日文件时严格校验领域 schema、容量与规范追加格式；任何
 * 损坏都保留原始字节并拒绝接管。成功后恢复 latest-by-user 索引。
 */
function openJoinLogFile(chatId: number, day: string): JoinLogFileCache {
  const path: string = joinLogPath(chatId, day);
  const existing: ValidatedJoinLogFile | null = existsSync(path)
    ? readValidatedJoinLogFile(path)
    : null;
  const parsed: Record<string, JoinLogRecord> = existing === null
    ? {}
    : existing.parsed;
  const state: AppendOnlyFileState = existing === null
    ? openAppendOnlyFile(path, PERSISTED_FILE_MODE)
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

function ensureCurrentDayPrepared(today: string): void {
  if (joinLogCleanupDay.current === today) return;
  // 先提交跨日前仍在缓冲中的记录，再清理保留窗口外文件，不能先删后刷。
  const failedKeys: ReadonlySet<string> = flushJoinLogEntries();
  if (failedKeys.size > 0) {
    // 但「先删后刷」只在**这次要删掉的那一天**仍有未落盘条目时才成立。任意一个
    // 群写失败就整体拒绝跨日准备的话，每一条新入群事实都会卡在同一个检查上
    // （handleJoinLogMessage 会因此走 noteJoinLogRejected，连坐一条无关 update
    // 被重投），而清理动的是保留窗口**之外**的文件，与它们毫无关系。
    const retainedDays: ReadonlySet<string> =
      recentJoinLogDayKeys(today, JOIN_LOG_FILE_RETENTION_DAYS);
    for (const key of failedKeys) {
      if (!retainedDays.has(dayOfFileKey(key))) return;
    }
  }
  cleanupExpiredJoinLogDays(today);
}

/** 每日维护先提交跨日前缓冲，再清理入群日志保留窗口外的文件。 */
export function maintainJoinLogRetention(
  today: string = getTokyoDateKey()
): void {
  ensureCurrentDayPrepared(today);
  if (joinLogCleanupDay.current !== today) {
    throw new Error("Failed to flush expiring join logs before daily retention maintenance.");
  }
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
    appendToAppendOnlyFile({
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

/**
 * 立即把所有群的待写入群事实按目标文件分组追写；失败分组原样保留并退避。
 * @returns 本次写失败的 `chatId:day` 键集合；空集表示全部落盘。
 *
 * 返回**哪些**分组失败而不只是「有没有失败」：一个群的文件写不动（ENOSPC、
 * 部署后 chown 导致 EACCES、尾部截断）不能连坐其它群——按需读取和跨日准备
 * 都只关心自己那几个 `chatId:day`，用全局布尔判会让健康群的 `/batch_kick`
 * 一起失败，而它自己的日志文件完好且早已刷盘。
 */
function flushJoinLogEntries(): ReadonlySet<string> {
  if (joinLogBuffer.timer !== null) {
    clearTimeout(joinLogBuffer.timer);
    joinLogBuffer.timer = null;
  }
  if (joinLogBuffer.entries.length === 0) return new Set<string>();
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
  const failedKeys: Set<string> = new Set<string>();
  for (const [key, group] of groups) {
    if (!writeFileEntries(group.chatId, group.day, group.entries)) {
      failedEntries.push(...group.entries);
      failedKeys.add(key);
    }
  }
  if (failedEntries.length === 0) return failedKeys;
  // flush 是同步 owner，新消息不能在循环中插入；仍使用 prepend 语义明确保证
  // 失败的旧事实排在未来新事实之前。
  joinLogBuffer.entries = failedEntries.concat(joinLogBuffer.entries);
  scheduleJoinLogFlush(JOIN_LOG_REOPEN_RETRY_MS);
  return failedKeys;
}

/** 缓冲整体落盘成功；调用方只关心「有没有失败」时用它。 */
export function flushJoinLogBuffer(): boolean {
  return flushJoinLogEntries().size === 0;
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
 *
 * 「窗口外」的两侧收场不同，必须分开判：
 *
 * - **过旧**（停机后 Telegram 重投的几天前入群）是**有意静默丢弃**。滚动 24 小时
 *   窗口本来就用不上它，报失败只会让这条 update 永远得不到确认、被反复重投。
 * - **领先**（事件日期比本 Worker 的今天还晚）不是「窗口用不上」，而是事件时间与
 *   宿主时钟对不上。照过旧那样静默 return 的话，recordJoinLog 会把它当成已经落盘
 *   （见 infra/joinLog.ts），这条入群从此在 `/batch_kick` 里查无此人、全链路零日志。
 *   抛出去交给统一的拒收出口：update 不被确认，Telegram 重投一次即可自愈。
 */
export function handleJoinLogMessage(msg: JoinLogDiskMessage): void {
  const today: string = getTokyoDateKey();
  // YYYY-MM-DD 定宽零填充，字典序即日期序。
  if (msg.day > today) {
    throw new Error(
      `Join log event day ${msg.day} is ahead of the worker's current Tokyo day ${today}.`
    );
  }
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
  const failedKeys: ReadonlySet<string> = flushJoinLogEntries();

  const firstDay: string = getTokyoDateKey(new Date(request.since));
  const lastDay: string = getTokyoDateKey(new Date(request.now));
  const requestedDays: string[] =
    firstDay === lastDay ? [firstDay] : [firstDay, lastDay];
  // 只认本群、本窗口这一两个文件的落盘结果：别的群写不动与这次读取无关，
  // 用全局判据会让日志完好的群也收到「入群日志暂时读不了」。
  for (const day of requestedDays) {
    if (failedKeys.has(fileKey(request.chatId, day))) {
      throw new Error(
        `Failed to flush pending join logs for chat ${request.chatId} on ${day} before reading.`
      );
    }
  }
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
