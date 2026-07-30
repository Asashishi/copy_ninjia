/**
 * 磁盘 IO 线程（Bun Worker）：共享业务数据的磁盘 IO 收在这一条线程里串行执行——
 * 日志（error 级）、AI 记忆快照（各群滚动缓存 + 中期摘要）、白名单贴纸包
 * 目录快照、每日运势缓存、待验证当日增量 JSON 与 /block 黑名单都由进程唯一的
 * 统一持久化 Worker 串行落盘。多类负载共用一条 IO 线程，避免并发追加同一个文件时
 * 互相踩坏。state.json 是明确例外，由主线程 StateStore 独立异步维护。
 * 本 Worker 原名 loggerWorker，只负责日志；职责扩展后改名 diskIOWorker。
 *
 * 本文件只做消息路由、统一 flush 调度、启动恢复编排；具体逻辑分别在
 * diskIO/logFiles.ts（日志的缓冲/追加）、diskIO/aiMemoryFiles.ts（AI 记忆）、
 * diskIO/stickerCatalogFiles.ts（贴纸目录）、diskIO/luckFiles.ts（运势的缓冲/
 * 追加）、diskIO/luckSecretFile.ts（日级回执密钥）、
 * diskIO/verificationFiles.ts（待验证按日增量）、
 * diskIO/blocklistFile.ts（/block 黑名单）与
 * diskIO/blocklistRemovalOutbox.ts（未完成处置 outbox）、
 * diskIO/snapshotFiles.ts（无状态的文件读写辅助）。日志、运势、待验证数据
 * 与黑名单共用 appendOnlyDayFile.ts 的按位置追加/截断修复机制。
 *
 * 原则：磁盘只在启动恢复（load）时被读一次；此后 cache/workers/diskIO/ 下各领域 owner
 * 是唯一事实源，写是「缓存 -> 磁盘」的单向定时同步。本线程自身的内部错误
 * 一律 console.error（journal 兜底）——它就是落盘终点，不能再指望被自己
 * 转发的日志落盘自己的错误，那是一场递归。
 */

import { handleAdSampleMessage } from "./diskIO/adSampleFile";
import { flushBlocklistAppends, handleBlockUserMessage, handleUnblockUserMessage, hydrateBlocklist } from "./diskIO/blocklistFile";
import {
  flushBlocklistRemovalOutbox,
  handleBlocklistRemovalsMessage,
  hydrateBlocklistRemovalOutbox,
} from "./diskIO/blocklistRemovalOutbox";
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
import { aiMemoryCache } from "../cache/workers/diskIO/snapshots";
import { stickerCatalogCache } from "../cache/workers/diskIO/stickers";
import { luckWorkerCache } from "../cache/workers/diskIO/luck";
import type { VerificationSnapshot } from "../types/antiRaid";
import type { PendingBlockedRemoval } from "../types/blocklist";
import type { DiskFlushFailedReply, DiskFlushReply, DiskIODomain, DiskIOMessage, LoadedReply, LuckSecretReply, VerificationPersistedReply, AiMemoryDeletedPersistedReply, AiMemoryPersistedReply } from "../types/diskIO";
import type { BlockedUserRecord, LuckReceiptSecret } from "../types/diskIO/storage";

declare const self: Worker;

/** 统一 flush：日志缓冲、AI 记忆/贴纸目录快照、运势、待验证与黑名单追加缓冲全部立即落盘（进程退出前
 *  的最后一刷，各自的窗口阈值在这里不生效——不管有没有攒够条数/等够时间，
 *  该刷的都立即刷）。 */
function flushAll(): readonly DiskIODomain[] {
  // 不短路：即使前一领域失败，其余领域仍必须获得本轮落盘机会。
  const results: readonly (readonly [DiskIODomain, boolean])[] = [
    ["log", flushLogBuffer()],
    ["aiMemory", flushAiMemorySnapshots()],
    ["stickerCatalog", flushStickerCatalogs()],
    ["luck", flushLuckAppends()],
    ["verification", flushVerificationChanges((reply: VerificationPersistedReply): void => self.postMessage(reply))],
    ["blocklist", flushBlocklistAppends()],
    ["blocklistRemovalOutbox", flushBlocklistRemovalOutbox()],
  ];
  // 按领域回报而不是一个合取布尔：等自己那条记录落盘的调用方不该被无关领域
  // 的失败误导，而那个领域的真实错误按设计只有 console.error。
  return results
    .filter(([, flushed]: readonly [DiskIODomain, boolean]): boolean => !flushed)
    .map(([domain]: readonly [DiskIODomain, boolean]): DiskIODomain => domain);
}

/**
 * 取白名单贴纸包；配置写坏时返回 null，恢复随即降级成「只读不删」。
 *
 * 这里是全进程唯一无条件读 config/stickers.json 的地方：AI 闲聊那侧读它的入口
 * 都在「功能已启用」之后（见 aiChat/availability.ts），而启动恢复不问功能开没开。
 * 让它抛出等于一份写坏的白名单又把整个进程按在启动阶段——正是把校验挪出
 * ApplicationLifecycle 要避免的事（见 config/readiness.ts）。
 *
 * **绝不能退化成空白名单**：recoverStickerCatalogs 会把不在白名单里的持久化
 * 文件当孤儿删掉，传空数组就是把 memory/stickers/ 整个清空——一个逗号写错换来
 * 全部贴纸目录重新调视觉模型生成。null 与空数组因此是两件事：前者表示「这一轮
 * 对『哪些包该留着』没有发言权」，后者表示「一个包都不该留」。
 */
