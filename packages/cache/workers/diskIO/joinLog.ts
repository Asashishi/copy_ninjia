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
 *
 * `rejected` 是「这一轮有入群事实压根没进缓冲」的一次性标记：缓冲满、跨日
 * 前的刷盘失败、跨日清理抛错都会置真（见 workers/diskIO/joinLogFiles.ts 的
 * handleJoinLogMessage 与 diskIOWorker.ts 的 joinLog 分支）。它必须与 entries
 * 分开记——被拒的那条事实不在 entries 里，只看 entries 会把「什么都没写成」
 * 报成落盘成功。由统一 flush 的 joinLog 出口消费一次即清零，让 Telegram 重投
 * 的下一条不被上一条的失败连坐；Worker 崩溃重建后为 false，此时未确认的
 * update 本来就会重投，不需要跨实例沿用。
 *
 * 一个布尔够用（而不必按条计数），依据是主线程 recordJoinLog 的 post 与紧随
 * 其后的领域 flush 之间没有 await，两条消息必然成对相邻到达：每一条被拒的事实
 * 都由它自己那次 flush 消费掉这个标记。
 */
export const joinLogBuffer: {
  entries: BufferedJoinLogEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  rejected: boolean;
} = {
  entries: [],
  timer: null,
  rejected: false,
};

/** 记下一条没能进入缓冲的入群事实；下一次统一 flush 必须据此回报失败。 */
export function noteJoinLogRejected(): void {
  joinLogBuffer.rejected = true;
}

/** 取走并清零拒收标记；只有统一 flush 的 joinLog 出口可以消费它。 */
export function consumeJoinLogRejection(): boolean {
  const rejected: boolean = joinLogBuffer.rejected;
  joinLogBuffer.rejected = false;
  return rejected;
}

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
  joinLogBuffer.rejected = false;
  joinLogFileCaches.clear();
  joinLogRetryAt.clear();
  joinLogCleanupDay.current = null;
}
