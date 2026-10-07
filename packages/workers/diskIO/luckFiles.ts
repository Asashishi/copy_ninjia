/**
 * 每日运势的缓冲/落盘逻辑：接收 diskIOWorker.ts 路由来的 luckDraw 消息，
 * 先进内存缓冲（luckPendingAppends），攒满 FLUSH_MAX_ENTRIES 条、或距首条
 * 入队 FLUSH_INTERVAL_MS 时批量追加进 memory/luck/YYYY-MM-DD.json（窗口阈值见
 * consts/diskIO/appendOnly.ts）。按位置追加的字节机制见 appendOnlyDayFile.ts，
 * 追加/清理的文件读写在 snapshotFiles.ts；本文件持有的是「什么时候刷、刷
 * 什么」的领域状态调度（状态本体在 cache/workers/diskIO/luck.ts）。
 *
 * 本文件运行在磁盘 IO 线程里，自身错误一律 console.error（journal 兜底），
 * 见 workers/diskIOWorker.ts 模块头。
 */

import {
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_ENTRIES,
  LUCK_APPEND_STALL_ALERT_FAILURES,
  LUCK_DEFERRED_DRAW_MAX,
} from "../../consts/diskIO/appendOnly";
import {
  hydrateLuckCache,
  luckAppendFailures,
  luckAppendStalledNotifier,
  luckDeferredDraws,
  luckFileState,
  luckFlushTimer,
  luckPendingAppends,
  luckWorkerCache,
  markLuckDirty,
  startLuckDay,
} from "../../cache/workers/diskIO/luck";
import {
  appendLuckEntries,
  cleanupStaleLuckFiles,
  recoverLuckDay,
} from "./snapshotFiles";
import type { LuckDrawDiskMessage } from "../../types/diskIO/messages";
import type { DayFileState, LuckDayCache, LuckDrawRecord } from "../../types/diskIO/storage";
import type { LuckDayRecoveryInspection } from "./snapshotFiles";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";
import { errorMessage } from "../../libs/errorMessage";

/**
 * 一次定时重试：刷盘，成功且还压着跨日滞留条目时立刻补录。运势追加缓冲的定时落盘
 * 与追加失败后的重排都经 timedFlush.ts 的 armDiskIOFlushTimer 装到 luckFlushTimer
 * 上，触发时执行本函数；条数达到 FLUSH_MAX_ENTRIES 时由 handleLuckDrawMessage 直接调
 * flushLuckAppends 立即落盘。
 *
 * 「刷」与「补录」只在这条重试路径上组合，不在 flushLuckAppends() 内：两条换日路径
 * 先调 flushLuckAppends 再经 switchLuckDay 切 owner，按 switchLuckDay 的顺序补录
 * （先取走滞留区、再切 owner、最后逐条重放）。重试由定时器驱动，不依赖后续 luckDraw
 * 消息。导出供单测直接驱动这一跳。
 */
export async function retryLuckFlush(): Promise<void> {
  if (await flushLuckAppends()) await replayDeferredLuckDraws(takeDeferredLuckDraws());
}

/**
 * 把这条「新一天」的抽签挪进滞留区，等旧日刷得动、owner 换过去之后补录。
 * 主线程的 dailyLuckCache 已记下这条抽签并发出回执；onDiskIORespawn 的全量重放只覆盖
 * Worker 重建。
 *
 * 跨模块约束（换日、滞留补录与上界）完整表述见 docs/cn/04-invariants.md 的
 * 「运势与 AI 记忆恢复」。
 */
function deferLuckDraw(msg: LuckDrawDiskMessage): void {
  if (luckDeferredDraws.length >= LUCK_DEFERRED_DRAW_MAX) {
    const dropped: LuckDrawDiskMessage | undefined = luckDeferredDraws.shift();
    console.error(
      `[diskIOWorker] deferred luck draw buffer is full (${LUCK_DEFERRED_DRAW_MAX}); ` +
      `dropped the oldest entry for ${dropped?.day ?? "?"}/${dropped?.key ?? "?"}`
    );
  }
  luckDeferredDraws.push(msg);
}

/** 取走全部滞留抽签；没有滞留时返回 null，不分配数组。 */
function takeDeferredLuckDraws(): LuckDrawDiskMessage[] | null {
  return luckDeferredDraws.length > 0 ? luckDeferredDraws.splice(0, luckDeferredDraws.length) : null;
}

