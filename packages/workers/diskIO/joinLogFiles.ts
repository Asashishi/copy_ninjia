/**
 * 滚动 24 小时入群事实的路由与调度层：缓冲、按 `chatId:day` 分组 flush、joinLogPersisted
 * 处置回执、跨日准备与命令按需读取。文件接管与写入在 diskIO/joinLogWrites.ts，启动恢复与
 * 过期清理在 diskIO/joinLogRecovery.ts。
 */

import {
  joinLogBuffer,
  joinLogCleanupDay,
  joinLogDeletions,
  joinLogPersistedNotifier,
  markJoinLogDirty,
} from "../../cache/workers/diskIO/joinLog";
import {
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_ENTRIES,
} from "../../consts/diskIO/appendOnly";
import {
  JOIN_LOG_ACCEPTED_EVENT_DAYS,
  JOIN_LOG_REOPEN_RETRY_MS,
} from "../../consts/diskIO/joinLog";
import { DAY_MS } from "../../consts/diskIO/common";
import { getDateKey } from "../../libs/time";
import type {
  JoinLogDeleteDiskMessage,
  JoinLogDiskMessage,
  ReadJoinLogRequest,
} from "../../types/diskIO/messages";
import type {
  BufferedJoinLogEntry,
  JoinLogFileCache,
  JoinLogRecord,
} from "../../types/diskIO/storage";
import {
  isRecentJoinLogDay,
} from "./joinLogRecords";
import {
  cleanupExpiredJoinLogDays,
  purgeChatJoinLogFiles,
  retainedJoinLogDayKeys,
} from "./joinLogRecovery";
import {
  dayOfFileKey,
  fileKey,
  getJoinLogFileCache,
  joinLogPath,
  writeFileEntries,
} from "./joinLogWrites";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";

async function ensureCurrentDayPrepared(today: string): Promise<void> {
  if (joinLogCleanupDay.current === today) return;
  // 先提交跨日前仍在缓冲中的记录，再清理保留窗口外文件，不能先删后刷。
  const failedKeys: ReadonlySet<string> = await flushJoinLogEntries();
  if (failedKeys.size > 0) {
    // 但「先删后刷」只在**这次要删掉的那一天**仍有未落盘条目时才成立。任意一个
    // 群写失败就整体拒绝跨日准备的话，每日维护与 `/batch_kick` 读取都会卡在同一个
    // 检查上，而清理动的是保留窗口**之外**的文件，与它们毫无关系。
    const retainedDays: ReadonlySet<string> =
      retainedJoinLogDayKeys(today);
    for (const key of failedKeys) {
      if (!retainedDays.has(dayOfFileKey(key))) return;
    }
  }
  await cleanupExpiredJoinLogDays(today);
}

/** 每日维护先提交跨日前缓冲，再清理入群日志保留窗口外的文件。 */
export async function maintainJoinLogRetention(
  today: string = getDateKey()
): Promise<void> {
  await ensureCurrentDayPrepared(today);
  if (joinLogCleanupDay.current !== today) {
    throw new Error("Failed to flush expiring join logs before daily retention maintenance.");
  }
}

/**
 * 发出 joinLogPersisted：through 是已收下的最大序号，pending 是仍留在缓冲里的序号，
 * 其余不超过 through 的事实都已写入或丢弃。一个群的文件持续写不进只让它自己的事实
 * 留在 pending，不挡住其它群的释放。through 与 pending 条数都没变时不重发。
 */
function publishJoinLogPersisted(): void {
  const through: number = joinLogBuffer.receivedThrough;
  const pendingCount: number = joinLogBuffer.entries.length;
  if (
    through === joinLogBuffer.acknowledgedThrough &&
    pendingCount === joinLogBuffer.acknowledgedPending
  ) return;
  const pending: number[] = [];
  for (const entry of joinLogBuffer.entries) pending.push(entry.sequence);
  joinLogBuffer.acknowledgedThrough = through;
  joinLogBuffer.acknowledgedPending = pendingCount;
  joinLogPersistedNotifier.current({ type: "joinLogPersisted", through, pending });
}

