import type { DayFileState } from "../types";

/** 日志落盘线程（src/workers/loggerWorker.ts）的内存状态。 */

/** 当前追加目标文件的状态，重启即清空（下次写入时重新探测/打开对应日期的文件）。 */
export const loggerFileState: { current: DayFileState | null } = { current: null };

/** 内存 buffer：攒够 FLUSH_MAX_ENTRIES 条，或首条入队后 FLUSH_INTERVAL_MS 到期，就统一落盘。 */
export const flushBuffer: { entries: { day: string; text: string }[]; timer: ReturnType<typeof setTimeout> | null } = {
  entries: [],
  timer: null,
};
