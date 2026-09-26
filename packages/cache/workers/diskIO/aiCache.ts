import type { AppendOnlyFileState } from "../../../types/diskIO/storage";

/**
 * Owner: Disk I/O Worker。AI 缓存用量统计（packages/workers/diskIO/aiCacheFile.ts）的内存状态。
 *
 * - aiCacheFileState：统计文件的追加游标。启动恢复 adopt 时填充；追加失败置 null，按
 *   aiCacheReopenState 退避后由下一次 flush 重新探测；每日汇总整份重写后更新。
 * - aiCacheBuffer：已序列化、待追加的逐条记录与负责刷出的 timer。达到 FLUSH_MAX_ENTRIES
 *   立即刷，否则 FLUSH_INTERVAL_MS 后刷，统一 flush 与每日汇总前也会刷；刷盘失败的那一批
 *   直接丢弃，因此容量不超过 FLUSH_MAX_ENTRIES 条。
 * - Worker 重建后随 isolate 清空，由新 Worker 的启动恢复重新 adopt；主线程不镜像这些状态。
 */

/** 统计文件的追加游标；null 表示需要重新探测文件。 */
export const aiCacheFileState: { current: AppendOnlyFileState | null } = { current: null };

/** 追加失败后允许重新探测文件的最早时刻（0 = 没有待退避的失败）。 */
export const aiCacheReopenState: { retryAt: number } = { retryAt: 0 };

/** 待追加的逐条记录（已序列化）与负责刷出它们的 timer。 */
export const aiCacheBuffer: { texts: string[]; timer: ReturnType<typeof setTimeout> | null } = {
  texts: [],
  timer: null,
};

/** 启动恢复 adopt 或测试隔离时取消 timer 并清空游标与待刷记录。 */
export function resetAiCacheState(): void {
  if (aiCacheBuffer.timer !== null) clearTimeout(aiCacheBuffer.timer);
  aiCacheBuffer.texts = [];
  aiCacheBuffer.timer = null;
  aiCacheFileState.current = null;
  aiCacheReopenState.retryAt = 0;
}
