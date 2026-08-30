/**
 * 每日运势的缓冲/落盘逻辑：接收 diskIOWorker.ts 路由来的 luckDraw 消息，
 * 先进内存缓冲（luckPendingAppends），攒满 FLUSH_MAX_ENTRIES 条、或距首条
 * 入队 FLUSH_INTERVAL_MS 时批量追加进 memory/luck/YYYY-MM-DD.json——与
 * diskIO/logFiles.ts 的 handleLogMessage/flushLogBuffer 完全对称，共用同
 * 一组窗口阈值（见 consts/diskIO/appendOnly.ts），只是缓冲区、定时器、落盘目标各自
 * 独立，互不影响。按位置追加/损坏修复的字节机制见 appendOnlyDayFile.ts，
 * 追加/清理的纯函数在 snapshotFiles.ts；本文件持有的是「什么时候刷、刷
 * 什么」的领域状态调度（状态本体在 cache/workers/diskIO/luck.ts）。
 *
 * 本文件运行在磁盘 IO 线程里，自身错误一律 console.error（journal 兜底），
 * 理由见 workers/diskIOWorker.ts 模块头。
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
  inspectLuckDay,
  maintainLuckDay,
  recoverLuckDay,
} from "./snapshotFiles";
import type { LuckDrawDiskMessage } from "../../types/diskIO/messages";
import type { LuckAppendStalledReply } from "../../types/diskIO/replies";
import type { DayFileState, LuckDayCache, LuckDrawRecord } from "../../types/diskIO/storage";
import type { LuckDayRecoveryInspection } from "./snapshotFiles";

/** 装上运势追加停摆诊断的投递出口（仅 Worker 线程启动时调用一次）。 */
export function configureLuckAppendStalledReply(
  notify: (reply: LuckAppendStalledReply) => void
): void {
  luckAppendStalledNotifier.current = notify;
}

/** 按需启动运势追加缓冲的定时落盘；已有定时器在跑就不重复排。条数达到
 *  FLUSH_MAX_ENTRIES 时不经过这个定时器，由 handleLuckDrawMessage 直接调
 *  flushLuckAppends 立即落盘。 */
function scheduleLuckFlush(): void {
  if (luckFlushTimer.timer !== null) return;
  luckFlushTimer.timer = setTimeout(retryLuckFlush, FLUSH_INTERVAL_MS);
}

/**
 * 一次定时重试：刷盘，成功且还压着跨日滞留条目时立刻补录。
 *
 * 补录不能挪进 flushLuckAppends()：handleLuckDrawMessage 的换日分支正是先调它
 * 再 startLuckDay，若它自己顺手补录，补录建立的新 owner 会紧接着被那句
 * startLuckDay 连同刚入队的条目一起清掉。所以「刷」与「补录」只在这条重试路径
 * 上组合，换日路径按自己的顺序来（先取走滞留区、再切 owner、最后逐条重放）。
 *
 * 也不能等下一条 luckDraw 消息来推动：运势是每人每天一次的低频写入，「下一条」
 * 可能在几个小时之后，也可能今天再也没有——那时磁盘早就恢复了，条目却还只活在
 * 内存里。导出是为了让单测直接驱动这一跳，不必真等 FLUSH_INTERVAL_MS，也不必去
 * 碰 Timeout 的运行时内部字段。
 */
export function retryLuckFlush(): void {
  luckFlushTimer.timer = null;
  if (flushLuckAppends() && luckDeferredDraws.length > 0) drainDeferredLuckDraws();
}

/**
 * 把这条「新一天」的抽签挪进滞留区，等旧日刷得动、owner 换过去之后补录。
 *
 * 直接丢是不行的：主线程的 dailyLuckCache 早已把它记成「今天抽过了」并给用户
 * 发了回执，磁盘恢复后当天文件却永远缺这一条，用户当天也再抽不了第二次——
 * onDiskIORespawn 的全量重放只覆盖 Worker 重建，覆盖不到「Worker 活着但写不进盘」。
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

/** 取走全部滞留抽签并逐条重新登记（换日判定由重新登记那一遍自己做）。 */
function drainDeferredLuckDraws(): void {
  const deferred: LuckDrawDiskMessage[] = luckDeferredDraws.splice(0, luckDeferredDraws.length);
  for (const pending of deferred) handleLuckDrawMessage(pending);
}

