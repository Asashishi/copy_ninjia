/**
 * 磁盘 IO 线程（Bun Worker）：共享业务数据的磁盘 IO 收在这一条线程里串行执行——
 * 日志（error 级）、AI 记忆快照（各群滚动缓存 + 中期摘要）、白名单贴纸包
 * 目录快照、每日运势缓存与待验证当日增量 JSON 都由进程唯一的统一持久化
 * Worker 串行落盘。多类负载共用一条 IO 线程，避免并发追加同一个文件时
 * 互相踩坏。state.json 是明确例外，由主线程 StateStore 独立异步维护。
 * 本 Worker 原名 loggerWorker，只负责日志；职责扩展后改名 diskIOWorker。
 *
 * 本文件只做消息路由、统一 flush 调度、启动恢复编排；具体逻辑分别在
 * diskIO/logFiles.ts（日志的缓冲/追加）、diskIO/aiMemoryFiles.ts（AI 记忆）、
 * diskIO/stickerCatalogFiles.ts（贴纸目录）、diskIO/luckFiles.ts（运势的缓冲/
 * 追加）、diskIO/luckSecretFile.ts（日级回执密钥）、
 * diskIO/verificationFiles.ts（待验证按日增量）与
 * diskIO/snapshotFiles.ts（无状态的文件读写辅助）。日志、运势
 * 和待验证数据共用 appendOnlyDayFile.ts 的按位置追加/截断修复机制。
 *
 * 原则：磁盘只在启动恢复（load）时被读一次；此后 cache/diskIO/ 下各领域 owner
 * 是唯一事实源，写是「缓存 -> 磁盘」的单向定时同步。本线程自身的内部错误
 * 一律 console.error（journal 兜底）——它就是落盘终点，不能再指望被自己
 * 转发的日志落盘自己的错误，那是一场递归。
 */

import { flushLogBuffer, handleLogMessage, initLogFiles } from "./diskIO/logFiles";
import { flushLuckAppends, handleLuckDrawMessage, hydrateLuckDay } from "./diskIO/luckFiles";
import { recoverLuckReceiptSecret } from "./diskIO/luckSecretFile";
import { flushVerificationChanges, handleVerificationDelete, handleVerificationUpsert, recoverVerificationDay, scheduleVerificationRollover } from "./diskIO/verificationFiles";
import {
  configureAiMemoryDeletePersistedReply,
  configureAiMemoryPersistedReply,
  deleteAiMemorySnapshot,
  flushAiMemorySnapshots,
  hydrateAiMemorySnapshots,
  markAiMemorySnapshotDirty,
} from "./diskIO/aiMemoryFiles";
import { flushStickerCatalogs, hydrateStickerCatalogs, markStickerCatalogSnapshotDirty } from "./diskIO/stickerCatalogFiles";
import { getStickerConfig } from "../config/stickers";
import { getTokyoDateKey } from "../libs/time";
import { aiMemoryCache } from "../cache/diskIO/snapshots";
import { stickerCatalogCache } from "../cache/diskIO/stickers";
import { luckWorkerCache } from "../cache/diskIO/luck";
import type { VerificationSnapshot } from "../types/antiRaid";
import type { DiskFlushFailedReply, DiskFlushReply, DiskIOMessage, LoadedReply, LuckSecretReply } from "../types/diskIO";
import type { LuckReceiptSecret } from "../types/diskIO/storage";

declare const self: Worker;

/** 统一 flush：日志缓冲、AI 记忆/贴纸目录快照、运势与待验证追加缓冲全部立即落盘（进程退出前
 *  的最后一刷，各自的窗口阈值在这里不生效——不管有没有攒够条数/等够时间，
 *  该刷的都立即刷）。 */
