/**
 * 磁盘 IO 线程（Bun Worker）：进程内所有磁盘 IO 收在这一条线程里串行执行——
 * 日志（error 级）、AI 记忆快照（各群滚动缓存 + 中期摘要）、白名单贴纸包
 * 目录快照、每日运势缓存与待验证当日增量 JSON 都由进程唯一的统一持久化
 * Worker 串行落盘。多类负载共用一条 IO 线程，避免并发追加同一个文件时
 * 互相踩坏。原名 loggerWorker，只负责日志；职责扩展后改名 diskIOWorker。
 *
 * 本文件只做消息路由、统一 flush 调度、启动恢复编排；具体逻辑分别在
 * diskIO/logFiles.ts（日志的缓冲/追加）、diskIO/luckFiles.ts（运势的缓冲/
 * 追加）、diskIO/luckSecretFile.ts（日级回执密钥）、
 * diskIO/verificationFiles.ts（待验证按日增量）与
 * diskIO/snapshotFiles.ts（AI 记忆/贴纸目录覆盖写 + 启动恢复）。日志、运势
 * 和待验证数据共用 appendOnlyDayFile.ts 的按位置追加/截断修复机制。
 *
 * 原则：磁盘只在启动恢复（load）时被读一次；此后缓存（cache/diskIOWorker.ts）
 * 是唯一事实源，写是「缓存 -> 磁盘」的单向定时同步。本线程自身的内部错误
 * 一律 console.error（journal 兜底）——它就是落盘终点，不能再指望被自己
 * 转发的日志落盘自己的错误，那是一场递归。
 */

import { mkdirSync } from "node:fs";
import { flushLogBuffer, handleLogMessage, initLogFiles } from "./diskIO/logFiles";
import { flushLuckAppends, handleLuckDrawMessage } from "./diskIO/luckFiles";
import { recoverLuckReceiptSecret } from "./diskIO/luckSecretFile";
import { flushVerificationChanges, handleVerificationDelete, handleVerificationUpsert, recoverVerificationDay, scheduleVerificationRollover } from "./diskIO/verificationFiles";
import { deleteAiMemoryFile, recoverAiMemories, recoverLuckDay, recoverStickerCatalogs, writeAiMemoryFile, writeStickerCatalogFile } from "./diskIO/snapshotFiles";
import { stickerConfig } from "../ai/stickerConfig";
import { AI_MEMORY_DIR, LOGS_DIR, LUCK_MEMORY_DIR, STICKER_MEMORY_DIR, VERIFICATION_MEMORY_DIR } from "../consts/paths";
import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../consts/diskIO";
import { getTokyoDateKey } from "../libs/time";
import { aiMemoryCache, deletedAiMemoryChats, dirtyChats, dirtyStickerPacks, luckWorkerCache, snapshotFlushState, stickerCatalogCache } from "../cache/diskIOWorker";
import type { DiskFlushReply, DiskIOMessage, LoadedReply, LuckReceiptSecret, LuckSecretReply, VerificationSnapshot } from "../types";

declare const self: Worker;

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
  for (const chatId of deletedAiMemoryChats) {
    try {
      deleteAiMemoryFile(chatId);
      deletedAiMemoryChats.delete(chatId);
    } catch (error) {
      console.error(`[diskIOWorker] failed to delete AI memory snapshot for chat ${chatId}:`, error);
    }
  }
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

  // 单份写失败时 dirty 标记会保留；本轮定时器在进入 flushSnapshots 前已经
  // 清空，必须主动排下一轮。否则没有新快照消息时将永远不再尝试，直到停机
  // flush，期间硬崩会丢掉仍只在内存里的更新。
  if (deletedAiMemoryChats.size > 0 || dirtyChats.size > 0 || dirtyStickerPacks.size > 0) scheduleSnapshotFlush();
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
  flushVerificationChanges((reply) => self.postMessage(reply));
}

/**
 * 启动恢复（也是本 Worker 崩溃重建后自动重跑的那一步，见 infra/diskIO.ts）：
 * 建目录、扫描解析校验 memory/ai/、memory/stickers/、memory/luck/（含当天
 * 回执密钥）与当天待验证增量文件，先灌进自己的缓存，再把缓存内容作为
 * loaded 回执发给主线程。任何恢复失败都会在回执中显式报告；主线程启动
 * 握手据此拒绝以部分/空状态继续运行。
 * memory/stickers/ 额外按当前 config/stickers.json 的白名单对账一次：白名单
 * 已经不包含的包，其持久化文件视为孤儿直接清掉（见 recoverStickerCatalogs）；
 * 包内部「哪些贴纸还在线上」的对账则在 aiChatWorker 那侧的
 * ai/stickerCatalog.ts 做（需要现查 Telegram，本线程没有 bot.api）。
 */
