/**
 * 磁盘 IO 线程（Bun Worker）：进程内所有磁盘 IO 收在这一条线程里串行执行——
 * 日志（error 级）、AI 记忆快照（各群滚动缓存 + 中期摘要）、每日运势缓存
 * 三类数据统一由它落盘。日志线程本来就是"唯一落盘线程"的定位（多实例
 * 并发追加同一个文件会互相踩踏写坏），再开一个专门落盘 AI 记忆/运势的
 * Worker 就有两个 IO 线程，违背这个定位；三类负载都是低频小文件写，
 * 合在一条线程串行执行天然免锁。原名 loggerWorker，只做日志；现扩展为
 * 三合一，改名 diskIOWorker。
 *
 * 本文件只做消息路由、统一 flush 调度、启动恢复编排；具体逻辑分别在
 * diskIO/logFiles.ts（日志）与 diskIO/snapshotFiles.ts（AI 记忆的整份
 * 覆盖写 + 运势的按位置追加写 + 两者的启动恢复），两者共用的追加/损坏
 * 修复字节机制在 diskIO/appendOnlyDayFile.ts。
 *
 * 原则：磁盘只在启动恢复（load）时被读一次；此后缓存（cache/diskIOWorker.ts）
 * 是唯一事实源，写是「缓存 -> 磁盘」的单向定时同步。本线程自身的内部错误
 * 一律 console.error（journal 兜底）——它就是落盘终点，不能再指望被自己
 * 转发的日志落盘自己的错误，那是一场递归。
 */

import { mkdirSync } from "node:fs";
import { flushLogBuffer, handleLogMessage, initLogFiles } from "./diskIO/logFiles";
import { appendLuckEntries, cleanupStaleLuckFiles, recoverAiMemories, recoverLuckDay, writeAiMemoryFile } from "./diskIO/snapshotFiles";
import { AI_MEMORY_DIR, LOGS_DIR, LUCK_MEMORY_DIR } from "../consts/paths";
import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../consts/diskIO";
import { getTokyoDateKey } from "../libs/time";
import { aiMemoryCache, dirtyChats, luckFileState, luckPendingAppends, luckWorkerCache, snapshotFlushState } from "../cache/diskIOWorker";
import type { DiskFlushReply, DiskIOMessage, LoadedReply, LuckDrawRecord } from "../types";

declare var self: Worker;

initLogFiles();

/** 按需启动快照（AI 记忆 + 运势）的定时落盘；已有定时器在跑就不重复排。 */
function scheduleSnapshotFlush(): void {
  if (snapshotFlushState.timer !== null) return;
  snapshotFlushState.timer = setTimeout(() => {
    snapshotFlushState.timer = null;
    flushSnapshots();
  }, SNAPSHOT_FLUSH_INTERVAL_MS);
}

/** 把 dirty 的 AI 记忆快照整份写盘、把运势待追加缓冲追加写盘；失败的那一份
 *  保留待重试状态（dirtyChats 不摘除 / luckPendingAppends 不清空），下轮重试。 */
function flushSnapshots(): void {
  for (const chatId of dirtyChats) {
    const snapshot = aiMemoryCache.get(chatId);
    if (!snapshot) {
      // 理论不该发生（dirty 一定伴随一次 aiMemoryCache.set），防御性丢弃。
      dirtyChats.delete(chatId);
      continue;
    }
    try {
      writeAiMemoryFile(chatId, snapshot);
      dirtyChats.delete(chatId);
    } catch (error) {
      console.error(`[diskIOWorker] failed to write AI memory snapshot for chat ${chatId}:`, error);
    }
  }

  if (luckPendingAppends.length > 0 && luckWorkerCache.current) {
    const day: string = luckWorkerCache.current.day;
    try {
      appendLuckEntries(day, luckFileState, luckPendingAppends);
      cleanupStaleLuckFiles(day);
      luckPendingAppends.length = 0;
    } catch (error) {
      console.error(`[diskIOWorker] failed to append luck entries for ${day}:`, error);
    }
  }
}