function flushAll(): boolean {
  // 不短路：即使前一领域失败，其余领域仍必须获得本轮落盘机会。
  const results: boolean[] = [
    flushLogBuffer(),
    flushAiMemorySnapshots(),
    flushStickerCatalogs(),
    flushLuckAppends(),
    flushVerificationChanges((reply) => self.postMessage(reply)),
  ];
  return results.every(Boolean);
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
 * ai/stickers/catalog.ts 做（需要现查 Telegram，本线程没有 bot.api）。
 */
function handleLoad(): void {
  let loadError: string | undefined;
  let verifications: Map<string, VerificationSnapshot> = new Map();
  let luckReceiptSecret: LuckReceiptSecret | null = null;
  try {
    hydrateAiMemorySnapshots();
    hydrateStickerCatalogs(getStickerConfig().packs);
    const todayKey: string = getTokyoDateKey();
    hydrateLuckDay(todayKey);
    luckReceiptSecret = recoverLuckReceiptSecret({
      day: todayKey,
      confirmedResultCount: luckWorkerCache.current?.entries.size ?? 0,
    });
    verifications = recoverVerificationDay(todayKey);
    scheduleVerificationRollover((reply) => self.postMessage(reply));
  } catch (error: unknown) {
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
      markAiMemorySnapshotDirty({
        chatId: msg.chatId,
        revision: msg.revision,
        snapshot: msg.snapshot,
        persistImmediately: msg.persistImmediately === true,
      });
      break;
    case "deleteAiMemory":
      // 同步立即 unlink（而不是只走 dirty 标记 + 定时 flush）：删除是
      // 幂等的，不必等 SNAPSHOT_FLUSH_INTERVAL_MS 的批量窗口。失败会保留
      // dirty 删除状态；若线程在处理前或处理中崩溃，主线程持有的 revision
      // tombstone 会在新 Worker 完成 load 后重放，直到收到 durable 删除回执。
      deleteAiMemorySnapshot(msg.chatId, msg.revision);
      break;
    case "stickerCatalog":
      markStickerCatalogSnapshotDirty(msg.pack, msg.snapshot);
      break;
    case "luckDraw":
      handleLuckDrawMessage(msg);
      break;
    case "ensureLuckSecret": {
      let reply: LuckSecretReply;
      try {
        const currentLuckDay: string | undefined = luckWorkerCache.current?.day;
        if (currentLuckDay !== undefined && msg.day < currentLuckDay) {
          throw new Error(
            `Refusing to move luck persistence backward from ${currentLuckDay} to ${msg.day}.`
          );
        }
        // hydrateLuckDay 会重置当前 owner 的追加缓冲，因此跨日切换前必须先把
        // 旧日已确认结果刷盘。失败时拒绝切换，避免仅仅请求新日密钥就丢掉
        // 尚在正常批量窗口内的旧日结果；这也让新日结果与密钥的一致性检查
        // 始终建立在已完整提交的上一日 owner 之上。
        if (currentLuckDay !== msg.day) {
          if (!flushLuckAppends()) {
            throw new Error(`Failed to flush luck results before switching from ${currentLuckDay ?? "none"} to ${msg.day}.`);
          }
          // 跨日请求必须先恢复目标日结果，再决定能否轮换密钥；否则不一致备份
          // 中“结果文件存在、密钥仍是旧日”的组合会被误当成安全的新一天。
          hydrateLuckDay(msg.day);
        }
        reply = {
          type: "luckSecret",
          requestId: msg.requestId,
          secret: recoverLuckReceiptSecret({
            day: msg.day,
            confirmedResultCount: luckWorkerCache.current?.entries.size ?? 0,
          }),
        };
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
      handleVerificationUpsert({ msg, reply: (reply) => self.postMessage(reply) });
      break;
    case "verificationDelete":
      handleVerificationDelete({ msg, reply: (reply) => self.postMessage(reply) });
      break;
    case "load":
      handleLoad();
      break;
    case "flush": {
      const reply: DiskFlushReply | DiskFlushFailedReply = flushAll()
        ? { type: "flushed", flushedId: msg.flushId }
        : { type: "flushFailed", flushedId: msg.flushId };
      self.postMessage(reply);
      break;
    }
  }
}

/** Worker 线程启动入口；主线程导入本模块时不得建目录或注册 handler。 */
export function startDiskIOWorker(): void {
  configureAiMemoryDeletePersistedReply((reply) => self.postMessage(reply));
  configureAiMemoryPersistedReply((reply) => self.postMessage(reply));
  initLogFiles();
  self.onmessage = (event: MessageEvent<DiskIOMessage>) => {
    handleDiskIOWorkerMessage(event.data);
  };
}

if (!Bun.isMainThread) startDiskIOWorker();
