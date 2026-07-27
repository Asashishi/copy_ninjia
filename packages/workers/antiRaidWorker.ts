import {
  handleJoin,
  handleTrackedMessage,
  handleVerificationCallback,
  dispatchVerification,
  adoptVerifications,
  handleVerificationPersisted,
  deactivateVerificationChat,
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
import { bumpBlocklistRemovalEpoch } from "../cache/antiRaid/blocklist";
import { ANTI_RAID_CACHE_SWEEP_INTERVAL_MS } from "../consts/antiRaid/cache";
import { resetAdminCache, sweepAdminCache } from "../cache/antiRaid/admins";
import { resetLinkedChannelCache, sweepLinkedChannelCache } from "../cache/antiRaid/linkedChannels";
import { recentChannelComments } from "../cache/antiRaid/recentComments";
import { sweepVerificationRevisionCache } from "../cache/antiRaid/verification";
import type { AntiRaidWorkerMessage, BlockedMembersRemovedEvent } from "../types/antiRaid";
import { initTelegramClients } from "../infra/telegram/client";
import { sweepRecentComments } from "./antiRaid/recentComments";
import { antiRaidCacheSweepTimer } from "../cache/antiRaid/worker";
import {
  drainAntiRaidTasks,
  resetAntiRaidTaskTracker,
  trackAntiRaidTask,
} from "./antiRaid/taskTracker";

/**
 * 入群守卫线程（Bun Worker）：入群验证 + 反刷群私密模式的合并流水线。
 * 主线程（app/registerHandlers.ts → antiRaid/index.ts 代理）只做事件投递。
 *
 * 本文件是两台状态机（packages/states/verification.ts / lockdown.ts）的解释器
 * 入口：入群验证核心、事件翻译、副作用和提醒 owner 分别位于
 * antiRaid/verificationRuntime.ts、verificationEvents.ts、
 * verificationEffects.ts、verificationReminders.ts；私密模式位于
 * antiRaid/lockdownRuntime.ts。五类状态各自由 cache/antiRaid/ 下的领域
 * 模块持有。本文件只剩消息路由与缓存 sweep 调度。
 * /block 黑名单的处置副作用（antiRaid/blocklistEffects.ts）也挂在本线程：
 * 它不带状态机，判定在主线程做完，这里只执行踢人这一步网络动作。
 * 关键约定（详见各 runtime 模块头）：
 * - dispatch 里状态更替是同步的，副作用（网络请求）一律事后执行——消息
 *   按 FIFO 逐条处理，同一波刷屏入群的后续投递不会被网络往返卡住，
 *   越过阈值那次入群触发的私密模式占位对同批后续入群立即生效。
 * - 异步回调（提醒落地回填、管理员核查）以「状态对象同一性」识别过期：
 *   状态一旦被替换/删除，捕获的旧引用对不上，回调自动放弃。
 *
 * 发往 Telegram 的调用不回主线程绕路——本线程 import infra/telegram/ 时会得到
 * 自己独立的 grammY Api 客户端（用带限流 + 429 自动重试的 joinVerificationApi，
 * 突发的删/踢/发在这里排队，不占用主线程共享客户端）。error 日志经 logger.ts
 * 的转发模式回传主线程统一落盘。
 *
 * lockdown/unlock 与 pending verification 变化都会回报主线程；前者写入
 * state.json，后者由主线程转投 Disk I/O Worker 的当日增量 JSON。两者都可
 * 在 Worker 或整个进程重建后 adopt。
 */

declare const self: Worker;

/** 路由一条主线程消息；独立导出便于验证协议而不启动真实 Worker。 */
export function handleAntiRaidWorkerMessage(msg: AntiRaidWorkerMessage): void {
  switch (msg.type) {
    case "join":
      handleJoin(msg);
      break;
    case "left":
      dispatchVerification(msg.chatId, msg.userId, { type: "left" });
      break;
    case "deactivateChat":
      deactivateVerificationChat(msg.chatId);
      deactivateLockdownChat(msg.chatId);
      // 在途的黑名单补扫可能还要跑几分钟；停管之后继续在这个群里封人是越权。
      bumpBlocklistRemovalEpoch(msg.chatId);
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
    case "barrier":
      self.postMessage({ type: "barrierComplete", barrierId: msg.barrierId });
      break;
    case "drain":
      void drainAntiRaidTasks().then((): void => {
        self.postMessage({ type: "drainComplete", drainId: msg.drainId });
      });
      break;
  }
}

/** TTL 判断不能代替删除：只“视为过期”仍会让 Map 按历史群数永久增长。 */
export function sweepAntiRaidWorkerCaches(now: number = Date.now()): void {
  sweepAdminCache(now);
  sweepLinkedChannelCache(now);
  sweepVerificationRevisionCache(now);
  sweepRecentComments(now);
}

/** Worker 线程启动入口；主线程导入本模块时不得注册 handler 或 sweeper。 */
export function startAntiRaidWorker(): void {
  if (antiRaidCacheSweepTimer.current !== null) return;
  initTelegramClients();
  self.onmessage = (event: MessageEvent<AntiRaidWorkerMessage>): void => {
    handleAntiRaidWorkerMessage(event.data);
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
  resetAdminCache();
  resetLinkedChannelCache();
  recentChannelComments.clear();
  resetAntiRaidTaskTracker();
  self.onmessage = null;
  process.off("exit", stopAntiRaidWorker);
}

if (!Bun.isMainThread) startAntiRaidWorker();
