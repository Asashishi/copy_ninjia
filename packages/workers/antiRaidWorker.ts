import {
  handleJoin,
  handleTrackedMessage,
  handleVerificationCallback,
  dispatchVerification,
  adoptVerifications,
  handleVerificationPersisted,
  deactivateVerificationChat,
  disableJoinGuardChat,
  deleteDeferredVerification,
  stopVerificationRuntime,
} from "./antiRaid/verificationRuntime";
import {
  adoptLockdowns,
  deactivateLockdownChat,
  handleLockdownPersisted,
  stopLockdownRuntime,
} from "./antiRaid/lockdownRuntime";
import { applyAdminChange } from "./antiRaid/adminCache";
import { handleRemoveBlockedMembers } from "./antiRaid/blocklistEffects";
import {
  clearChatAdDetect,
  enqueueAdCandidate,
  quiesceAdDetectQueue,
  startAdDetectQueue,
  stopAdDetectQueue,
  sweepAdDetect,
} from "./antiRaid/adDetect/queue";
import {
  clearChatFloodWindows,
  handleFloodCandidate,
  resetFloodWindows,
  sweepFloodWindows,
} from "./antiRaid/floodControl";
import {
  applyBotPermissionsChange,
  forgetWorkerBotPermissions,
  resetWorkerBotPermissions,
} from "./antiRaid/botPermissions";
import {
  applyChatKindChange,
  forgetWorkerChatKind,
  resetWorkerChatKind,
} from "./antiRaid/chatKind";
import { bumpBlocklistRemovalEpoch } from "../cache/workers/antiRaid/blocklist";
import { adoptAdDetectAgentConfig } from "../config/agent";
import { ANTI_RAID_CACHE_SWEEP_INTERVAL_MS } from "../consts/antiRaid/cache";
import { resetAdminCache, sweepAdminCache } from "../cache/workers/antiRaid/admins";
import { resetLinkedChannelCache, sweepLinkedChannelCache } from "../cache/workers/antiRaid/linkedChannels";
import { recentChannelComments } from "../cache/workers/antiRaid/recentComments";
import { sweepVerificationRevisionCache } from "../cache/workers/antiRaid/verification";
import type {
  AdDetectedEvent,
  AntiRaidWorkerMessage,
  AntiRaidWorkerRequest,
  BlockedMembersRemovedEvent,
} from "../types/antiRaid";
import {
  flushPendingMessageDeletions,
  resetPendingMessageDeletions as resetGenericMessageDeletions,
} from "../infra/telegram/actions/messageLifecycle";
import { sweepRecentComments } from "./antiRaid/recentComments";
import { antiRaidCacheSweepTimer } from "../cache/workers/antiRaid/worker";
import {
  antiRaidDispatchSignal,
  drainAntiRaidTasks,
  quiesceAntiRaidDispatch,
  resetAntiRaidTaskTracker,
  trackAntiRaidTask,
} from "./antiRaid/taskTracker";
import {
  handleWorkerDuplexResponse,
  initializeWorkerDuplex,
  isWorkerDuplexResponse,
  resetWorkerDuplex,
  setWorkerDuplexRequestSignal,
} from "../libs/workerDuplex";
import type { WorkerDuplexOutbound } from "../types/workerDuplex";
import { installTelegramApi } from "../infra/telegram/client";
import { workerTelegramApi } from "../infra/telegram/workerClient";
import { acceptForwardedLogBatch } from "../infra/logger";

/**
 * 入群守卫线程（Bun Worker）：入群验证 + 反刷群私密模式的合并流水线。
 * 主线程（app/registerHandlers.ts → antiRaid/workerBridge.ts 代理）只做事件投递。
 *
 * 本文件是两台状态机（packages/states/verification.ts / lockdown.ts）的解释器
 * 入口：入群验证核心、事件翻译、副作用和提醒 owner 分别位于
 * antiRaid/verificationRuntime.ts、verificationEvents.ts、
 * verificationEffects.ts、verificationReminders.ts；私密模式位于
 * antiRaid/lockdownRuntime.ts。五类状态各自由 cache/workers/antiRaid/ 下的领域
 * 模块持有。本文件只剩消息路由与缓存 sweep 调度。
 * /block 黑名单的处置副作用（antiRaid/blocklistEffects.ts）也挂在本线程：
 * 它不带状态机，判定在主线程做完，这里只编排踢人这一步异步能力动作。
 * /ad_detect 广告检测（antiRaid/adDetect/）整条流水线同样挂在这里：按发送者
 * 归并消息串、固定节拍批量送配置的 provider 判定、命中后删消息并播报，判定结果回投
 * 主线程换成一次与 /block 等价的拉黑 + 各群封禁。
 * 关键约定（详见各 runtime 模块头）：
 * - dispatch 里状态更替是同步的，副作用（含主线程网络能力请求）一律事后执行——消息
 *   按 FIFO 逐条处理，同一波刷屏入群的后续投递不会被网络往返卡住，
 *   越过阈值那次入群触发的私密模式占位对同批后续入群立即生效。
 * - 异步回调（提醒落地回填、管理员核查）以「状态对象同一性」识别过期：
 *   状态一旦被替换/删除，捕获的旧引用对不上，回调自动放弃。
 *
 * 发往 Telegram 的调用统一经双工能力请求回到主线程的唯一客户端与总闸；本线程
 * 不使用本地 Telegram 网络客户端。error 日志仍经 logger.ts 回传主线程。
 *
 * lockdown/unlock 与 pending verification 变化都会回报主线程；前者写入
 * SQLite `chat_states`，后者由主线程转投 Disk I/O Worker 的当日增量 JSON。两者都可
 * 在 Worker 或整个进程重建后 adopt。
 */