/**
 * 立即把所有群的待写入群事实按目标文件分组追写；失败分组原样保留并退避，事件日期
 * 领先本 Worker 今天的条目留到下一次 flush（启动恢复拒绝未来日期文件，不能提前建文件）。
 * 结束时按剩余缓冲发出处置回执。
 * @returns 本次写失败的 `chatId:day` 键集合；空集只表示没有写失败，领先条目不计入。
 *
 * 返回**哪些**分组失败而不只是「有没有失败」：一个群的文件写不动（ENOSPC、
 * 部署后 chown 导致 EACCES、尾部截断）不能连坐其它群——按需读取和跨日准备
 * 都只关心自己那几个 `chatId:day`，用全局布尔判会让健康群的 `/batch_kick`
 * 一起失败，而它自己的日志文件完好且早已刷盘。
 */
async function flushJoinLogEntries(): Promise<ReadonlySet<string>> {
  cancelDiskIOFlushTimer(joinLogBuffer);
  if (joinLogBuffer.entries.length === 0) {
    publishJoinLogPersisted();
    return new Set<string>();
  }
  const today: string = getDateKey();
  const entries: BufferedJoinLogEntry[] = joinLogBuffer.entries;
  joinLogBuffer.entries = [];
  let aheadEntries: BufferedJoinLogEntry[] | null = null;
  const groups: Map<string, {
    chatId: number;
    day: string;
    entries: BufferedJoinLogEntry[];
  }> = new Map();
  for (const entry of entries) {
    // YYYY-MM-DD 定宽零填充，字典序即日期序。
    if (entry.day > today) {
      aheadEntries ??= [];
      aheadEntries.push(entry);
      continue;
    }
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
    if (!await writeFileEntries(group.chatId, group.day, group.entries)) {
      failedEntries.push(...group.entries);
      failedKeys.add(key);
    }
  }
  if (failedEntries.length > 0 || aheadEntries !== null) {
    // flush 是同步 owner，新消息不能在循环中插入；仍使用 prepend 语义明确保证
    // 留下的旧事实排在未来新事实之前。
    joinLogBuffer.entries = aheadEntries === null
      ? failedEntries.concat(joinLogBuffer.entries)
      : failedEntries.concat(aheadEntries, joinLogBuffer.entries);
    // 领先条目只需等配置时区的日期追上；失败分组在各自退避期内由 writeFileEntries 直接跳过。
    armDiskIOFlushTimer(
      joinLogBuffer,
      aheadEntries === null ? JOIN_LOG_REOPEN_RETRY_MS : FLUSH_INTERVAL_MS,
      flushJoinLogBuffer
    );
  }
  publishJoinLogPersisted();
  return failedKeys;
}

/** 缓冲是否已整体落盘：没有写失败、也没有留待下一次 flush 的领先条目。 */
export async function flushJoinLogBuffer(): Promise<boolean> {
  await flushJoinLogEntries();
  return joinLogBuffer.entries.length === 0;
}

/**
 * 群 teardown 的整群删除：先丢掉这个群仍在缓冲里的待写事实，再删它的全部日志文件。
 *
 * 缓冲必须同步丢掉——留着的话，本条之后的任何一次 flush 都会把属于已停管群的入群
 * 事实重新写回一份刚被删掉的文件。删除失败保留待删标记，由 `joinLogPurge` 领域
 * 的每一次 flush 重试并回报；那一格与追写的 `joinLog` 分开记，见
 * types/diskIO/replies.ts 的 DiskIODomain。
 */
export function handleJoinLogDeleteMessage(msg: JoinLogDeleteDiskMessage): void {
  joinLogBuffer.entries = joinLogBuffer.entries.filter(
    (entry: BufferedJoinLogEntry): boolean => entry.chatId !== msg.chatId
  );
  joinLogDeletions.add(msg.chatId);
  purgeChatJoinLogFiles(msg.chatId);
  publishJoinLogPersisted();
}

