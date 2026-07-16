/**
 * 磁盘 IO 线程（Bun Worker）：进程内所有磁盘 IO 收在这一条线程里串行执行——
 * 日志（error 级）、AI 记忆快照（各群滚动缓存 + 中期摘要）、白名单贴纸包的
 * 目录快照、每日运势缓存四类数据统一由它落盘。日志线程本来就是"唯一落盘
 * 线程"的定位（多实例并发追加同一个文件会互相踩踏写坏），再开一个专门
 * 落盘 AI 记忆/贴纸目录/运势的 Worker 就有两个 IO 线程，违背这个定位；
 * 四类负载都是低频小文件写，合在一条线程串行执行天然免锁。原名
 * loggerWorker，只做日志；现扩展为四合一，改名 diskIOWorker。
 *
 * 本文件只做消息路由、统一 flush 调度、启动恢复编排；具体逻辑分别在
 * diskIO/logFiles.ts（日志的缓冲/追加）、diskIO/luckFiles.ts（运势的缓冲/
 * 追加）与 diskIO/snapshotFiles.ts（AI 记忆/贴纸目录的整份覆盖写 + 运势的
 * 追加纯函数 + 三者的启动恢复），日志/运势共用的按位置追加/损坏修复字节
 * 机制在 diskIO/appendOnlyDayFile.ts。
 *
 * 原则：磁盘只在启动恢复（load）时被读一次；此后缓存（cache/diskIOWorker.ts）
 * 是唯一事实源，写是「缓存 -> 磁盘」的单向定时同步。本线程自身的内部错误
 * 一律 console.error（journal 兜底）——它就是落盘终点，不能再指望被自己
 * 转发的日志落盘自己的错误，那是一场递归。
 */

import { mkdirSync } from "node:fs";
import { flushLogBuffer, handleLogMessage, initLogFiles } from "./diskIO/logFiles";
import { flushLuckAppends, handleLuckDrawMessage } from "./diskIO/luckFiles";
import { recoverAiMemories, recoverLuckDay, recoverStickerCatalogs, writeAiMemoryFile, writeStickerCatalogFile } from "./diskIO/snapshotFiles";
import { stickerConfig } from "../ai/stickerConfig";
import { AI_MEMORY_DIR, LOGS_DIR, LUCK_MEMORY_DIR, STICKER_MEMORY_DIR } from "../consts/paths";
import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../consts/diskIO";
import { getTokyoDateKey } from "../libs/time";
import { aiMemoryCache, dirtyChats, dirtyStickerPacks, luckWorkerCache, snapshotFlushState, stickerCatalogCache } from "../cache/diskIOWorker";
import type { DiskFlushReply, DiskIOMessage, LoadedReply } from "../types";

declare var self: Worker;

initLogFiles();

/** 按需启动 AI 记忆快照 + 贴纸目录的定时落盘（两类数据共用同一个定时器，
 *  都是低频小文件覆盖写，没必要各开一条）；已有定时器在跑就不重复排。
 *  运势有自己独立的窗口（见 diskIO/luckFiles.ts），不共用这一条。 */
function scheduleSnapshotFlush(): void {
  if (snapshotFlushState.timer !== null) return;
  snapshotFlushState.timer = setTimeout(() => {
    snapshotFlushState.timer = null;
    flushSnapshots();
  }, SNAPSHOT_FLUSH_INTERVAL_MS);
}

/** 把 dirty 的 AI 记忆快照、dirty 的贴纸目录整份写盘；单份写失败保留 dirty
 *  （不从各自的 dirty 集合摘除），下轮重试。 */
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
  for (const pack of dirtyStickerPacks) {
    const snapshot = stickerCatalogCache.get(pack);
    if (!snapshot) {
      dirtyStickerPacks.delete(pack);
      continue;
    }
    try {
      writeStickerCatalogFile(pack, snapshot);
      dirtyStickerPacks.delete(pack);
    } catch (error) {
      console.error(`[diskIOWorker] failed to write sticker catalog for pack "${pack}":`, error);
    }
  }
}

/** 统一 flush：日志缓冲、AI 记忆快照、运势追加缓冲全部立即落盘（进程退出前
 *  的最后一刷，各自的窗口阈值在这里不生效——不管有没有攒够条数/等够时间，
 *  该刷的都立即刷）。 */
function flushAll(): void {
  flushLogBuffer();
  if (snapshotFlushState.timer !== null) {
    clearTimeout(snapshotFlushState.timer);
    snapshotFlushState.timer = null;
  }
  flushSnapshots();
  flushLuckAppends();
}

/**
 * 启动恢复（也是本 Worker 崩溃重建后自动重跑的那一步，见 infra/diskIO.ts）：
 * 建目录、扫描解析校验 memory/ai/、memory/stickers/ 与 memory/luck/，先灌进
 * 自己的缓存，再把缓存内容作为 loaded 回执发给主线程。失败不让整个 Worker
 * 崩掉——尽量用已恢复到的部分继续，回执照发。
 * memory/stickers/ 额外按当前 config/stickers.json 的白名单对账一次：白名单
 * 已经不包含的包，其持久化文件视为孤儿直接清掉（见 recoverStickerCatalogs）；
 * 包内部「哪些贴纸还在线上」的对账则在 aiChatWorker 那侧的
 * ai/stickerCatalog.ts 做（需要现查 Telegram，本线程没有 bot.api）。
 */
function handleLoad(): void {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    mkdirSync(AI_MEMORY_DIR, { recursive: true });
    mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
    mkdirSync(LUCK_MEMORY_DIR, { recursive: true });

    for (const [chatId, snapshot] of recoverAiMemories()) {
      aiMemoryCache.set(chatId, snapshot);
    }

    for (const [pack, snapshot] of recoverStickerCatalogs(stickerConfig.packs)) {
      stickerCatalogCache.set(pack, snapshot);
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
    stickerCatalogs: stickerCatalogCache,
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
    case "stickerCatalog":
      stickerCatalogCache.set(msg.pack, msg.snapshot);
      dirtyStickerPacks.add(msg.pack);
      scheduleSnapshotFlush();
      break;
    case "luckDraw":
      handleLuckDrawMessage(msg);
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