declare const self: Worker;

/** 路由一条主线程消息；独立导出便于验证协议而不启动真实 Worker。 */
export function handleAntiRaidWorkerMessage(msg: AntiRaidWorkerMessage): void {
  switch (msg.type) {
    case "agentConfig":
      // 主线程投给本线程的第一条消息（见 types/antiRaid.ts 的
      // AntiRaidAgentConfigMessage）。本线程此后不读 config/agent.json，
      // 崩溃重建也只等主线程重放同一份快照。
      adoptAdDetectAgentConfig(msg.adDetect);
      break;
    case "join":
      handleJoin(msg);
      break;
    case "left":
      if (!deleteDeferredVerification(msg.chatId, msg.userId)) {
        dispatchVerification(msg.chatId, msg.userId, { type: "left" });
      }
      break;
    case "deactivateChat":
      if (msg.cleanupVerificationMessages) disableJoinGuardChat(msg.chatId);
      else deactivateVerificationChat(msg.chatId);
      deactivateLockdownChat(msg.chatId);
      // 在途的黑名单补扫可能还要跑几分钟；停管之后继续在这个群里封人是越权。
      bumpBlocklistRemovalEpoch(msg.chatId);
      // 待检的广告消息串同理：停管之后不再替这个群判定，也不再在这里删消息。
      clearChatAdDetect(msg.chatId);
      // 刷屏计数与权限镜像一并丢掉：重新接管时主线程会重新观测并镜像过来，
      // 计数也该从零开始，不能拿停管之前攒的窗口在新一轮里凑出一次禁言。
      clearChatFloodWindows(msg.chatId);
      forgetWorkerBotPermissions(msg.chatId);
      forgetWorkerChatKind(msg.chatId);
      break;
    case "deactivateJoinGuard":
      // `/antiraid disable` 专用：只收掉入群这条链路。验证记录逐条经状态机的
      // guardDisabled 转移收摊：删除仍带按钮的验证提醒，从此不再触发提醒、超时
      // 踢出与终态处置。仍生效的私密模式走可恢复解锁：
      // 开关都关了，没人再会解开那把邀请权限的锁。
      //
      // 广告检测队列、刷屏窗口、权限与群类型镜像、在途黑名单补扫**都不动**：
      // 那几样各有各的开关，见 types/antiRaid.ts 的 DeactivateJoinGuardMessage。
      disableJoinGuardChat(msg.chatId);
      deactivateLockdownChat(msg.chatId);
      break;
    case "message":
      handleTrackedMessage(msg);
      break;
    case "callback":
      handleVerificationCallback(msg);
      break;
    case "adopt":
      adoptLockdowns(msg.lockdowns);
      break;
    case "lockdownPersisted":
      handleLockdownPersisted(msg);
      break;
    case "adoptVerifications":
      adoptVerifications(msg);
      break;
    case "verificationPersisted":
      handleVerificationPersisted(msg);
      break;
    case "adminsChanged":
      applyAdminChange(msg.chatId, msg.userId, msg.isInviterExempt);
      break;
    case "removeBlockedMembers":
      // 判定已在主线程做完（名单是主线程状态），这里只执行网络动作；
      // 任务交给跟踪器后台等待，不阻塞 mailbox。落地结果经回执回主线程销镜像。
      void trackAntiRaidTask({
        task: handleRemoveBlockedMembers({
          msg,
          publish: (event: BlockedMembersRemovedEvent): void => self.postMessage(event),
        }),
        blocklistChatId: msg.chatId,
      });
      break;
    case "adCandidate":
      // 只做同步入队；判定与处置由固定节拍的批处理驱动，见 adDetect/queue.ts。
      enqueueAdCandidate(msg);
      break;
    case "clearAdDetect":
      clearChatAdDetect(msg.chatId);
      break;
    case "floodCandidate":
      // 同步记账；只有越过阈值那一条才派生后台任务去禁言，见 antiRaid/floodControl.ts。
      handleFloodCandidate(msg);
      break;
    case "clearFloodControl":
      clearChatFloodWindows(msg.chatId);
      break;
    case "botPermissionsChanged":
      applyBotPermissionsChange(msg.chatId, msg.permissions);
      break;
    case "chatKind":
      applyChatKindChange(msg.chatId, msg.isSupergroup);
      break;
    case "barrier":
      self.postMessage({ type: "barrierComplete", barrierId: msg.barrierId });
      break;
    case "drain": {
      // drain 只发生在停机路径上：先停掉广告判定的节拍，别在退出前又开一批新的
      // LLM 请求、又去删一轮消息。在途的那次不在等待集合里，不会拖住 drain。
      quiesceAdDetectQueue();
      // 再撤掉还在消息桶或分类型 429 车道里等待的尽力而为请求（刷屏禁言按设计能等 2 分钟，
      // 而 drain 的预算是秒级）。排在延迟删除 flush 之前是有意的：那一步是
      // drain 期间刻意要发出去的新请求，不得继承前一阶段的取消（见 taskTracker.ts）。
      quiesceAntiRaidDispatch();
      // 所有 deleteMessageAfter 路径由同一 owner 认领；刷屏公告会按群合批。
      // 返回的请求接进 task tracker，避免 Worker 终止时遗漏已启动的删除。
      // 这些请求属于 drain 自己，不能继承刚 abort 的业务信号。调用同步栈返回前
      // 恢复该信号，让可能迟到的验证 timer 继续 fail-fast；每个双工请求已经捕获
      // 创建时的 null，不受恢复影响。
      setWorkerDuplexRequestSignal(null);
      let deletionTasks: readonly Promise<void>[];
      try {
        deletionTasks = flushPendingMessageDeletions();
      } finally {
        setWorkerDuplexRequestSignal(antiRaidDispatchSignal());
      }
      for (const task of deletionTasks) {
        void trackAntiRaidTask({ task });
      }
      void drainAntiRaidTasks().then((): void => {
        self.postMessage({ type: "drainComplete", drainId: msg.drainId });
      });
      break;
    }
  }
}

