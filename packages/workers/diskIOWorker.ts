/**
 * 磁盘 IO 线程（Bun Worker）：共享业务数据的磁盘 IO 收在这一条线程里串行执行——
 * 日志（error 级）、AI 记忆快照（各群滚动缓存 + 中期摘要）、白名单贴纸包
 * 目录快照、每日运势缓存、待验证当日增量 JSON、身份策略 SQLite、入群日志与 wed 成员集合都由
 * 进程唯一的统一持久化 Worker 串行落盘。多类负载共用一条 IO 线程，避免并发追加同一个文件时
 * 互相踩坏。群状态也进入同一 SQLite；只有主线程持有的 `memory/global/state.json` 是明确
 * 例外，由主线程 StateStore 独立异步维护，本 Worker 不访问 memory/global/。
 *
 * 本文件只做消息路由；按领域与 scope 的统一 flush 在 diskIO/domainFlush.ts，启动恢复编排在
 * diskIO/startup.ts，
 * 具体领域逻辑分别在
 * diskIO/logFiles.ts（日志的缓冲/追加）、diskIO/aiMemoryStorage.ts（AI 记忆）、
 * diskIO/stickerCatalogFiles.ts（贴纸目录）、diskIO/luckFiles.ts（运势的缓冲/
 * 追加）、diskIO/luckSecretFile.ts（日级回执密钥）、
 * diskIO/verificationRecovery.ts 与 verificationWrites.ts（待验证按日增量）、
 * diskIO/storageDatabase.ts（共享 SQLite：黑白名单、临时广告免检、未完成处置 outbox、
 * 群状态、群问答与 AI 上下文的事务提交）、
 * diskIO/joinLogFiles.ts 与 joinLogWrites.ts（滚动入群追写与命令按需读取）、
 * diskIO/wedMemberFiles.ts（每群已发言成员数组的启动校验与全量替换）、
 * diskIO/snapshotFiles.ts（无状态的文件读写辅助）。日志、运势、待验证、入群日志、
 * 广告样本与 AI 用量统计共用 appendOnlyDayFile.ts 的按位置追加机制；SQLite 权威状态
 * 不启用截断修复。
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
  handleChatQaWrite,
  handleChatStateWrite,
  handleIdentityPolicyWrite,
  handleTemporaryAdBypassWrite,
  handlePendingRemovalSnapshot,
  readBlocklistIdPage,
  readIdentityPolicies,
  setStorageFlushHold,
} from "./diskIO/storageDatabase";
import { flushLogBuffer, handleLogMessage } from "./diskIO/logFiles";
import { handleAiCacheUsageMessage } from "./diskIO/aiCacheFile";
import {
  flushLuckAppends,
  handleLuckDrawMessage,
  replayDeferredLuckDraws,
  switchLuckDay,
} from "./diskIO/luckFiles";
import { recoverLuckReceiptSecret } from "./diskIO/luckSecretFile";
import {
  handleJoinLogDeleteMessage,
  handleJoinLogMessage,
  readJoinLog,
} from "./diskIO/joinLogFiles";
import {
  handleVerificationDelete,
  handleVerificationUpsert,
} from "./diskIO/verificationWrites";
import {
  deleteAiMemorySnapshot,
  markAiMemorySnapshotDirty,
} from "./diskIO/aiMemoryStorage";
import {
  markStickerCatalogSnapshotDirty,
} from "./diskIO/stickerCatalogFiles";
import { handleDiskIOStartupLoad } from "./diskIO/startup";
import {
  handleWedMembersDeleteMessage,
  handleWedMembersMessage,
} from "./diskIO/wedMemberFiles";
import { LOG_REOPEN_RETRY_MS } from "../consts/diskIO/appendOnly";
import { DISK_BUSINESS_BATCH_MAX_MESSAGES } from "../consts/diskIO/business";
import {
  aiMemoryDeletePersistedNotifier,
  aiMemoryPersistedNotifier,
  forgetAiMemoryChat,
} from "../cache/workers/diskIO/snapshots";
import { luckAppendStalledNotifier, luckWorkerCache } from "../cache/workers/diskIO/luck";
import {
  noteVerificationWriteRejected,
} from "../cache/workers/diskIO/verification";
import { joinLogPersistedNotifier } from "../cache/workers/diskIO/joinLog";
import {
  noteStorageWriteRejected,
  storagePersistenceReplyHolder,
  storageWriteFatalReply,
} from "../cache/workers/diskIO/storageDatabase";
import { StorageWriteCapacityError } from "../libs/storageWriteBudget";
import { diskIOReplayWindow } from "../cache/workers/diskIO/recovery";
import type {
  DiskIOMessage,
  LuckDrawDiskMessage,
} from "../types/diskIO/messages";
import type {
  DiskFlushFailedReply,
  DiskFlushReply,
  DiskDiagnosticBatchAcceptedReply,
  DiskDiagnosticBatchRetryReply,
  DiskIODomain,
  DiskIOReply,
  JoinLogReadReply,
  LuckSecretReply,
  RecoveryReplayFailedReply,
  StorageDatabaseDomain,
} from "../types/diskIO/replies";
import type {
  JoinLogRecord,
} from "../types/diskIO/storage";
import { enqueueDiskIOOperation } from "./diskIO/operationQueue";
import { flushScope } from "./diskIO/domainFlush";
import { wedMemberDeletePersistedNotifier } from "../cache/workers/diskIO/wed";
import { stickerCatalogPersistedNotifier } from "../cache/workers/diskIO/stickers";
import { errorMessage } from "../libs/errorMessage";
import { adoptTimeZone } from "../config/time";

declare const self: Worker;

/** Worker → 主线程的唯一回执出口；参数类型把回执协议交给编译器核对。 */
function postReply(reply: DiskIOReply): void {
  self.postMessage(reply);
}

