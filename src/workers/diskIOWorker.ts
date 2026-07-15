/**
 * 磁盘 IO 线程（Bun Worker）：进程内所有磁盘 IO 收在这一条线程里串行执行——
 * 日志（error 级）与 AI 记忆快照（各群滚动缓存 + 中期摘要）两类数据统一
 * 由它落盘。日志线程本来就是"唯一落盘线程"的定位（多实例并发追加同一个
 * 文件会互相踩踏写坏），再开一个专门落盘 AI 记忆的 Worker 就有两个 IO
 * 线程，违背这个定位；两类负载都是低频小文件写，合在一条线程串行执行
 * 天然免锁。原名 loggerWorker，只做日志；现扩展改名 diskIOWorker。
 *
 * 本文件只做消息路由、统一 flush 调度、启动恢复编排；具体逻辑分别在
 * diskIO/logFiles.ts（日志的缓冲/追加）与 diskIO/snapshotFiles.ts（AI 记忆
 * 的整份覆盖写 + 启动恢复），日志的按位置追加/损坏修复字节机制在
 * diskIO/appendOnlyDayFile.ts。
 *
 * 原则：磁盘只在启动恢复（load）时被读一次；此后缓存（cache/diskIOWorker.ts）
 * 是唯一事实源，写是「缓存 -> 磁盘」的单向定时同步。本线程自身的内部错误
 * 一律 console.error（journal 兜底）——它就是落盘终点，不能再指望被自己
 * 转发的日志落盘自己的错误，那是一场递归。
 */

import { mkdirSync } from "node:fs";
import { flushLogBuffer, handleLogMessage, initLogFiles } from "./diskIO/logFiles";
import { recoverAiMemories, writeAiMemoryFile } from "./diskIO/snapshotFiles";
import { LOGS_DIR, MEMORY_DIR } from "../consts/paths";
import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../consts/diskIO";
import { aiMemoryCache, dirtyChats, snapshotFlushState } from "../cache/diskIOWorker";
import type { DiskFlushReply, DiskIOMessage, LoadedReply } from "../types";

declare var self: Worker;

initLogFiles();

/** 按需启动 AI 记忆快照的定时落盘；已有定时器在跑就不重复排。 */
function scheduleSnapshotFlush(): void {
  if (snapshotFlushState.timer !== null) return;
  snapshotFlushState.timer = setTimeout(() => {
    snapshotFlushState.timer = null;
    flushAiMemory();
  }, SNAPSHOT_FLUSH_INTERVAL_MS);
}

/** 把 dirty 的 AI 记忆快照整份写盘；单份写失败保留 dirty（不从 dirtyChats
 *  摘除），下轮重试。 */
function flushAiMemory(): void {
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
}

/** 统一 flush：日志缓冲、AI 记忆快照全部立即落盘（进程退出前的最后一刷，
 *  各自的窗口阈值在这里不生效——不管有没有攒够条数/等够时间，该刷的都
 *  立即刷）。 */
function flushAll(): void {
  flushLogBuffer();
  if (snapshotFlushState.timer !== null) {
    clearTimeout(snapshotFlushState.timer);
    snapshotFlushState.timer = null;
  }
  flushAiMemory();
}

/**
 * 启动恢复（也是本 Worker 崩溃重建后自动重跑的那一步，见 infra/diskIO.ts）：
 * 建目录、扫描解析校验 memory/，先灌进自己的缓存，再把缓存内容作为
 * loaded 回执发给主线程。失败不让整个 Worker 崩掉——尽量用已恢复到的部分
 * 继续，回执照发。
 */
function handleLoad(): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    mkdirSync(MEMORY_DIR, { recursive: true });

    for (const [chatId, snapshot] of recoverAiMemories()) {
      aiMemoryCache.set(chatId, snapshot);
    }
  } catch (error) {
    console.error("[diskIOWorker] startup recovery failed, continuing with whatever was recovered so far:", error);
  }

  const reply: LoadedReply = {
    type: "loaded",
    aiMemories: aiMemoryCache,
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