/**
 * 缓冲一条仍可能落在滚动 24 小时窗口内的入群事件；累计 FLUSH_MAX_ENTRIES 条立即刷出，
 * 否则按需排定 FLUSH_INTERVAL_MS 定时刷出。本函数不因单条事实失败而抛出，事实一律由
 * 缓冲、丢弃或留待重试之一收下，主线程镜像按处置回执释放（见 infra/joinLog.ts）。
 *
 * 「窗口外」的两侧收场不同：
 *
 * - **过旧**（停机后 Telegram 重投的几天前入群）是**有意静默丢弃**。滚动 24 小时
 *   窗口本来就用不上它；缓冲为空时立即发出处置回执，免得这类事实占住主线程镜像。
 * - **领先**（事件日期比本 Worker 的今天还晚）是事件时间与宿主时钟对不上，典型是
 *   Telegram 先跨过配置时区的零点。它照常进缓冲，由 flush 留到本 Worker 的日期追上后再写：
 *   提前建出未来日期文件会让下一次启动恢复拒绝启动。
 */
export async function handleJoinLogMessage(
  msg: JoinLogDiskMessage
): Promise<void> {
  const now: number = Date.now();
  const today: string = getDateKey(now);
  // 日期窗口外仍可能落在夏令时短日跨越的滚动 24 小时内。
  if (
    msg.day <= today &&
    !isRecentJoinLogDay(msg.day, today, JOIN_LOG_ACCEPTED_EVENT_DAYS) &&
    msg.day < getDateKey(now - DAY_MS)
  ) {
    joinLogBuffer.receivedThrough = msg.sequence;
    if (joinLogBuffer.entries.length === 0) publishJoinLogPersisted();
    return;
  }
  try {
    await ensureCurrentDayPrepared(today);
  } catch (error: unknown) {
    // 本条落在保留窗口内，过期清理不会删它的文件；下一条事实与每日维护会重试清理。
    console.error("[diskIOWorker] failed to prepare the join log day:", error);
  }
  const length: number = markJoinLogDirty({
    sequence: msg.sequence,
    chatId: msg.chatId,
    day: msg.day,
    record: {
      userId: msg.userId,
      joinedAt: msg.joinedAt,
    },
  });
  joinLogBuffer.receivedThrough = msg.sequence;
  if (length >= FLUSH_MAX_ENTRIES) {
    await flushJoinLogBuffer();
    return;
  }
  armDiskIOFlushTimer(joinLogBuffer, FLUSH_INTERVAL_MS, flushJoinLogBuffer);
}

/**
 * 按命令读取本群滚动窗口。先刷 FIFO 中更早到达的入群消息，再读取窗口覆盖的
 * 全部配置时区日期；同一用户多次重入只返回最后一次。
 */
export async function readJoinLog(
  request: ReadJoinLogRequest
): Promise<readonly JoinLogRecord[]> {
  if (
    !Number.isSafeInteger(request.since) ||
    !Number.isSafeInteger(request.now) ||
    request.since < 0 ||
    request.now < request.since ||
    request.now - request.since > DAY_MS
  ) {
    throw new RangeError("Join log read window must be a safe rolling interval of at most 24 hours.");
  }
  const today: string = getDateKey();
  await ensureCurrentDayPrepared(today);
  const failedKeys: ReadonlySet<string> = await flushJoinLogEntries();

  const lastDay: Temporal.PlainDate = Temporal.PlainDate.from(getDateKey(request.now));
  const requestedDays: string[] = [];
  for (
    let day: Temporal.PlainDate = Temporal.PlainDate.from(getDateKey(request.since));
    Temporal.PlainDate.compare(day, lastDay) <= 0;
    day = day.add({ days: 1 })
  ) requestedDays.push(day.toString());
  // 只认本群、本窗口文件的落盘结果：别的群写不动与这次读取无关，
  // 用全局判据会让日志完好的群也收到「入群日志暂时读不了」。
  for (const day of requestedDays) {
    if (failedKeys.has(fileKey(request.chatId, day))) {
      throw new Error(
        `Failed to flush pending join logs for chat ${request.chatId} on ${day} before reading.`
      );
    }
  }
  const latestByUser: Map<number, JoinLogRecord> = new Map();
  const retainedDays: ReadonlySet<string> = retainedJoinLogDayKeys(today);
  for (const day of requestedDays) {
    if (!retainedDays.has(day)) {
      continue;
    }
    const path: string = joinLogPath(request.chatId, day);
    if (!await Bun.file(path).exists()) continue;
    const cache: JoinLogFileCache =
      await getJoinLogFileCache(request.chatId, day);
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