/** 逐条补录取走的滞留抽签；换日与过期判定由重新登记那一遍自己做。 */
export async function replayDeferredLuckDraws(
  deferred: readonly LuckDrawDiskMessage[] | null
): Promise<void> {
  if (deferred === null) return;
  for (const pending of deferred) await handleLuckDrawMessage(pending);
}

/**
 * 换日切换 owner 的统一顺序：先取走滞留抽签（hydrateLuckCache 会连同追加缓冲一并清空
 * 滞留区），再以目标日接管 owner——recoverFromDisk 为 true 时按磁盘严格恢复（跨日取密钥），
 * 否则新建空 owner（新一天的首条抽签）。磁盘恢复抛错时滞留原样放回、owner 不变。
 * 调用方须已刷出旧日缓冲，并在 owner 就绪后把返回值交给 replayDeferredLuckDraws 补录。
 */
export async function switchLuckDay(
  day: string,
  recoverFromDisk: boolean
): Promise<LuckDrawDiskMessage[] | null> {
  const deferred: LuckDrawDiskMessage[] | null = takeDeferredLuckDraws();
  if (!recoverFromDisk) {
    startLuckDay(day);
    return deferred;
  }
  try {
    await hydrateLuckDay(day);
  } catch (error: unknown) {
    if (deferred !== null) luckDeferredDraws.unshift(...deferred);
    throw error;
  }
  return deferred;
}

/**
 * 把运势待追加缓冲追加写盘（先清掉可能挂起的定时器）。追加失败保留 pending 重试，
 * 并重置文件探测状态（下次重新 openDayFile 校验/修复文件，同 logFiles.ts writeDay）、
 * 重排定时器。过期文件清理放在追加成功、pending 清空之后，清理抛错只影响清理本身。
 *
 * 连续失败到 LUCK_APPEND_STALL_ALERT_FAILURES 次时，除 console.error 外额外向
 * 主线程发一条 luckAppendStalled 诊断。告警边沿触发，一次故障期只发一条
 * （见 cache/workers/diskIO/luck.ts 的 luckAppendFailures）。
 */
export async function flushLuckAppends(): Promise<boolean> {
  cancelDiskIOFlushTimer(luckFlushTimer);
  if (luckPendingAppends.length === 0) return true;
  if (!luckWorkerCache.current) return false;
  const day: string = luckWorkerCache.current.day;
  try {
    await appendLuckEntries(day, luckFileState, luckPendingAppends);
    luckPendingAppends.length = 0;
    luckAppendFailures.consecutive = 0;
    luckAppendFailures.alerted = false;
  } catch (error: unknown) {
    luckFileState.current = null;
    armDiskIOFlushTimer(luckFlushTimer, FLUSH_INTERVAL_MS, retryLuckFlush);
    console.error(`[diskIOWorker] failed to append luck entries for ${day}:`, error);
    luckAppendFailures.consecutive += 1;
    if (
      !luckAppendFailures.alerted &&
      luckAppendFailures.consecutive >= LUCK_APPEND_STALL_ALERT_FAILURES &&
      luckAppendStalledNotifier.current !== null
    ) {
      // 诊断投递抛出的异常不得逸出 onmessage（Worker 未捕获异常会终止整条落盘线程，
      // 见 diskIOWorker.ts handleDiskIOWorkerMessage 中「共享 SQLite 写消息的非法输入就地拒收」一段）。
      try {
        luckAppendStalledNotifier.current({
          type: "luckAppendStalled",
          day,
          pendingEntries: luckPendingAppends.length,
          consecutiveFailures: luckAppendFailures.consecutive,
          error: errorMessage(error),
        });
        // 只在投递成功后置位：出口未装上或投递失败时不视为已告警。
        luckAppendFailures.alerted = true;
      } catch (notifyError: unknown) {
        console.error("[diskIOWorker] failed to report stalled luck appends:", notifyError);
      }
    }
    return false;
  }
  try {
    await cleanupStaleLuckFiles(day);
  } catch (error: unknown) {
    console.error(`[diskIOWorker] failed to clean up stale luck files for ${day}:`, error);
  }
  return true;
}

/** 处理一条抽签结果消息：跨天检查 -> 去重 -> 入缓冲，达到条数阈值立即
 *  落盘，否则按需启动定时器。 */
