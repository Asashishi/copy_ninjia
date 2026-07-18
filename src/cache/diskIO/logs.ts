import type { DayFileState } from "../../types";

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

export function markLogDirty(entry: BufferedLogEntry): number {
  flushBuffer.entries.push(entry);
  return flushBuffer.entries.length;
}

export function resetLogCache(): void {
  if (flushBuffer.timer !== null) clearTimeout(flushBuffer.timer);
  flushBuffer.entries = [];
  flushBuffer.timer = null;
  loggerFileState.current = null;
}