function handleLoad(): void {
  let loadError: string | undefined;
  let verifications: Map<string, VerificationSnapshot> = new Map();
  let luckReceiptSecret: LuckReceiptSecret | null = null;
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    mkdirSync(AI_MEMORY_DIR, { recursive: true });
    mkdirSync(STICKER_MEMORY_DIR, { recursive: true });
    mkdirSync(LUCK_MEMORY_DIR, { recursive: true });
    mkdirSync(VERIFICATION_MEMORY_DIR, { recursive: true });

    for (const [chatId, snapshot] of recoverAiMemories()) {
      aiMemoryCache.set(chatId, snapshot);
    }

    for (const [pack, snapshot] of recoverStickerCatalogs(stickerConfig.packs)) {
      stickerCatalogCache.set(pack, snapshot);
    }

    const todayKey: string = getTokyoDateKey();
    const luckDay = recoverLuckDay(todayKey);
    if (luckDay) luckWorkerCache.current = luckDay;
    luckReceiptSecret = recoverLuckReceiptSecret(todayKey);
    verifications = recoverVerificationDay(todayKey);
    scheduleVerificationRollover((reply) => self.postMessage(reply));
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    console.error("[diskIOWorker] startup recovery failed:", error);
  }

  const reply: LoadedReply = {
    type: "loaded",
    aiMemories: aiMemoryCache,
    stickerCatalogs: stickerCatalogCache,
    luckDay: luckWorkerCache.current,
    luckReceiptSecret,
    verifications,
    error: loadError,
  };
  self.postMessage(reply);
}

/** 路由一条主线程消息；独立导出便于验证协议而不初始化真实落盘目录。 */
export function handleDiskIOWorkerMessage(msg: DiskIOMessage): void {
  switch (msg.type) {
    case "log":
      handleLogMessage(msg);
      break;
    case "aiMemory":
      deletedAiMemoryChats.delete(msg.chatId);
      aiMemoryCache.set(msg.chatId, msg.snapshot);
      dirtyChats.add(msg.chatId);
      scheduleSnapshotFlush();
      break;
    case "deleteAiMemory":
      aiMemoryCache.delete(msg.chatId);
      dirtyChats.delete(msg.chatId);
      // 同步立即 unlink（而不是走 dirty 标记 + 定时 flushSnapshots）：删除是
      // 幂等的，不必等 SNAPSHOT_FLUSH_INTERVAL_MS 的批量窗口。若走批量窗口，
      // 本线程恰好在窗口内崩溃会导致 deletedAiMemoryChats（易失态）随线程
      // 丢失，重建后 load 从盘上把仍然存在的文件读回缓存，而主线程侧
      // onDiskIORespawn 只重放现存镜像、没有「待删」镜像可重放，删除就此
      // 永久丢失（进程重启时还会被 hydrate 回 AI 上下文）。失败仍保留原有
      // 的 dirty 标记 + 重试兜底。
      try {
        deleteAiMemoryFile(msg.chatId);
      } catch (error) {
        console.error(`[diskIOWorker] failed to delete AI memory snapshot for chat ${msg.chatId}:`, error);
        deletedAiMemoryChats.add(msg.chatId);
        scheduleSnapshotFlush();
      }
      break;
    case "stickerCatalog":
      stickerCatalogCache.set(msg.pack, msg.snapshot);
      dirtyStickerPacks.add(msg.pack);
      scheduleSnapshotFlush();
      break;
    case "luckDraw":
      handleLuckDrawMessage(msg);
      break;
    case "ensureLuckSecret": {
      let reply: LuckSecretReply;
      try {
        reply = { type: "luckSecret", requestId: msg.requestId, secret: recoverLuckReceiptSecret(msg.day) };
      } catch (error: unknown) {
        reply = {
          type: "luckSecret",
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      self.postMessage(reply);
      break;
    }
    case "verificationUpsert":
      handleVerificationUpsert(msg, (reply) => self.postMessage(reply));
      break;
    case "verificationDelete":
      handleVerificationDelete(msg, (reply) => self.postMessage(reply));
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
}

/** Worker 线程启动入口；主线程导入本模块时不得建目录或注册 handler。 */
export function startDiskIOWorker(): void {
  initLogFiles();
  self.onmessage = (event: MessageEvent<DiskIOMessage>) => {
    handleDiskIOWorkerMessage(event.data);
  };
}

if (!Bun.isMainThread) startDiskIOWorker();