export async function handleLuckDrawMessage(
  msg: LuckDrawDiskMessage
): Promise<void> {
  // YYYY-MM-DD 可按字典序判断方向；重放的旧消息（msg.day 早于当前 owner 日）不回拨 owner。
  const current: LuckDayCache | null = luckWorkerCache.current;
  if (current === null || msg.day > current.day) {
    // startLuckDay 经 hydrateLuckCache 清空 luckPendingAppends，跨日切换前先把旧日
    // 已确认结果刷盘；刷不动就不切 owner，这条新日抽签留在滞留区等补录（见 deferLuckDraw）。
    // 口径与 workers/diskIOWorker.ts 的 handleEnsureLuckSecret 一致。
    if (current !== null && !await flushLuckAppends()) {
      deferLuckDraw(msg);
      console.error(
        `[diskIOWorker] refused to switch the luck day from ${current.day} to ${msg.day}: ` +
        `the previous day's confirmed results could not be flushed; ` +
        `deferred ${luckDeferredDraws.length} draw(s) until the flush succeeds`
      );
      return;
    }
    const deferred: LuckDrawDiskMessage[] | null = await switchLuckDay(msg.day, false);
    // 滞留的那些比本条更早发生，切完先补录；此刻滞留区已空，重入不会再递归一层。
    await replayDeferredLuckDraws(deferred);
  }

  // 重新取 owner：补录滞留条目期间 owner 可能已前进到更新的一天，此时这条是过期消息，
  // 与 msg.day < current.day 同一种处置。
  const dayCache: LuckDayCache | null = luckWorkerCache.current;
  if (dayCache?.day !== msg.day) {
    console.error(
      `[diskIOWorker] discarded stale luck draw for ${msg.day}; current luck day is ${dayCache?.day ?? "none"}`
    );
    return;
  }
  // 去重按「key + 值」：值也一样才算重复（Worker 重建后主线程全量重放 dailyLuckCache，
  // 见 infra/diskIO.ts 的 onDiskIORespawn）；同 key 不同值的消息照常追加，
  // JSON.parse 只认最后一次出现，恢复时取到最新值。
  const record: LuckDrawRecord = { label: msg.label, fortunePercent: msg.fortunePercent };
  const known: LuckDrawRecord | undefined = dayCache.entries.get(msg.key);
  if (known?.label === record.label && known.fortunePercent === record.fortunePercent) return;
  dayCache.entries.set(msg.key, record);
  const pendingEntries: number = markLuckDirty({ key: msg.key, record });
  if (pendingEntries >= FLUSH_MAX_ENTRIES) {
    await flushLuckAppends();
  } else {
    armDiskIOFlushTimer(luckFlushTimer, FLUSH_INTERVAL_MS, retryLuckFlush);
  }
}

/**
 * 按磁盘现状严格恢复目标日的结果，并以恢复结果整体替换内存 owner 与追加游标；恢复同时
 * 清理临时文件与过期日文件。换日经 switchLuckDay 调用（跨日取密钥与每日维护）；启动恢复走
 * inspectLuckDay/adoptLuckDay 两阶段。
 */
export async function hydrateLuckDay(day: string): Promise<void> {
  const recoveredFileState: { current: DayFileState | null } = { current: null };
  const recovered: LuckDayCache | null = await recoverLuckDay(day, recoveredFileState);
  hydrateLuckCache(recovered);
  // hydrate 先清掉上一 owner 的游标，再接管与本次领域校验同一轮读取得到的新游标。
  luckFileState.current = recoveredFileState.current;
}

/** 跨域启动第二阶段：全部领域 inspect 成功后整体发布到 owner 缓存。 */
export function adoptLuckDay(
  inspection: LuckDayRecoveryInspection
): void {
  hydrateLuckCache(inspection.cache);
  luckFileState.current = inspection.fileState;
}

/**
 * 每日维护先提交旧 owner 与故障期滞留抽签，再经 switchLuckDay 严格接管目标日并清理更早
 * 文件，接管后补录这期间重新滞留的抽签。目标日落后于当前 owner 时拒绝回拨。
 */
export async function maintainLuckForDay(day: string): Promise<void> {
  const currentDay: string | undefined = luckWorkerCache.current?.day;
  if (currentDay !== undefined && day < currentDay) return;
  if (!await flushLuckAppends()) {
    throw new Error(`Failed to flush luck results before daily maintenance for ${day}.`);
  }
  await replayDeferredLuckDraws(takeDeferredLuckDraws());
  if (!await flushLuckAppends()) {
    throw new Error(`Failed to flush deferred luck results before daily maintenance for ${day}.`);
  }
  if (luckWorkerCache.current?.day !== undefined && luckWorkerCache.current.day > day) return;
  await replayDeferredLuckDraws(await switchLuckDay(day, true));
}
