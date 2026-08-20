/**
 * 磁盘 IO 线程（Bun Worker）：共享业务数据的磁盘 IO 收在这一条线程里串行执行——
 * 日志（error 级）、AI 记忆快照（各群滚动缓存 + 中期摘要）、白名单贴纸包
 * 目录快照、每日运势缓存、待验证当日增量 JSON、身份策略 SQLite 与入群日志都由
 * 进程唯一的统一持久化 Worker 串行落盘。多类负载共用一条 IO 线程，避免并发追加同一个文件时
 * 互相踩坏。群状态也进入同一 SQLite；只有 global-only `state.json` 是明确例外，
 * 由主线程 StateStore 独立异步维护。
 * 本 Worker 原名 loggerWorker，只负责日志；职责扩展后改名 diskIOWorker。
 *
 * 本文件只做消息路由、统一 flush 调度、启动恢复编排；具体逻辑分别在
 * diskIO/logFiles.ts（日志的缓冲/追加）、diskIO/aiMemoryFiles.ts（AI 记忆）、
 * diskIO/stickerCatalogFiles.ts（贴纸目录）、diskIO/luckFiles.ts（运势的缓冲/
 * 追加）、diskIO/luckSecretFile.ts（日级回执密钥）、
 * diskIO/verificationRecovery.ts 与 verificationWrites.ts（待验证按日增量）、
 * diskIO/storageDatabase.ts（黑白名单与未完成处置 outbox）、
 * diskIO/joinLogFiles.ts（滚动入群追写与命令按需读取）、
 * diskIO/snapshotFiles.ts（无状态的文件读写辅助）。日志、运势、待验证数据
 * 共用 appendOnlyDayFile.ts 的按位置追加机制；SQLite 权威状态不启用截断修复。
 *
 * 原则：恢复型状态只在启动恢复（load）时读一次；此后
 * cache/workers/diskIO/ 下各领域 owner 是唯一事实源，写是「缓存 -> 磁盘」
 * 的单向定时同步。入群日志在启动时只校验保留窗口，收到入群事实或
 * `/batch_kick` 请求时才按群日建立 LRU；查询前先刷缓冲并读取滚动窗口。本线程自身的内部错误一律
 * console.error（journal 兜底）——它就是落盘终点，不能再指望被自己转发
 * 的日志落盘自己的错误，那是一场递归。
 */

import { handleAdSampleMessage } from "./diskIO/adSampleFile";
import {
  configureStoragePersistenceReply,
  flushStorageDatabase,
  handleChatStateWrite,
  handleIdentityPolicyWrite,
  handlePendingRemovalSnapshot,
  hydrateStorageDatabase,
  pendingStorageDatabaseDomains,
  readBlocklistIdPage,
  readIdentityPolicies,
} from "./diskIO/storageDatabase";
import { flushLogBuffer, handleLogMessage, initLogFiles } from "./diskIO/logFiles";
import {
  configureLuckAppendStalledReply,
  flushLuckAppends,
  handleLuckDrawMessage,
  hydrateLuckDay,
} from "./diskIO/luckFiles";
import { recoverLuckReceiptSecret } from "./diskIO/luckSecretFile";
import {
  flushJoinLogDomain,
  handleJoinLogMessage,
  readJoinLog,
  recoverJoinLogFiles,
} from "./diskIO/joinLogFiles";
import { recoverVerificationDay } from "./diskIO/verificationRecovery";
import {
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
  scheduleVerificationRollover,
} from "./diskIO/verificationWrites";
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
import { LOG_REOPEN_RETRY_MS } from "../consts/diskIO/appendOnly";
import { aiMemoryCache, forgetAiMemoryChat } from "../cache/workers/diskIO/snapshots";
import { stickerCatalogCache } from "../cache/workers/diskIO/stickers";
import { luckWorkerCache } from "../cache/workers/diskIO/luck";
import { noteJoinLogRejected } from "../cache/workers/diskIO/joinLog";
import { noteStorageWriteRejected } from "../cache/workers/diskIO/storageDatabase";
import { diskIOReplayWindow } from "../cache/workers/diskIO/recovery";
import type { VerificationSnapshot } from
  "../types/antiRaid/verification";
