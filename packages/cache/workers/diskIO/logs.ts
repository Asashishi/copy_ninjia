/** owner: workers/diskIO。日志落盘（packages/workers/diskIO/logFiles.ts）的内存状态。 */

import type { BufferedLogEntry, DayFileState } from "../../../types/diskIO/storage";

/** 当前日志追加目标；Worker 重建后由下一次写入重新探测。 */
export const loggerFileState: { current: DayFileState | null } = { current: null };

/**
 * 追加失败后允许重新打开日文件的最早时刻（0 = 没有待退避的失败）。
 *
 * 只在 `loggerFileState.current === null` 时有意义：重开一次要把整个日文件读一遍、
 * 逐条校验 schema 并扫一遍目录，而磁盘满/只读这类故障不会在一个 flush 周期内自愈，不退避
 * 就是每个周期按日文件大小付一次这个代价（见 consts/diskIO/appendOnly.ts 的
 * LOG_REOPEN_RETRY_MS）。追加成功即清零；`resetLogCache` 一并清掉。
 */
export const loggerReopenState: { retryAt: number } = { retryAt: 0 };
/**
 * 当前诊断批里待刷的日志条目。
 *
 * - 填充：logFiles.ts 的 handleLogMessage 逐条追加。
 * - 清理：flushLogBuffer 整批取走；诊断批消费完必定调用它，容量因此以一个诊断批
 *   （DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES）为上界。
 * - 重建：Worker 重建时随 isolate 清空；未确认的诊断批由主线程整批重投。
 */
export const flushBuffer: { entries: BufferedLogEntry[] } = { entries: [] };

/** 追加一条待刷日志；由诊断批尾的 flushLogBuffer 落盘。 */
export function markLogDirty(entry: BufferedLogEntry): void {
  flushBuffer.entries.push(entry);
}

/** Worker 启动/停止或测试隔离时清空文件游标和待刷批次。 */
export function resetLogCache(): void {
  flushBuffer.entries = [];
  loggerFileState.current = null;
  loggerReopenState.retryAt = 0;
}
