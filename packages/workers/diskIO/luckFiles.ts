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

import { FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES } from "../../consts/diskIO/appendOnly";
import {
  hydrateLuckCache,
  luckFileState,
  luckFlushTimer,
  luckPendingAppends,
  luckWorkerCache,
  markLuckDirty,
  startLuckDay,
} from "../../cache/workers/diskIO/luck";
import { appendLuckEntries, cleanupStaleLuckFiles, recoverLuckDay } from "./snapshotFiles";
import type { LuckDrawDiskMessage } from "../../types/diskIO";
import type { LuckDayCache, LuckDrawRecord } from "../../types/diskIO/storage";

/** 按需启动运势追加缓冲的定时落盘；已有定时器在跑就不重复排。条数达到
 *  FLUSH_MAX_ENTRIES 时不经过这个定时器，由 handleLuckDrawMessage 直接调
 *  flushLuckAppends 立即落盘。 */
function scheduleLuckFlush(): void {
  if (luckFlushTimer.timer !== null) return;
  luckFlushTimer.timer = setTimeout((): void => {
    luckFlushTimer.timer = null;
    flushLuckAppends();
  }, FLUSH_INTERVAL_MS);
}

/**
 * 把运势待追加缓冲追加写盘（先清掉可能挂起的定时器，避免它日后再触发一次
 * 空落盘）。追加失败保留 pending 重试，并且：重置文件探测状态（下次重新
 * openDayFile 校验/修复文件，对齐 logFiles.ts writeDay 的做法，不在可能已
 * 损坏的结尾上盲写）、重排定时器——运势是低频写入，不重排的话「下轮重试」
 * 要等到下一条 luckDraw 消息才会发生，条目可能在内存里滞留几个小时。
 * 过期文件清理放在追加成功、pending 清空之后：它一旦抛错只影响清理本身，
 * 不能连累已经写进磁盘的条目被当作「没写过」再追加一遍。
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
  } catch (error: unknown) {
    luckFileState.current = null;
    scheduleLuckFlush();
    console.error(`[diskIOWorker] failed to append luck entries for ${day}:`, error);
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
  let dayCache: LuckDayCache;
  if (current === null || msg.day > current.day) {
    dayCache = startLuckDay(msg.day);
  } else if (msg.day < current.day) {
    console.error(
      `[diskIOWorker] discarded stale luck draw for ${msg.day}; current luck day is ${current.day}`
    );
    return;
  } else {
    dayCache = current;
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
  hydrateLuckCache(recoverLuckDay(day));
}