import type { PendingBlockedRemoval } from "../types/blocklist";
import type { ChatState } from "../types/chatState";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  DiskFlushRequest,
  DiskFlushFailedReply,
  DiskFlushReply,
  DiskDiagnosticBatchAcceptedReply,
  DiskDiagnosticBatchRetryReply,
  DiskDiagnosticMessage,
  DiskIODomain,
  DiskIOMessage,
  JoinLogReadReply,
  IdentityStoragePersistedReply,
  LoadedReply,
  LuckAppendStalledReply,
  LuckSecretReply,
  RecoveryReplayFailedReply,
  VerificationPersistedReply,
} from "../types/diskIO";
import type {
  JoinLogRecord,
  LuckReceiptSecret,
} from "../types/diskIO/storage";

declare const self: Worker;

/**
 * 统一 flush：普通范围覆盖日志与全部业务领域；`business` 范围只在已知日志故障的
 * 受控重建前使用。各自的窗口阈值在这里不生效——不管有没有攒够条数/等够时间，
 * 该刷的都立即刷。
 */
function flushAll(scope: DiskFlushRequest["scope"]): readonly DiskIODomain[] {
  // 不短路：即使前一领域失败，其余领域仍必须获得本轮落盘机会。
  const failedDomains: DiskIODomain[] = [];
  if (scope === "all" && !flushLogBuffer()) failedDomains.push("log");
  if (!flushAiMemorySnapshots()) failedDomains.push("aiMemory");
  if (!flushStickerCatalogs()) failedDomains.push("stickerCatalog");
  if (!flushLuckAppends()) failedDomains.push("luck");
  if (!flushVerificationChanges(
    (reply: VerificationPersistedReply): void => self.postMessage(reply)
  )) failedDomains.push("verification");
  if (!flushStorageDatabase(
    (reply: IdentityStoragePersistedReply): void => self.postMessage(reply)
  )) {
    failedDomains.push(...pendingStorageDatabaseDomains());
  }
  if (!flushJoinLogDomain()) failedDomains.push("joinLog");
  // 按领域回报而不是一个合取布尔：等自己那条记录落盘的调用方不该被无关领域
  // 的失败误导，而那个领域的真实错误按设计只有 console.error。
  return failedDomains;
}

/**
 * 读取已在主线程启动总闸验证过的贴纸白名单。Worker 重建仍自行复核，配置若在
 * 进程运行期间被破坏则恢复失败，不能把错误配置解释成空白名单后删除全部目录。
 */
function activeStickerPacks(): readonly string[] {
  return getStickerConfig().packs;
}

/**
 * 启动恢复（也是本 Worker 崩溃重建后自动重跑的那一步，见 infra/diskIO.ts）：
 * 建目录、扫描解析校验 memory/ai/、memory/stickers/、memory/luck/（含当天
 * 回执密钥）、当天待验证增量文件与 database/storage.sqlite，先灌进
 * 自己的缓存，再把缓存内容作为 loaded 回执发给主线程。任何恢复失败都会在回执
 * 中显式报告；主线程启动
 * 握手据此拒绝以部分/空状态继续运行。
 * memory/stickers/ 额外按当前 config/stickers.json 的白名单对账一次：白名单
 * 已经不包含的包，其持久化文件视为孤儿直接清掉（见 recoverStickerCatalogs）。
 * 包内部「哪些贴纸还在线上」的对账则在 aiChatWorker 那侧的
 * aiChat/ai/stickers/catalog.ts 做（需要现查 Telegram，本线程没有 bot.api）。
 */
function handleLoad(): void {
  let loadError: string | undefined;
  let verifications: Map<string, VerificationSnapshot> = new Map();
  let blocklistEntryCount: number = 0;
  let whitelistEntryCount: number = 0;
  let pendingBlockedRemovals: Map<number, PendingBlockedRemoval> = new Map();
  let chatStates: Map<number, ChatState> = new Map();
  let luckReceiptSecret: LuckReceiptSecret | null = null;
  try {
    hydrateAiMemorySnapshots();
    hydrateStickerCatalogs(activeStickerPacks());
    const todayKey: string = getTokyoDateKey();
    recoverJoinLogFiles(todayKey);
    hydrateLuckDay(todayKey);
    luckReceiptSecret = recoverLuckReceiptSecret({
      day: todayKey,
      confirmedResultCount: luckWorkerCache.current?.entries.size ?? 0,
    });
    verifications = recoverVerificationDay(todayKey);
    scheduleVerificationRollover((reply: VerificationPersistedReply): void => self.postMessage(reply));
    const identityStorage: ReturnType<typeof hydrateStorageDatabase> =
      hydrateStorageDatabase();
    blocklistEntryCount = identityStorage.blocklistEntryCount;
    whitelistEntryCount = identityStorage.whitelistEntryCount;
    pendingBlockedRemovals = identityStorage.pendingBlockedRemovals;
    chatStates = identityStorage.chatStates;
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
    pendingBlockedRemovals,
    blocklistEntryCount,
    whitelistEntryCount,
    chatStates,
    error: loadError,
  };
  self.postMessage(reply);
}

