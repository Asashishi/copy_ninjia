import {
  JOIN_LOG_MAX_BUFFERED_ENTRIES,
  JOIN_LOG_MAX_CACHED_FILES,
  JOIN_LOG_MAX_RETRY_FILES,
} from "../../../consts/diskIO/joinLog";
import { LruCache } from "../../../libs/lruCache";
import type {
  BufferedJoinLogEntry,
  JoinLogFileCache,
} from "../../../types/diskIO/storage";

/** 入群日志落盘（packages/workers/diskIO/joinLogFiles.ts）的 Worker 独占状态。 */

/**
 * 每个已打开群日文件的追加游标与 latest-by-user 索引。权威副本只存在于
 * Disk I/O Worker；由有界 LruCache 自动淘汰。被淘汰或 Worker 崩溃后不沿用
 * 内存，下一次写入/读取从磁盘严格重建；进程重启同样从空缓存开始。
 */
export const joinLogFileCaches: LruCache<string, JoinLogFileCache> =
  new LruCache<string, JoinLogFileCache>(JOIN_LOG_MAX_CACHED_FILES);

/**
 * 追加失败文件允许重开的最早时刻；有界 LruCache 独立淘汰最旧项。
 * 没有条目只表示不退避、允许立即重试，不表示此前写入已经成功。
 */
export const joinLogRetryAt: LruCache<string, number> =
  new LruCache<string, number>(JOIN_LOG_MAX_RETRY_FILES);

/** 最近一次完成跨日清理的东京日期；null 表示本 Worker 尚未接触该目录。 */
export const joinLogCleanupDay: { current: string | null } = { current: null };

/**
 * 待刷条目和 timer 由同一个 Disk I/O Worker owner 持有。条目在成功刷盘时
 * 清空、失败时保留，达到硬顶后拒绝继续接纳；Worker/进程重启从空缓冲开始，
 * 对应主线程 durability barrier 会失败，Telegram update 因未确认而重投。
 */
export const joinLogBuffer: {
  entries: BufferedJoinLogEntry[];
  timer: ReturnType<typeof setTimeout> | null;
} = {
  entries: [],
  timer: null,
};

/** 追加一条待刷记录并返回批量长度；满载时不修改缓冲并快速失败。 */
export function markJoinLogDirty(entry: BufferedJoinLogEntry): number {
  if (joinLogBuffer.entries.length >= JOIN_LOG_MAX_BUFFERED_ENTRIES) {
    throw new Error(
      `Join log buffer reached its hard limit of ${JOIN_LOG_MAX_BUFFERED_ENTRIES} entries.`
    );
  }
  joinLogBuffer.entries.push(entry);
  return joinLogBuffer.entries.length;
}

/** Worker 停止或测试隔离时清空游标、退避、缓冲与 timer。 */
export function resetJoinLogCache(): void {
  if (joinLogBuffer.timer !== null) clearTimeout(joinLogBuffer.timer);
  joinLogBuffer.entries = [];
  joinLogBuffer.timer = null;
  joinLogFileCaches.clear();
  joinLogRetryAt.clear();
  joinLogCleanupDay.current = null;
}
