/** owner: workers/diskIO。每日运势落盘（packages/workers/diskIO/luckFiles.ts）的内存状态。 */

import type { LuckDrawDiskMessage } from "../../../types/diskIO/messages";
import type { LuckAppendStalledReply } from "../../../types/diskIO/replies";
import type { DayFileState, LuckDayCache, LuckPendingEntry } from "../../../types/diskIO/storage";

/** 当日已知结果、待追加条目、文件游标及 flush timer 的唯一 owner。 */
export const luckWorkerCache: { current: LuckDayCache | null } = { current: null };
/** 尚未追加到当日文件的抽签条目；flush 成功后按批清除。 */
export const luckPendingAppends: LuckPendingEntry[] = [];
/**
 * 因旧日刷盘失败而暂缓换 owner 的新一天抽签，等 owner 切过去之后补录。
 *
 * - 填充：`handleLuckDrawMessage` 判定需要换日、但 `flushLuckAppends()` 失败时，
 *   把这条新日消息挪进来。
 * - 清理：luckFiles.ts 在 owner 就绪后整批取走并逐条重新登记——switchLuckDay（新一天的首条
 *   抽签、跨日取密钥、每日维护）先取走再换 owner，retryLuckFlush 与每日维护在旧日刷盘
 *   成功后直接补录；`hydrateLuckCache` 换 owner 时清空剩余。
 * - 容量：上界 `LUCK_DEFERRED_DRAW_MAX`，超出丢最旧的一条并 console.error。
 * - Worker 崩溃重建：随线程一起消失，由 infra/diskIO.ts 的 onDiskIORespawn
 *   全量重放主线程 dailyLuckCache 补齐。
 * - 「空」表示当前没有待补录的跨日抽签；发生过滞留而被丢弃时，容量日志是唯一记录。
 * - 故障跨过整整一个自然日时，补录发现 owner 已走到更后面的一天，这些条目
 *   按「过期抽签」丢弃并各记一行。
 */
export const luckDeferredDraws: LuckDrawDiskMessage[] = [];
/** 当前运势追加文件游标；hydrate、跨日或 reset 时清空并按需重开。 */
export const luckFileState: { current: DayFileState | null } = { current: null };
/** 运势增量批量刷盘 timer；首次 dirty 创建，flush/reset 时清除。 */
export const luckFlushTimer: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/**
 * 运势追加的连续失败计数与「本轮已告警」标记，服务于 luckAppendStalled 诊断
 * （阈值见 consts/diskIO/appendOnly.ts 的 LUCK_APPEND_STALL_ALERT_FAILURES）。
 *
 * - 填充：`flushLuckAppends` 每次追加失败 +1。
 * - 清理：追加成功即整体归零，`hydrateLuckCache` 换 owner 时一并归零。
 * - 容量：两个标量。
 * - `alerted` 使告警边沿触发：一次故障期只进 `logs/` 一行；追加成功后重新武装。
 * - Worker 崩溃重建：随线程一起归零，重建后的首次连续失败重新触发告警。
 */
export const luckAppendFailures: { consecutive: number; alerted: boolean } =
  { consecutive: 0, alerted: false };

/**
 * 运势追加停摆诊断的投递出口（`self.postMessage` 包装），由 diskIOWorker.ts 的
 * startDiskIOWorker 在线程启动时装一次，此后不变。
 *
 * - 填充：startDiskIOWorker 直接赋值（仅 Worker 线程启动路径）。
 * - 清理：随线程终止一起消失；不随跨日或 hydrate 重置，它是线程级出口，不属于当日 owner。
 * - 「无条目」（current 为 null）表示本线程尚未装上诊断出口，此时追加失败只有 console.error。
 */
export const luckAppendStalledNotifier: {
  current: ((reply: LuckAppendStalledReply) => void) | null;
} = { current: null };

/** 启动恢复或跨日时整体替换当日缓存并清除待刷批次、timer 和游标。 */
export function hydrateLuckCache(day: LuckDayCache | null): void {
  if (luckFlushTimer.timer !== null) clearTimeout(luckFlushTimer.timer);
  luckFlushTimer.timer = null;
  luckWorkerCache.current = day;
  luckPendingAppends.length = 0;
  luckDeferredDraws.length = 0;
  luckFileState.current = null;
  // 待刷批次整体丢弃，失败计数随之归零。
  luckAppendFailures.consecutive = 0;
  luckAppendFailures.alerted = false;
}

/** 创建并接管新的配置时区的日期缓存；旧日期运行态被完整清除。 */
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
