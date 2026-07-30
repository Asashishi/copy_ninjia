import type { DayFileState } from "../../../types/diskIO/storage";

/** 日志落盘（packages/workers/diskIO/logFiles.ts）的内存状态。 */

/** 一条尚未刷盘的日志序列化文本及其东京日期。 */
export interface BufferedLogEntry {
  day: string;
  text: string;
}

/** 当前日志追加目标；Worker 重建后由下一次写入重新探测。 */
export const loggerFileState: { current: DayFileState | null } = { current: null };

/**
 * 追加失败后允许重新打开日文件的最早时刻（0 = 没有待退避的失败）。
 *
 * 只在 `loggerFileState.current === null` 时有意义：重开一次要把整个日文件读两遍
 * 并逐条校验 schema，而磁盘满/只读这类故障不会在一个 flush 周期内自愈，不退避
 * 就是每个周期按日文件大小付一次这个代价（见 consts/diskIO/appendOnly.ts 的
 * LOG_REOPEN_RETRY_MS）。追加成功即清零；`resetLogCache` 一并清掉。
 */
export const loggerReopenState: { retryAt: number } = { retryAt: 0 };
/** 日志条目与负责刷出这些条目的 timer 由同一 owner 持有。 */
export const flushBuffer: { entries: BufferedLogEntry[]; timer: ReturnType<typeof setTimeout> | null } = {
  entries: [],
  timer: null,
};

/** 追加一条待刷日志并返回当前批量长度；阈值或 timer 触发 flush。 */
export function markLogDirty(entry: BufferedLogEntry): number {
  flushBuffer.entries.push(entry);
  return flushBuffer.entries.length;
}

/** Worker 启动/停止或测试隔离时取消 timer 并清空文件游标和待刷批次。 */
export function resetLogCache(): void {
  if (flushBuffer.timer !== null) clearTimeout(flushBuffer.timer);
  flushBuffer.entries = [];
  flushBuffer.timer = null;
  loggerFileState.current = null;
  loggerReopenState.retryAt = 0;
}
