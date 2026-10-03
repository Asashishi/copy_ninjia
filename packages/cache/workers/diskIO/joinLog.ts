/** owner: workers/diskIO。入群日志落盘的 Worker 独占状态：
 * joinLogFileCaches 与 joinLogRetryAt 由 packages/workers/diskIO/joinLogWrites.ts
 * 填充与清理，joinLogBuffer 与 joinLogCleanupDay 由 joinLogFiles.ts 持有，
 * joinLogPersistedNotifier 由 workers/diskIOWorker.ts 启动时安装。
 */

import {
  JOIN_LOG_MAX_CACHED_FILES,
  JOIN_LOG_MAX_RETRY_FILES,
} from "../../../consts/diskIO/joinLog";
import { LruCache } from "../../../libs/lruCache";
import type { JoinLogPersistedReply } from "../../../types/diskIO/replies";
import type {
  BufferedJoinLogEntry,
  JoinLogFileCache,
} from "../../../types/diskIO/storage";

/**
 * 每个已打开群日文件的追加游标与 latest-by-user 索引。权威副本只存在于
 * Disk I/O Worker；由有界 LruCache 自动淘汰。被淘汰或 Worker 崩溃后不沿用
 * 内存，下一次写入/读取从磁盘严格重建；进程重启同样从空缓存开始。
 * 容量：JOIN_LOG_MAX_CACHED_FILES 项，满载淘汰最久未用的那份游标；
 * 测试隔离时由 resetJoinLogCache 整表清空。
 */
export const joinLogFileCaches: LruCache<string, JoinLogFileCache> =
  new LruCache<string, JoinLogFileCache>(JOIN_LOG_MAX_CACHED_FILES);

/**
 * 追加失败文件允许重开的最早时刻；有界 LruCache 独立淘汰最旧项。
 * 没有条目只表示不退避、允许立即重试，不表示此前写入已经成功。
 * 容量：JOIN_LOG_MAX_RETRY_FILES 项；退避到期后由写入路径覆盖或淘汰，
 * 测试隔离时由 resetJoinLogCache 整表清空。Worker 崩溃重建后为空，等于不退避。
 */
export const joinLogRetryAt: LruCache<string, number> =
  new LruCache<string, number>(JOIN_LOG_MAX_RETRY_FILES);

/** 最近一次完成跨日清理的配置时区的日期；null 表示本 Worker 尚未接触该目录。 */
export const joinLogCleanupDay: { current: string | null } = { current: null };

/**
 * 已收到整群删除、但该群日文件还没删干净的群。
 *
 * 主线程在群 teardown 时投递一次 `deleteJoinLog` 即登记；目录里属于该群的日文件全部
 * unlink 成功才摘除，失败保留并在下一次统一 flush 时重试，期间 `joinLogPurge`
 * 领域一律回报失败，teardown 因此不会把「日志还在」报成删干净了。该领域与追写的
 * `joinLog` 分开记，见 types/diskIO/replies.ts 的 DiskIODomain。容量与群数
 * 上限同阶；Worker 重建后为空，未确认的那次 teardown 由主线程重投。
 */
export const joinLogDeletions: Set<number> = new Set();

/**
 * 待刷入群事实、刷出 timer 与处置回执的发送状态，由同一个 Disk I/O Worker owner 持有。
 *
 * - entries：handleJoinLogMessage 填充；累计 FLUSH_MAX_ENTRIES 条、FLUSH_INTERVAL_MS
 *   到期或显式 flush 时按 `chatId:day` 分组追写，写成的分组移出，写失败与事件日期领先
 *   本 Worker 今天的条目留在缓冲里等下一次 flush。容量：恒为主线程未确认镜像的子集，
 *   由 JOIN_LOG_MAX_BUFFERED_ENTRIES 在主线程一侧封顶，本侧不另设上限。
 * - receivedThrough：已进缓冲或已按窗口外丢弃的最大序号。
 * - acknowledgedThrough / acknowledgedPending：最近一次 joinLogPersisted 回执的 through 与
 *   pending 条数；through 不变时不会有新条目进缓冲，两者都没变即说明没有新的已处置事实，
 *   不再重发。
 *
 * Worker 崩溃重建后三者从空起步，主线程按未确认镜像原序重放；进程重启后镜像随之
 * 消失，未落盘的事实丢失。
 */
export const joinLogBuffer: {
  entries: BufferedJoinLogEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  receivedThrough: number;
  acknowledgedThrough: number;
  acknowledgedPending: number;
} = {
  entries: [],
  timer: null,
  receivedThrough: 0,
  acknowledgedThrough: 0,
  acknowledgedPending: 0,
};

/**
 * joinLogPersisted 回执出口。Worker 入口启动时安装，isolate 销毁时释放；独立 owner
 * 测试未安装时丢弃回执，容量一项。
 */
export const joinLogPersistedNotifier: { current: (reply: JoinLogPersistedReply) => void } = {
  current: (): void => { /* 独立 owner 测试未安装 Worker 回执出口。 */ },
};

/** 追加一条待刷记录并返回批量长度。 */
export function markJoinLogDirty(entry: BufferedJoinLogEntry): number {
  joinLogBuffer.entries.push(entry);
  return joinLogBuffer.entries.length;
}

/** 测试隔离时清空游标、退避、缓冲与 timer；生产代码不调用，Worker 停止时随 isolate 释放。 */
export function resetJoinLogCache(): void {
  if (joinLogBuffer.timer !== null) clearTimeout(joinLogBuffer.timer);
  joinLogBuffer.entries = [];
  joinLogBuffer.timer = null;
  joinLogBuffer.receivedThrough = 0;
  joinLogBuffer.acknowledgedThrough = 0;
  joinLogBuffer.acknowledgedPending = 0;
  joinLogFileCaches.clear();
  joinLogRetryAt.clear();
  joinLogCleanupDay.current = null;
  joinLogDeletions.clear();
}
