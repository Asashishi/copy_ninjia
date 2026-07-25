import type { DayFileState } from "../../types/diskIO/storage";

/** 日志落盘（packages/workers/diskIO/logFiles.ts）的内存状态。 */

/** 一条尚未刷盘的日志序列化文本及其东京日期。 */
export interface BufferedLogEntry {
  day: string;
  text: string;
}

/** 当前日志追加目标；Worker 重建后由下一次写入重新探测。 */
export const loggerFileState: { current: DayFileState | null } = { current: null };
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
}