/** 路由一条主线程消息；独立导出便于验证协议而不初始化真实落盘目录。 */
export function handleDiskIOWorkerMessage(msg: DiskIOMessage): void {
  switch (msg.type) {
    case "diagnosticBatch": {
      let containsLog: boolean = false;
      for (const diagnostic of msg.messages) {
        if (handleDiskIODiagnostic(diagnostic)) containsLog = true;
      }
      if (containsLog && !flushLogBuffer()) {
        const retry: DiskDiagnosticBatchRetryReply = {
          type: "diagnosticBatchRetry",
          batchId: msg.batchId,
          retryAfterMs: LOG_REOPEN_RETRY_MS,
        };
        self.postMessage(retry);
        break;
      }
      const reply: DiskDiagnosticBatchAcceptedReply = {
        type: "diagnosticBatchAccepted",
        batchId: msg.batchId,
      };
      self.postMessage(reply);
      break;
    }
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
    case "forgetAiMemory":
      // 主线程的 revision 计数器已在 teardown 归零，这里同步丢掉水位线，两侧
      // 的作用域才对得上；否则重新启用后的 revision 1 会被判成迟到消息丢弃
      // （见 types/diskIO.ts 的 AiMemoryForgetDiskMessage）。
      forgetAiMemoryChat(msg.chatId);
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
    // 这两条与 joinLog 同理：handlePendingRemovalSnapshot 会在 removalId 重复、
    // params.removalId 不匹配、probe 批次黑名单为空、冻结 userId 不在名单时抛，
    // handleIdentityPolicyWrite 由 validatePolicyData / assertOppositePolicyAbsent
    // 抛。异常一旦离开 onmessage，Bun 会直接终止整条落盘线程：在途 flush 全部按
    // 失败结算、九个领域的缓冲随线程一起没了，反复触发还会顶到重启节流把整个进程
    // 停掉——为了一条本来只该由自己那个领域承担的非法消息。就地拒收，并按领域
    // 留下标记，让主线程的下一次领域 flush 拿到失败回执。
    case "blocklistRemovals":
      handleIdentityMessage(
        "blocklistRemovalOutbox",
        (): void => handlePendingRemovalSnapshot(
          msg,
          (reply: IdentityStoragePersistedReply): void => self.postMessage(reply)
        )
      );
      break;
    case "identityPolicyWrite":
      handleIdentityMessage(
        msg.table,
        (): void => handleIdentityPolicyWrite(
          msg,
          (reply: IdentityStoragePersistedReply): void => self.postMessage(reply)
        )
      );
      break;
    case "chatStateWrite":
      handleIdentityMessage(
        "chatState",
        (): void => handleChatStateWrite(
          msg,
          (reply: IdentityStoragePersistedReply): void => self.postMessage(reply)
        )
      );
      break;
    case "recoveryReplay":
      diskIOReplayWindow.current = msg.active;
      break;
    case "joinLog":
      try {
        handleJoinLogMessage(msg);
      } catch (error: unknown) {
        // 缓冲满、跨日前刷盘失败、跨日清理抛错都会从这里逸出。异常一旦离开
        // onmessage，Bun 会直接终止整条落盘线程（见 infra/diskIO/host.ts 的实测
        // 注释）：在途 flush 全部按失败结算、各领域缓冲随线程一起没了，反复触发
        // 还会顶到 diskIORestartThrottle 把整个进程停掉——为了一条入群事实。
        // 按 cache/workers/diskIO/joinLog.ts 的约定只拖垮 joinLog 这一个领域：
        // 记下拒收，recordJoinLog 紧接着那次 flush 就会拿到 flushFailed，该
        // update 不被确认，Telegram 重投。
        noteJoinLogRejected();
        console.error("[diskIOWorker] failed to buffer a join log event:", error);
        // 上面那套自愈的前提是「这条消息后面紧跟着调用方自己的 flush」。恢复
        // 缓冲重放的那条没有：recordJoinLog 在缓冲那一刻就放行了该 update，此后
        // 再没有人来问它写没写进去。拒收标记会一直挂到某个**无关**的后续入群
        // 事实那次 flush 上——那一条被连坐重投，真正丢掉的这一条却没有任何痕迹。
        // 按 infra/joinLog.ts 承诺的口径升级为统一 fatal 停机，让 Telegram 从
        // 上一个确认点整段重投。
        if (diskIOReplayWindow.current) {
          const reply: RecoveryReplayFailedReply = {
            type: "recoveryReplayFailed",
            domain: "joinLog",
            error: error instanceof Error ? error.message : String(error),
          };
          self.postMessage(reply);
        }
      }
      break;
    case "readJoinLog": {
      let reply: JoinLogReadReply;
      try {
        const records: readonly JoinLogRecord[] = readJoinLog(msg);
        reply = {
          type: "joinLogRead",
          requestId: msg.requestId,
          records,
        };
      } catch (error: unknown) {
        reply = {
          type: "joinLogRead",
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      self.postMessage(reply);
      break;
    }
    case "readIdentityPolicies":
      self.postMessage(readIdentityPolicies(msg));
      break;
    case "readBlocklistIdPage":
      self.postMessage(readBlocklistIdPage(msg));
      break;
    case "load":
      handleLoad();
      break;
    case "flush": {
      const failedDomains: readonly DiskIODomain[] = flushAll(msg.scope);
      const reply: DiskFlushReply | DiskFlushFailedReply = failedDomains.length === 0
        ? { type: "flushed", flushedId: msg.flushId }
        : { type: "flushFailed", flushedId: msg.flushId, failedDomains };
      self.postMessage(reply);
      break;
    }
  }
}

/**
 * 身份 SQLite 消息的统一拒收边界：异常只拖垮它自己那个领域，不离开 onmessage。
 *
 * 恢复重放区间内额外升级为 fatal：那批消息对应的 update 早已被 Telegram 确认，
 * 后面不会再有任何 flush 来问它写没写进去，继续跑就是静默丢数据（口径同
 * joinLog 与 types/diskIO.ts 的 RecoveryReplayRequest）。
 */
function handleIdentityMessage(
  domain: "whitelist" | "blocklist" | "blocklistRemovalOutbox" | "chatState",
  apply: () => void
): void {
  try {
    apply();
  } catch (error: unknown) {
    noteStorageWriteRejected(domain);
    console.error(`[diskIOWorker] rejected an identity ${domain} message:`, error);
    if (!diskIOReplayWindow.current) return;
    const reply: RecoveryReplayFailedReply = {
      type: "recoveryReplayFailed",
      domain,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(reply);
  }
}

/** 一批中的诊断保持原始顺序同步消费；完成整批后才能向主线程回 ACK。 */
function handleDiskIODiagnostic(message: DiskDiagnosticMessage): boolean {
  if (message.type === "log") {
    handleLogMessage(message);
    return true;
  }
  // 纯旁路素材：收到即写，不进合并窗口、不进统一 flush、失败即弃
  // （见 diskIO/adSampleFile.ts 的文件头）。
  handleAdSampleMessage(message);
  return false;
}

/** Worker 线程启动入口；主线程导入本模块时不得建目录或注册 handler。 */
export function startDiskIOWorker(): void {
  configureStoragePersistenceReply(
    (reply: IdentityStoragePersistedReply): void => self.postMessage(reply)
  );
  configureAiMemoryDeletePersistedReply((reply: AiMemoryDeletedPersistedReply): void => self.postMessage(reply));
  configureAiMemoryPersistedReply((reply: AiMemoryPersistedReply): void => self.postMessage(reply));
  // 运势追加持续失败时的兜底诊断出口：本线程的 console 可能被部署接到
  // /dev/null，这条会由主线程的运势 owner 记进统一 logs/（见 luckFiles.ts）。
  configureLuckAppendStalledReply((reply: LuckAppendStalledReply): void => self.postMessage(reply));
  initLogFiles();
  self.onmessage = (event: MessageEvent<DiskIOMessage>): void => {
    handleDiskIOWorkerMessage(event.data);
  };
}

if (!Bun.isMainThread) startDiskIOWorker();