/** 统一 flush：三类 dirty 数据全部立即落盘（进程退出前的最后一刷）。 */
function flushAll(): void {
  flushLogBuffer();
  if (snapshotFlushState.timer !== null) {
    clearTimeout(snapshotFlushState.timer);
    snapshotFlushState.timer = null;
  }
  flushSnapshots();
}

/**
 * 启动恢复（也是本 Worker 崩溃重建后自动重跑的那一步，见 infra/diskIO.ts）：
 * 建目录、扫描解析校验 memory/ai 与 memory/luck，先灌进自己的缓存，再把
 * 缓存内容作为 loaded 回执发给主线程。失败不让整个 Worker 崩掉——尽量
 * 用已恢复到的部分继续，回执照发。
 */
function handleLoad(): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    mkdirSync(AI_MEMORY_DIR, { recursive: true });
    mkdirSync(LUCK_MEMORY_DIR, { recursive: true });

    for (const [chatId, snapshot] of recoverAiMemories()) {
      aiMemoryCache.set(chatId, snapshot);
    }

    const todayKey: string = getTokyoDateKey();
    const luckDay = recoverLuckDay(todayKey);
    if (luckDay) luckWorkerCache.current = luckDay;
  } catch (error) {
    console.error("[diskIOWorker] startup recovery failed, continuing with whatever was recovered so far:", error);
  }

  const reply: LoadedReply = {
    type: "loaded",
    aiMemories: aiMemoryCache,
    luckDay: luckWorkerCache.current,
  };
  self.postMessage(reply);
}

self.onmessage = (event: MessageEvent<DiskIOMessage>) => {
  const msg: DiskIOMessage = event.data;
  switch (msg.type) {
    case "log":
      handleLogMessage(msg);
      break;
    case "aiMemory":
      aiMemoryCache.set(msg.chatId, msg.snapshot);
      dirtyChats.add(msg.chatId);
      scheduleSnapshotFlush();
      break;
    case "luckDraw": {
      // 跨天检查放在消息入口：day 与当前已知缓存不一致就视为跨天——旧 day
      // 已知的 key 集合、待追加缓冲、文件追加状态全部丢弃重建（旧 day 已是
      // 昨日黄花，不会再有消息带着旧 day 补写它的文件）；下一次 flush 落盘
      // 时 cleanupStaleLuckFiles 会顺带删除非当日文件。
      if (luckWorkerCache.current === null || luckWorkerCache.current.day !== msg.day) {
        luckWorkerCache.current = { day: msg.day, entries: new Map() };
        luckPendingAppends.length = 0;
        luckFileState.current = null;
      }
      // 去重：这个 key 今天已经见过（磁盘恢复带回的，或本次运行期间已经
      // 追加过的）就不再重复写——尤其是本 Worker 崩溃重建后，主线程会把
      // dailyLuckCache 全量重放一遍（见 infra/diskIO.ts 的
      // onDiskIORespawn），其中多数 key 其实已经在崩溃前成功落盘、也已经
      // 被这次重建的 handleLoad 读回 entries 里，不去重就会在文件里追加出
      // 重复 key（JSON.parse 只认最后一次出现，不会炸，但白占地方）。
      if (luckWorkerCache.current.entries.has(msg.key)) break;
      const record: LuckDrawRecord = { label: msg.label, fortunePercent: msg.fortunePercent };
      luckWorkerCache.current.entries.set(msg.key, record);
      luckPendingAppends.push({ key: msg.key, record });
      scheduleSnapshotFlush();
      break;
    }
    case "load":
      handleLoad();
      break;
    case "flush": {
      flushAll();
      const reply: DiskFlushReply = { type: "flushed", flushedId: msg.flushId };
      self.postMessage(reply);
      break;
    }
  }
};