function activeStickerPacks(): readonly string[] | null {
  try {
    return getStickerConfig().packs;
  } catch (error: unknown) {
    console.error(
      "[diskIOWorker] sticker whitelist is unusable; recovering catalogs without pruning any file:",
      error
    );
    return null;
  }
}

/**
 * 启动恢复（也是本 Worker 崩溃重建后自动重跑的那一步，见 infra/diskIO.ts）：
 * 建目录、扫描解析校验 memory/ai/、memory/stickers/、memory/luck/（含当天
 * 回执密钥）、当天待验证增量文件与 memory/blocklist/blocklist.json，先灌进
 * 自己的缓存，再把缓存内容作为 loaded 回执发给主线程。任何恢复失败都会在回执
 * 中显式报告；主线程启动
 * 握手据此拒绝以部分/空状态继续运行。
 * memory/stickers/ 额外按当前 config/stickers.json 的白名单对账一次：白名单
 * 已经不包含的包，其持久化文件视为孤儿直接清掉（见 recoverStickerCatalogs）。
 * 白名单本身读不出来时这一步降级成只读不删（见上方 activeStickerPacks）。
 * 包内部「哪些贴纸还在线上」的对账则在 aiChatWorker 那侧的
 * aiChat/ai/stickers/catalog.ts 做（需要现查 Telegram，本线程没有 bot.api）。
 */
function handleLoad(): void {
  let loadError: string | undefined;
  let verifications: Map<string, VerificationSnapshot> = new Map();
  let blockedUsers: Map<number, BlockedUserRecord> = new Map();
  let pendingBlockedRemovals: Map<number, PendingBlockedRemoval> = new Map();
  let luckReceiptSecret: LuckReceiptSecret | null = null;
  try {
    hydrateAiMemorySnapshots();
    // 白名单读不出来时照样恢复，只是不做任何删除/隔离：跳过整步会让内存里的
    // 目录停在空表，而磁盘上明明躺着完好的快照——白白让崩溃重放少一份来源。
    hydrateStickerCatalogs(activeStickerPacks());
    const todayKey: string = getTokyoDateKey();
    hydrateLuckDay(todayKey);
    luckReceiptSecret = recoverLuckReceiptSecret({
      day: todayKey,
      confirmedResultCount: luckWorkerCache.current?.entries.size ?? 0,
    });
    verifications = recoverVerificationDay(todayKey);
    scheduleVerificationRollover((reply: VerificationPersistedReply): void => self.postMessage(reply));
    blockedUsers = hydrateBlocklist();
    pendingBlockedRemovals = hydrateBlocklistRemovalOutbox();
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
    blockedUsers,
    pendingBlockedRemovals,
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
      handleVerificationUpsert({ msg, reply: (reply: VerificationPersistedReply): void => self.postMessage(reply) });
      break;
    case "verificationDelete":
      handleVerificationDelete({ msg, reply: (reply: VerificationPersistedReply): void => self.postMessage(reply) });
      break;
    case "blockUser":
      // 收到即写，不进合并窗口：拉黑低频且关键，主线程那边内存 Map 已经先
      // 更新过，磁盘落后一个批量窗口就意味着这段时间内重启会丢掉这条记录。
      handleBlockUserMessage(msg);
      break;
    case "unblockUser":
      // 追加型文件删不掉已有条目：按主线程送来的完整名单整文件原子重写。
      handleUnblockUserMessage(msg);
      break;
    case "blocklistRemovals":
      handleBlocklistRemovalsMessage(msg);
      break;
    case "adSample":
      // 纯旁路素材：收到即写，不进合并窗口、不进统一 flush、失败即弃
      // （见 diskIO/adSampleFile.ts 的文件头）。
      handleAdSampleMessage(msg);
      break;
    case "load":
      handleLoad();
      break;
    case "flush": {
      const failedDomains: readonly DiskIODomain[] = flushAll();
      const reply: DiskFlushReply | DiskFlushFailedReply = failedDomains.length === 0
        ? { type: "flushed", flushedId: msg.flushId }
        : { type: "flushFailed", flushedId: msg.flushId, failedDomains };
      self.postMessage(reply);
      break;
    }
  }
}

/** Worker 线程启动入口；主线程导入本模块时不得建目录或注册 handler。 */
export function startDiskIOWorker(): void {
  configureAiMemoryDeletePersistedReply((reply: AiMemoryDeletedPersistedReply): void => self.postMessage(reply));
  configureAiMemoryPersistedReply((reply: AiMemoryPersistedReply): void => self.postMessage(reply));
  initLogFiles();
  self.onmessage = (event: MessageEvent<DiskIOMessage>): void => {
    handleDiskIOWorkerMessage(event.data);
  };
}

if (!Bun.isMainThread) startDiskIOWorker();
