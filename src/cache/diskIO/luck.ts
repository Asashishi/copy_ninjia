import type { DayFileState, LuckDayCache, LuckPendingEntry } from "../../types/diskIO/storage";

/** 当日已知结果、待追加条目、文件游标及 flush timer 的唯一 owner。 */
export const luckWorkerCache: { current: LuckDayCache | null } = { current: null };
export const luckPendingAppends: LuckPendingEntry[] = [];
export const luckFileState: { current: DayFileState | null } = { current: null };
export const luckFlushTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

export function hydrateLuckCache(day: LuckDayCache | null): void {
  if (luckFlushTimer.timer !== null) clearTimeout(luckFlushTimer.timer);
  luckFlushTimer.timer = null;
  luckWorkerCache.current = day;
  luckPendingAppends.length = 0;
  luckFileState.current = null;
}

export function startLuckDay(day: string): LuckDayCache {
  const next: LuckDayCache = { day, entries: new Map() };
  hydrateLuckCache(next);
  return next;
}

export function markLuckDirty(entry: LuckPendingEntry): number {
  luckPendingAppends.push(entry);
  return luckPendingAppends.length;
}

export function resetLuckCache(): void {
  if (luckFlushTimer.timer !== null) clearTimeout(luckFlushTimer.timer);
  luckFlushTimer.timer = null;
  hydrateLuckCache(null);
}
