import type { DayFileState, LuckDayCache, LuckPendingEntry } from "../../../types/diskIO/storage";

/** 每日运势落盘（packages/workers/diskIO/luckFiles.ts）的内存状态。 */

/** 当日已知结果、待追加条目、文件游标及 flush timer 的唯一 owner。 */
export const luckWorkerCache: { current: LuckDayCache | null } = { current: null };
/** 尚未追加到当日文件的抽签条目；flush 成功后按批清除。 */
export const luckPendingAppends: LuckPendingEntry[] = [];
/** 当前运势追加文件游标；hydrate、跨日或 reset 时清空并按需重开。 */
export const luckFileState: { current: DayFileState | null } = { current: null };
/** 运势增量批量刷盘 timer；首次 dirty 创建，flush/reset 时清除。 */
export const luckFlushTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/** 启动恢复或跨日时整体替换当日缓存并清除待刷批次、timer 和游标。 */
export function hydrateLuckCache(day: LuckDayCache | null): void {
  if (luckFlushTimer.timer !== null) clearTimeout(luckFlushTimer.timer);
  luckFlushTimer.timer = null;
  luckWorkerCache.current = day;
  luckPendingAppends.length = 0;
  luckFileState.current = null;
}

/** 创建并接管新的东京日期缓存；旧日期运行态被完整清除。 */
export function startLuckDay(day: string): LuckDayCache {
  const next: LuckDayCache = { day, entries: new Map() };
  hydrateLuckCache(next);
  return next;
}

/** 追加一条待刷运势并返回批量长度；阈值或 timer 触发 flush。 */
export function markLuckDirty(entry: LuckPendingEntry): number {
  luckPendingAppends.push(entry);
  return luckPendingAppends.length;
}

/** Worker 停止或测试隔离时取消 timer 并清空运势运行态。 */
export function resetLuckCache(): void {
  if (luckFlushTimer.timer !== null) clearTimeout(luckFlushTimer.timer);
  luckFlushTimer.timer = null;
  hydrateLuckCache(null);
}