/**
 * 把运势待追加缓冲追加写盘（先清掉可能挂起的定时器，避免它日后再触发一次
 * 空落盘）。追加失败保留 pending 重试，并且：重置文件探测状态（下次重新
 * openDayFile 校验/修复文件，对齐 logFiles.ts writeDay 的做法，不在可能已
 * 损坏的结尾上盲写）、重排定时器——运势是低频写入，不重排的话「下轮重试」
 * 要等到下一条 luckDraw 消息才会发生，条目可能在内存里滞留几个小时。
 * 过期文件清理放在追加成功、pending 清空之后：它一旦抛错只影响清理本身，
 * 不能连累已经写进磁盘的条目被当作「没写过」再追加一遍。
 *
 * 连续失败到 LUCK_APPEND_STALL_ALERT_FAILURES 次时，除 console.error 外额外向
 * 主线程发一条 luckAppendStalled 诊断：本 Worker 的 console 在把 stdout/stderr
 * 接到 /dev/null 的部署上等于没有，而运势「内存有、磁盘没有」在别处无迹可寻。
 * 告警边沿触发，一次故障期只发一条（见 cache/workers/diskIO/luck.ts 的
 * luckAppendFailures）。
 */
export function flushLuckAppends(): boolean {
  if (luckFlushTimer.timer !== null) {
    clearTimeout(luckFlushTimer.timer);
    luckFlushTimer.timer = null;
  }
  if (luckPendingAppends.length === 0) return true;
  if (!luckWorkerCache.current) return false;
  const day: string = luckWorkerCache.current.day;
  try {
    appendLuckEntries(day, luckFileState, luckPendingAppends);
    luckPendingAppends.length = 0;
    luckAppendFailures.consecutive = 0;
    luckAppendFailures.alerted = false;
  } catch (error: unknown) {
    luckFileState.current = null;
    scheduleLuckFlush();
    console.error(`[diskIOWorker] failed to append luck entries for ${day}:`, error);
    luckAppendFailures.consecutive += 1;
    if (
      !luckAppendFailures.alerted &&
      luckAppendFailures.consecutive >= LUCK_APPEND_STALL_ALERT_FAILURES &&
      luckAppendStalledNotifier.current !== null
    ) {
      // 诊断投递自己抛出绝不能逸出 onmessage：Bun 里 Worker 的未捕获异常会
      // 直接终止整条落盘线程（见 diskIOWorker.ts 的 joinLog 分支），那等于为了
      // 一行告警把 AI 记忆、黑名单、待验证的缓冲一起赔进去——而这条路径恰恰
      // 只在写盘已经出问题时才走到。
      try {
        luckAppendStalledNotifier.current({
          type: "luckAppendStalled",
          day,
          pendingEntries: luckPendingAppends.length,
          consecutiveFailures: luckAppendFailures.consecutive,
          error: error instanceof Error ? error.message : String(error),
        });
        // 只在真正投出去之后才置位：出口没装上、或投递失败时不能把这一轮当成
        // 已告警，否则这段故障期就永远不会再报。
        luckAppendFailures.alerted = true;
      } catch (notifyError: unknown) {
        console.error("[diskIOWorker] failed to report stalled luck appends:", notifyError);
      }
    }
    return false;
  }
  try {
    cleanupStaleLuckFiles(day);
  } catch (error: unknown) {
    console.error(`[diskIOWorker] failed to clean up stale luck files for ${day}:`, error);
  }
  return true;
}

/** 处理一条抽签结果消息：跨天检查 -> 去重 -> 入缓冲，达到条数阈值立即
 *  落盘，否则按需启动定时器。 */