/** 路由一条主线程消息；独立导出便于验证协议而不初始化真实落盘目录。 */
export async function handleDiskIOWorkerMessage(
  msg: DiskIOMessage
): Promise<void> {
  switch (msg.type) {
    case "operationBatch":
      if (!Number.isSafeInteger(msg.batchId) || msg.batchId < 1 ||
        msg.messages.length < 1 || msg.messages.length > DISK_BUSINESS_BATCH_MAX_MESSAGES) {
        throw new Error("Invalid Disk I/O operation batch.");
      }
      for (const message of msg.messages) await handleDiskIOWorkerMessage(message);
      postReply({ type: "operationBatchAccepted", batchId: msg.batchId });
      break;
    case "diagnosticBatch": {
      // 一批中的诊断保持原始顺序同步消费；完成整批后才向主线程回 ACK。
      // 日志先入缓冲并刷盘，成功后才追加 adSample：刷盘失败时主线程整批重投，
      // adSample 在这一轮还没写，重投只追加一次。两者是不同文件，相对顺序无意义。
      let containsLog: boolean = false;
      for (const diagnostic of msg.messages) {
        if (diagnostic.type !== "log") continue;
        handleLogMessage(diagnostic);
        containsLog = true;
      }
      if (containsLog && !await flushLogBuffer()) {
        const retry: DiskDiagnosticBatchRetryReply = {
          type: "diagnosticBatchRetry",
          batchId: msg.batchId,
          retryAfterMs: LOG_REOPEN_RETRY_MS,
        };
        postReply(retry);
        break;
      }
      // 纯旁路素材：先进样本批次，由阈值、定时或统一 flush 追加，失败即弃
      // （见 diskIO/adSampleFile.ts 的文件头）。
      for (const diagnostic of msg.messages) {
        if (diagnostic.type === "adSample") await handleAdSampleMessage(diagnostic);
      }
      // 缓存用量同为旁路统计：先进内存缓冲，由阈值、定时或统一 flush 追加落盘；
      // 缓冲与刷盘失败只丢统计，不影响本批 ACK（见 diskIO/aiCacheFile.ts）。
      for (const diagnostic of msg.messages) {
        if (diagnostic.type !== "aiCacheUsage") continue;
        try {
          await handleAiCacheUsageMessage(diagnostic);
        } catch (error: unknown) {
          console.error("[diskIOWorker] failed to buffer AI cache usage:", error);
        }
      }
      const reply: DiskDiagnosticBatchAcceptedReply = {
        type: "diagnosticBatchAccepted",
        batchId: msg.batchId,
      };
      postReply(reply);
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
      // 删除排入共享事务缓冲后立即提交，不等定时窗口。提交失败时缓冲保留删除最终值
      // 由事务重试 timer 继续；若线程在处理前或处理中崩溃，主线程持有的 revision
      // tombstone 会在新 Worker 完成 load 后重放，直到收到 durable 删除回执。
      deleteAiMemorySnapshot(msg.chatId, msg.revision);
      break;
    case "forgetAiMemory":
      // 主线程的 revision 计数器已在 teardown 归零，这里同步丢掉水位线，两侧
      // 的作用域才对得上；否则重新启用后的 revision 1 会被判成迟到消息丢弃
      // （见 types/diskIO/messages.ts 的 AiMemoryForgetDiskMessage）。
      forgetAiMemoryChat(msg.chatId);
      break;
    case "stickerCatalog":
      markStickerCatalogSnapshotDirty(msg.pack, msg.snapshot, msg.revision);
      break;
    case "wedMembers":
      handleWedMembersMessage(msg);
      break;
    case "deleteWedMembers":
      // 群 teardown 的整群删除：同步丢掉待写快照后立即 unlink，失败保留待删标记，
      // 由 wedMembers 领域共用的重试 timer 继续尝试（见 diskIO/wedMemberFiles.ts）。
      handleWedMembersDeleteMessage(msg);
      break;
    case "luckDraw":
      await handleLuckDrawMessage(msg);
      break;
    case "ensureLuckSecret": {
      let reply: LuckSecretReply;
      let deferredDraws: LuckDrawDiskMessage[] | null = null;
      try {
        const currentLuckDay: string | undefined = luckWorkerCache.current?.day;
        if (currentLuckDay !== undefined && msg.day < currentLuckDay) {
          throw new Error(
            `Refusing to move luck persistence backward from ${currentLuckDay} to ${msg.day}.`
          );
        }
        // 切换 owner 会重置当前 owner 的追加缓冲，因此跨日切换前必须先把
        // 旧日已确认结果刷盘。失败时拒绝切换，避免仅仅请求新日密钥就丢掉
        // 尚在正常批量窗口内的旧日结果；这也让新日结果与密钥的一致性检查
        // 始终建立在已完整提交的上一日 owner 之上。
        if (currentLuckDay !== msg.day) {
          if (!await flushLuckAppends()) {
            throw new Error(`Failed to flush luck results before switching from ${currentLuckDay ?? "none"} to ${msg.day}.`);
          }
          // 跨日请求必须先恢复目标日结果，再决定能否轮换密钥；否则不一致备份
          // 中“结果文件存在、密钥仍是旧日”的组合会被误当成安全的新一天。
          deferredDraws = await switchLuckDay(msg.day, true);
        }
        reply = {
          type: "luckSecret",
          requestId: msg.requestId,
          secret: await recoverLuckReceiptSecret({
            day: msg.day,
            confirmedResultCount: luckWorkerCache.current?.entries.size ?? 0,
          }),
        };
      } catch (error: unknown) {
        reply = {
          type: "luckSecret",
          requestId: msg.requestId,
          error: errorMessage(error),
        };
      }
      postReply(reply);
      // 滞留抽签在密钥按磁盘上的确认结果恢复之后才补录，不计入 confirmedResultCount。
      await replayDeferredLuckDraws(deferredDraws);
      break;
    }
    case "verificationUpsert":
      await handleVerificationMessage(
        (): Promise<void> => handleVerificationUpsert({ msg, reply: postReply })
      );
      break;
    case "verificationDelete":
      await handleVerificationMessage(
        (): Promise<void> => handleVerificationDelete({ msg, reply: postReply })
      );
      break;
    // 共享 SQLite 写消息的非法输入就地拒收：handlePendingRemovalSnapshot 会在 removalId 重复、
    // params.removalId 不匹配、probe 批次黑名单为空、冻结 userId 不在名单时抛，
    // handleIdentityPolicyWrite 由 validatePolicyData / assertOppositePolicyAbsent
    // 抛。异常一旦离开 onmessage，Bun 会直接终止整条落盘线程：在途 flush 全部按
    // 失败结算、各领域的缓冲随线程一起没了，反复触发还会顶到重启节流把整个进程
    // 停掉——为了一条本来只该由自己那个领域承担的非法消息。就地拒收，并按领域
    // 留下标记，让主线程的下一次领域 flush 拿到失败回执。
    case "blocklistRemovals":
      handleIdentityMessage(
        "blocklistRemovalOutbox",
        (): void => handlePendingRemovalSnapshot(msg, postReply)
      );
      break;
    case "identityPolicyWrite":
      handleIdentityMessage(
        msg.table,
        (): void => handleIdentityPolicyWrite(msg, postReply)
      );
      break;
    case "temporaryAdBypassWrite":
      handleIdentityMessage(
        "temporaryAdBypass",
        (): void => handleTemporaryAdBypassWrite(msg, postReply)
      );
      break;
    case "chatStateWrite":
      handleIdentityMessage(
        "chatState",
        (): void => handleChatStateWrite(msg, postReply)
      );
      break;
    case "chatQaWrite":
      handleIdentityMessage(
        "chatQa",
        (): void => handleChatQaWrite(msg, postReply)
      );
      break;
    case "recoveryReplay":
      diskIOReplayWindow.current = msg.active;
      break;
    case "storageFlushHold":
      setStorageFlushHold(msg.active, postReply);
      break;
    case "joinLog":
      // 入群事实只进缓冲；写失败与领先本 Worker 今天的条目留在缓冲里重试，处置结果
      // 经 joinLogPersisted 处置回执回报（见 diskIO/joinLogFiles.ts 的 handleJoinLogMessage）。
      await handleJoinLogMessage(msg);
      break;
    case "deleteJoinLog":
      // 目录列举与逐个 unlink 的失败都由 purgeChatJoinLogFiles 自己收在 try 内并保留
      // 待删标记，删除结果经 `joinLogPurge` 领域 flush 回报给发起 teardown 的调用方，
      // 不连坐无关的入群事实。
      handleJoinLogDeleteMessage(msg);
      break;
    case "readJoinLog": {
      let reply: JoinLogReadReply;
      try {
        const records: readonly JoinLogRecord[] = await readJoinLog(msg);
        reply = {
          type: "joinLogRead",
          requestId: msg.requestId,
          records,
        };
      } catch (error: unknown) {
        reply = {
          type: "joinLogRead",
          requestId: msg.requestId,
          error: errorMessage(error),
        };
      }
      postReply(reply);
      break;
    }
    case "readIdentityPolicies":
      postReply(readIdentityPolicies(msg));
      break;
    case "readBlocklistIdPage":
      postReply(readBlocklistIdPage(msg));
      break;
    case "load":
      adoptTimeZone(msg.timeZone);
      await handleDiskIOStartupLoad(msg.stickerPacks, postReply);
      break;
    case "flush": {
      const failedDomains: readonly DiskIODomain[] = await flushScope(msg.scope, postReply);
      const reply: DiskFlushReply | DiskFlushFailedReply = failedDomains.length === 0
        ? { type: "flushed", flushedId: msg.flushId }
        : { type: "flushFailed", flushedId: msg.flushId, failedDomains };
      postReply(reply);
      break;
    }
    default: {
      // 穷尽性断言：协议新增一条 main -> diskIO 消息时这一行编译失败，必须在本
      // switch 里点名它的 owner。落到这里的消息会被整条丢掉且没有任何回执，
      // 请求方只能等到超时；运行期不可达。
      const unhandled: never = msg;
      void unhandled;
      break;
    }
  }
}

/**
 * 把一条 Worker 消息追加到统一操作队列；启动恢复完成前到达的业务消息只能排队，
 * 不得与跨领域 inspect/adopt 事务交错。
 */
export function queueDiskIOWorkerMessage(message: DiskIOMessage): Promise<void> {
  return enqueueDiskIOOperation(
    async (): Promise<void> => handleDiskIOWorkerMessage(message)
  );
}

/**
 * 待验证写入的就地拒收边界（如容量超限）：异常只拖垮 verification 领域，不离开
 * onmessage；留下拒收标记让下一次领域 flush 回报失败，重放区间内升级为 fatal，
 * 口径同 handleIdentityMessage。
 */
async function handleVerificationMessage(apply: () => Promise<void>): Promise<void> {
  try {
    await apply();
  } catch (error: unknown) {
    noteVerificationWriteRejected();
    console.error("[diskIOWorker] rejected a verification message:", error);
    if (!diskIOReplayWindow.current) return;
    const reply: RecoveryReplayFailedReply = {
      type: "recoveryReplayFailed",
      domain: "verification",
      error: errorMessage(error),
    };
    postReply(reply);
  }
}

/**
 * 身份 SQLite 消息的统一拒收边界：异常只拖垮它自己那个领域，不离开 onmessage。
 *
 * 恢复重放区间内额外升级为 fatal：那批消息对应的 update 早已被 Telegram 确认，
 * 后面不会再有任何 flush 来问它写没写进去，继续跑就是静默丢数据（见
 * types/diskIO/messages.ts 的 RecoveryReplayRequest）。
 */
function handleIdentityMessage(
  domain: Exclude<StorageDatabaseDomain, "aiMemory">,
  apply: () => void
): void {
  try {
    apply();
  } catch (error: unknown) {
    noteStorageWriteRejected(domain);
    if (error instanceof StorageWriteCapacityError) postReply({ type: "storageWriteStalled" });
    console.error(`[diskIOWorker] rejected an identity ${domain} message:`, error);
    if (!diskIOReplayWindow.current) return;
    const reply: RecoveryReplayFailedReply = {
      type: "recoveryReplayFailed",
      domain,
      error: errorMessage(error),
    };
    postReply(reply);
  }
}

/** Worker 线程启动入口；主线程导入本模块时不得建目录或注册 handler。 */
function startDiskIOWorker(): void {
  wedMemberDeletePersistedNotifier.current = postReply;
  stickerCatalogPersistedNotifier.current = postReply;
  joinLogPersistedNotifier.current = postReply;
  storageWriteFatalReply.current = (): void => postReply({ type: "storageWriteStalled" });
  storagePersistenceReplyHolder.current = postReply;
  aiMemoryDeletePersistedNotifier.current = postReply;
  aiMemoryPersistedNotifier.current = postReply;
  // 运势追加持续失败时的兜底诊断出口：本线程的 console 可能被部署接到
  // /dev/null，这条会由主线程的运势 owner 记进统一 logs/（见 luckFiles.ts）。
  luckAppendStalledNotifier.current = postReply;
  self.onmessage = (event: MessageEvent<DiskIOMessage>): void => {
    void queueDiskIOWorkerMessage(event.data);
  };
}

if (!Bun.isMainThread) startDiskIOWorker();