/** TTL 判断不能代替删除：只“视为过期”仍会让 Map 按历史群数永久增长。 */
export function sweepAntiRaidWorkerCaches(now: number = Date.now()): void {
  sweepAdminCache(now);
  sweepLinkedChannelCache(now);
  sweepVerificationRevisionCache(now);
  sweepRecentComments(now);
  sweepAdDetect(now);
  sweepFloodWindows(now);
}

/** Worker 线程启动入口；主线程导入本模块时不得注册 handler 或 sweeper。 */
export function startAntiRaidWorker(): void {
  if (antiRaidCacheSweepTimer.current !== null) return;
  installTelegramApi(workerTelegramApi);
  initializeWorkerDuplex<AntiRaidWorkerRequest>((
    message: WorkerDuplexOutbound<AntiRaidWorkerRequest>,
    transfer?: Bun.Transferable[]
  ): void => {
    if (transfer === undefined) self.postMessage(message);
    else self.postMessage(message, transfer);
  });
  setWorkerDuplexRequestSignal(antiRaidDispatchSignal());
  startAdDetectQueue((event: AdDetectedEvent): void => self.postMessage(event));
  self.onmessage = (event: MessageEvent<unknown>): void => {
    if (acceptForwardedLogBatch(event.data)) return;
    if (isWorkerDuplexResponse(event.data)) {
      handleWorkerDuplexResponse(event.data);
      return;
    }
    handleAntiRaidWorkerMessage(event.data as AntiRaidWorkerMessage);
  };
  antiRaidCacheSweepTimer.current = setInterval(sweepAntiRaidWorkerCaches, ANTI_RAID_CACHE_SWEEP_INTERVAL_MS);
  antiRaidCacheSweepTimer.current.unref();
  process.once("exit", stopAntiRaidWorker);
}

/** 协作式退出时清掉唯一 sweeper；强制 terminate 时整个 Worker isolate 一并销毁。 */
export function stopAntiRaidWorker(): void {
  if (antiRaidCacheSweepTimer.current !== null) {
    clearInterval(antiRaidCacheSweepTimer.current);
    antiRaidCacheSweepTimer.current = null;
  }
  stopVerificationRuntime();
  stopLockdownRuntime();
  stopAdDetectQueue();
  resetAdminCache();
  resetLinkedChannelCache();
  recentChannelComments.clear();
  resetFloodWindows();
  resetGenericMessageDeletions();
  resetWorkerBotPermissions();
  resetWorkerChatKind();
  resetAntiRaidTaskTracker();
  resetWorkerDuplex("Anti-Raid Worker stopped before the main-thread request completed.");
  self.onmessage = null;
  process.off("exit", stopAntiRaidWorker);
}

if (!Bun.isMainThread) startAntiRaidWorker();