export function handleLuckDrawMessage(msg: LuckDrawDiskMessage): void {
  // YYYY-MM-DD 可按字典序判断方向。Worker 重建后可能重放跨零点前缓冲的旧
  // 消息；它不能把已恢复的当天 owner 拍回昨日，更不能让后续清理误删当天文件。
  const current: LuckDayCache | null = luckWorkerCache.current;
  if (current === null || msg.day > current.day) {
    // startLuckDay 会经 hydrateLuckCache 把 luckPendingAppends 整个清零，因此
    // 跨日切换前必须先把旧日已确认结果刷盘——否则还在 30 秒批量窗口里的条目
    // 一次都没写盘就被丢掉，而丢失是完全静默的。刷不动就不切 owner，但这条新日
    // 抽签本身要留在滞留区等补录（见 deferLuckDraw：丢掉它同样是静默丢盘，只是
    // 丢的是新一天那侧）。口径与 workers/diskIOWorker.ts 的 ensureLuckSecret 分支一致。
    if (current !== null && !flushLuckAppends()) {
      deferLuckDraw(msg);
      console.error(
        `[diskIOWorker] refused to switch the luck day from ${current.day} to ${msg.day}: ` +
        `the previous day's confirmed results could not be flushed; ` +
        `deferred ${luckDeferredDraws.length} draw(s) until the flush succeeds`
      );
      return;
    }
    // hydrateLuckCache 会把滞留区一并清空，所以取走必须早于 startLuckDay。
    // 先判空再 splice：正常的午夜换日一条滞留都没有，无条件 splice 等于每天在这
    // 条路径上白分配一个空数组（滞留只在磁盘故障期出现，是彻头彻尾的冷路径）。
    const deferred: readonly LuckDrawDiskMessage[] | null = luckDeferredDraws.length > 0
      ? luckDeferredDraws.splice(0, luckDeferredDraws.length)
      : null;
    startLuckDay(msg.day);
    // 滞留的那些比本条更早发生，切完先补录；此刻滞留区已空，重入不会再递归一层。
    if (deferred !== null) {
      for (const pending of deferred) handleLuckDrawMessage(pending);
    }
  }

  // 重新取一次 owner：上面补录滞留条目时，万一夹着比 msg 更新的一天，owner 已经
  // 又往前走了一步，这条就成了过期消息，与 msg.day < current.day 是同一种处置。
  const dayCache: LuckDayCache | null = luckWorkerCache.current;
  if (dayCache?.day !== msg.day) {
    console.error(
      `[diskIOWorker] discarded stale luck draw for ${msg.day}; current luck day is ${dayCache?.day ?? "none"}`
    );
    return;
  }
  // 去重按「key + 值」而不是只看 key：值也一样才算重复（本 Worker 崩溃
  // 重建后主线程会把 dailyLuckCache 全量重放一遍，见 infra/diskIO.ts 的
  // onDiskIORespawn，其中多数条目已经在崩溃前落过盘，不去重会白占地方）。
  // 只看 key 会挡住合法的同 key 改值：restoreLuckState 因 LUCK_TIERS 改动
  // 丢弃磁盘旧记录后用户当天重抽，新结果就是同 key 不同值，必须落盘覆盖，
  // 否则每次重启都会重抽出不同结果。重复 key 追加是安全的——JSON.parse
  // 只认最后一次出现，恢复时天然取到最新值。
  const record: LuckDrawRecord = { label: msg.label, fortunePercent: msg.fortunePercent };
  const known: LuckDrawRecord | undefined = dayCache.entries.get(msg.key);
  if (known?.label === record.label && known.fortunePercent === record.fortunePercent) return;
  dayCache.entries.set(msg.key, record);
  const pendingEntries: number = markLuckDirty({ key: msg.key, record });
  if (pendingEntries >= FLUSH_MAX_ENTRIES) {
    flushLuckAppends();
  } else {
    scheduleLuckFlush();
  }
}

/** 启动恢复边界：只读当天文件并以恢复结果整体替换内存 owner。 */
export function hydrateLuckDay(day: string): void {
  const recoveredFileState: { current: DayFileState | null } = { current: null };
  const recovered: LuckDayCache | null = recoverLuckDay(day, recoveredFileState);
  hydrateLuckCache(recovered);
  // hydrate 先清掉上一 owner 的游标，再接管与本次领域校验同一轮读取得到的新游标。
  luckFileState.current = recoveredFileState.current;
}

/** 跨域启动第一阶段：只读恢复当天结果与追加游标。 */
export function inspectLuckDayState(day: string): LuckDayRecoveryInspection {
  return inspectLuckDay(day);
}

/** 跨域启动第二阶段：全部领域 inspect 成功后整体发布到 owner 缓存。 */
export function adoptLuckDay(
  inspection: LuckDayRecoveryInspection
): void {
  hydrateLuckCache(inspection.cache);
  luckFileState.current = inspection.fileState;
}

/** 跨域启动成功后清理临时与过期日文件。 */
export function maintainLuckDayState(
  day: string,
  inspection: LuckDayRecoveryInspection
): void {
  maintainLuckDay(day, inspection);
}

/**
 * 每日维护先提交旧 owner 与故障期滞留抽签，再严格接管目标日并清理更早文件。
 * 目标日落后于当前 owner 时拒绝回拨，避免时钟回拨误删当前数据。
 */
export function maintainLuckForDay(day: string): void {
  const currentDay: string | undefined = luckWorkerCache.current?.day;
  if (currentDay !== undefined && day < currentDay) return;
  if (!flushLuckAppends()) {
    throw new Error(`Failed to flush luck results before daily maintenance for ${day}.`);
  }
  if (luckDeferredDraws.length > 0) drainDeferredLuckDraws();
  if (!flushLuckAppends()) {
    throw new Error(`Failed to flush deferred luck results before daily maintenance for ${day}.`);
  }
  if (luckWorkerCache.current?.day !== undefined && luckWorkerCache.current.day > day) return;
  hydrateLuckDay(day);
}
