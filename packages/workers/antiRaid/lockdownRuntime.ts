import {
  nextLockdownIntentId,
  beginLockdownAnnouncement,
  deleteLockdownAnnouncement,
  prepareApplyLockdown,
  commitApplyLockdown,
  beginRestoreLockdown,
  reapplyLockdownRestriction,
} from "./lockdownApi";
import { sendTemporaryMessageFromMain } from "../../infra/telegram/workerClient";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";
import { logger } from "../../infra/logger";
import {
  LOCKDOWN_MS,
} from "../../consts/antiRaid/lockdown";
import {
  lastLockdownIntentId,
  lockdownApiChains,
  lockdownEntries,
} from "../../cache/workers/antiRaid/lockdown";
import type { UnlockEvent } from
  "../../types/antiRaid/events";
import type {
  AdoptableLockdown,
  LockdownPersistedMessage,
  LockdownPersistFailedMessage,
} from "../../types/antiRaid/protocol";
import { transitionLockdown } from "../../states/lockdown";
import type {
  LockdownEffect,
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";
import { fetchAdminIds, freshAdminIds } from "./adminCache";
import type { LockdownEntry } from "../../types/antiRaid/internal";
import { trackAntiRaidTask } from "./taskTracker";
import {
  beginLockdownRetriggerCooldown,
  clearJoinWindow,
  clearJoinWindowCooldown,
  recordJoinWindow,
  retractJoinWindow,
  stopJoinWindowRuntime,
} from "./lockdownJoinWindow";
import { publishLockdownState } from "./lockdownPersistence";

declare const self: Worker;

/**
 * 反刷群私密模式状态机（packages/states/lockdown.ts 与同名目录）的解释器：把每条投递翻译成
 * 状态机事件、同步落下一状态、管理恢复计时器、把返回的副作用列表逐个执行。
 * thresholdExceeded 的占位同步生效——recordJoin 调用 dispatchLockdown 后，
 * 同一批投递里紧随其后的入群立刻就能在 verificationRuntime.ts 的 handleJoin
 * 里看到 lockdownEntries 有记录。lockdown/unlock 事件回报主线程用于持久化 +
 * Worker 崩溃后的 adopt 重放，机制见 antiRaid/workerBridge.ts；总体架构见
 * ../antiRaidWorker.ts 模块头。
 */

function dispatchLockdown(chatId: number, event: LockdownMachineEvent): void {
  const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
  const previousState: LockdownState | undefined = entry?.state;
  const { next, effects }: LockdownTransition = transitionLockdown(entry?.state, event);
  if (next !== entry?.state) {
    if (next === undefined) {
      if (entry) {
        clearLockdownEntryTimers(entry);
        lockdownEntries.delete(chatId);
      }
    } else if (entry) {
      entry.state = next;
      reconcileLockdownEntryTimers(entry, previousState, next);
    } else {
      lockdownEntries.set(chatId, {
        state: next,
        restoreTimer: undefined,
        retryTimer: undefined,
        restoreAt: undefined,
      });
    }
  }
  runLockdownEffects(chatId, effects);
}

function clearRestoreTimer(entry: LockdownEntry): void {
  if (entry.restoreTimer !== undefined) clearTimeout(entry.restoreTimer);
  entry.restoreTimer = undefined;
  entry.restoreAt = undefined;
}

function clearRetryTimer(entry: LockdownEntry): void {
  if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
  entry.retryTimer = undefined;
}

/**
 * 排一次重试节拍：换掉这个群仍在等的那颗重试 timer，到点把 `event` 投回状态机。
 *
 * 恢复重试（restoreRetryFired）与重新收紧重试（reapplyRetryFired）共用
 * `entry.retryTimer` 一个字段——状态机保证同一时刻只有一个阶段在等重试，因此两条
 * 副作用只差事件类型。两个事件都只带 `type`，可以在排程时就定形；`scheduleRestore`
 * 不能这样收，它的 `intentId` 必须在**触发那一刻**才铸出来。
 *
 * 回调先把句柄归零再派发，`reconcileLockdownEntryTimers` 之后就不会去 clear 一颗
 * 已经触发过的 timer。timer 不阻止线程退出，Worker 停止时由 stopLockdownRuntime
 * 统一清理。
 */
function scheduleLockdownRetry(
  chatId: number,
  delayMs: number,
  event: LockdownMachineEvent
): void {
  const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
  if (entry === undefined) return;
  if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
  entry.retryTimer = setTimeout((): void => {
    entry.retryTimer = undefined;
    dispatchLockdown(chatId, event);
  }, delayMs);
  entry.retryTimer.unref();
}

function clearLockdownEntryTimers(entry: LockdownEntry): void {
  clearRestoreTimer(entry);
  clearRetryTimer(entry);
}

/** 状态换代时只保留新阶段仍然拥有的 timer，纠偏与到期 timer 彼此独立。 */
function reconcileLockdownEntryTimers(
  entry: LockdownEntry,
  previous: LockdownState | undefined,
  next: LockdownState
): void {
  if (next.kind === "restoring" || next.kind === "applying") {
    clearLockdownEntryTimers(entry);
    return;
  }
  if (
    next.kind === "active" &&
    (previous?.kind === "restoring" || previous?.kind === "reconciling")
  ) {
    clearRetryTimer(entry);
  }
}

/** 执行一次私密模式转移返回的副作用（主线程网络能力请求不阻塞 mailbox，结果以事件回投）。 */
function runLockdownEffects(chatId: number, effects: LockdownEffect[]): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case "prefetchAdmins":
        if (!effect.onlyIfCold || freshAdminIds(chatId) === undefined) {
          void fetchAdminIds(chatId).catch((error: unknown): void => {
            logger.error(`Error prefetching chat admins for lockdown in chat ${chatId}:`, error);
          });
        }
        break;
      case "scheduleRestore": {
        const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
        if (!entry) break;
        if (entry.restoreTimer !== undefined) clearTimeout(entry.restoreTimer);
        entry.restoreAt = Date.now() + effect.delayMs;
        entry.restoreTimer = setTimeout((): void => {
          entry.restoreTimer = undefined;
          dispatchLockdown(chatId, {
            type: "restoreTimerFired",
            intentId: nextLockdownIntentId(),
          });
        }, effect.delayMs);
        entry.restoreTimer.unref();
        break;
      }
      case "scheduleRestoreRetry":
        scheduleLockdownRetry(chatId, effect.delayMs, { type: "restoreRetryFired" });
        break;
      case "scheduleReapplyRetry":
        scheduleLockdownRetry(chatId, effect.delayMs, { type: "reapplyRetryFired" });
        break;
      case "prepareApply":
        prepareApplyLockdown(chatId, effect.joinCount, dispatchLockdown);
        break;
      case "persistState":
        publishLockdownState(chatId);
        break;
      case "commitApply":
        commitApplyLockdown(chatId, dispatchLockdown);
        break;
      case "beginRestore":
        beginRestoreLockdown(chatId, effect.originalPermissions, dispatchLockdown);
        break;
      case "beginReapply":
        reapplyLockdownRestriction(chatId, dispatchLockdown);
        break;
      case "reportUnlock":
        // 本轮已经处理过的入群不再为下一轮计数：窗口里那 45+ 个时间戳是刚被
        // 这一轮踢出去的人留下的，留着它们会让解除后的第一条入群立刻再锁一
        // 轮，「最长 LOCKDOWN_MS」就成了纸面上的数字。清零后必须重新在
        // JOIN_WINDOW_MS 内攒够阈值才会再次进入私密模式。
        clearJoinWindow(chatId);
        self.postMessage({ type: "unlock", chatId } satisfies UnlockEvent);
        break;
      case "beginLockdownAnnouncement":
        beginLockdownAnnouncement(chatId, effect.joinCount, dispatchLockdown);
        break;
      case "deleteLockdownAnnouncement":
        deleteLockdownAnnouncement(chatId, effect.messageId);
        break;
      case "suppressRetrigger":
        beginLockdownRetriggerCooldown(chatId, effect.reason, effect.durationMs);
        break;
      case "announceUnlock":
        void trackAntiRaidTask({
          task: sendTemporaryMessageFromMain({
            purpose: "notice",
            deleteAfterMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
            chatId,
            text: `${LOCKDOWN_MS / 60_000} 分钟到啦，解除限制，普通成员又能拉人了，杂鱼们悠着点哦♡`,
          }),
        });
        break;
    }
  }
}

/**
 * 主线程报告这一轮意图写不进 SQLite：按阶段 fail-safe 打开，并进入重触发冷却。
 *
 * 未派发的提交撤销占位；可能在途的权限写入沿原串行链补偿，恢复失败仍保留
 * 状态与重试计时器。阶段转移见 states/lockdown/persistence.ts。
 */
export function handleLockdownPersistFailed(msg: LockdownPersistFailedMessage): void {
  dispatchLockdown(msg.chatId, {
    type: "persistFailed",
    phase: msg.phase,
    intentId: msg.intentId,
  });
}

/** 主线程确认 write-ahead 阶段已落盘后，继续对应权限副作用。 */
export function handleLockdownPersisted(msg: LockdownPersistedMessage): void {
  dispatchLockdown(msg.chatId, {
    type: "statePersisted",
    phase: msg.phase,
    intentId: msg.intentId,
  });
}

/** 群被禁用/离开/撤管理员时，先持久化 restoring 再尝试恢复权限。 */
export function deactivateLockdownChat(chatId: number): void {
  clearJoinWindow(chatId);
  // 守卫都关了，重新开启时不该背着上一次的作废冷却继续不设防。
  clearJoinWindowCooldown(chatId);
  dispatchLockdown(chatId, { type: "deactivate", intentId: nextLockdownIntentId() });
}

/**
 * 记录一次已确认的新成员加入（由 verificationRuntime.ts 的 handleJoin 按
 * joinCreatesNewRecord 去重后调用）。滑动窗口：最近 JOIN_WINDOW_MS 内的
 * 入群人数超过阈值即触发临时私密模式——不用「首次入群起算、到点整体清零」
 * 的固定桶，是为了防住横跨桶边界的刷群（前桶尾 + 后桶头各塞半个阈值，
 * 固定桶永远数不满）。
 */
export function recordJoin(chatId: number, now: number): void {
  const joinCount: number | undefined = recordJoinWindow(chatId, now);
  if (joinCount !== undefined) {
    dispatchLockdown(chatId, { type: "thresholdExceeded", joinCount });
  }
}

/**
 * 撤销一次此前 recordJoin 计入的入群计数：管理员拉人的异步豁免事后才确认
 * （见 states/verification.ts 的 adminCheckResolved、handleJoin 的豁免分支、
 * handleTrackedMessage 的频道评论确证分支、handleTimeoutInviterVerdict 的
 * "拉人者确是管理员"分支——这四处转移都只在原记录是 pending 时触发，而
 * pending 记录能存在，必然对应它创建时 joinCreatesNewRecord 判过真、
 * 已经 recordJoin 过一次，参见各转移函数注释）时调用，避免"同步缓存冷时
 * 先计数、异步豁免后却不回退计数"让窗口继续凭空占额度、提早触发私密模式。
 *
 * joinedAt 必须是创建那条 PENDING 记录时 recordJoin 压进窗口的同一个时间戳
 * （见 verificationRuntime.ts 的 handleJoin 把 event.now 同时传给 recordJoin
 * 与状态机），按值精确移除，不能无差别 shift 队首。找不到表示该项已经过期、
 * 窗口已清空，或在极端过载时被硬顶覆盖；前两者无需撤销，最后一种保持
 * overflowThrough 的 fail-safe 饱和判定，直到被覆盖时间戳全部过期。
 */
export function retractJoin(chatId: number, joinedAt: number): void {
  retractJoinWindow(chatId, joinedAt);
}

/** Worker 停止时清除全部 lockdown timer、滑窗和串行链；主线程镜像负责重建。 */
export function stopLockdownRuntime(): void {
  stopJoinWindowRuntime();
  for (const entry of lockdownEntries.values()) {
    clearLockdownEntryTimers(entry);
  }
  lockdownEntries.clear();
  lockdownApiChains.clear();
  lastLockdownIntentId.current = 0;
}

/** 接管上一个（已崩溃的）Worker / 上一个进程留下的私密模式（背景见 antiRaid/workerBridge.ts）。 */
export function adoptLockdowns(lockdowns: AdoptableLockdown[]): void {
  for (
    const {
      chatId,
      phase,
      intentId,
      originalPermissions,
      announced,
      announcementMessageId,
      remainingMs,
      persisted,
    } of lockdowns
  ) {
    dispatchLockdown(chatId, {
      type: "adopt",
      phase,
      intentId,
      originalPermissions,
      announced,
      announcementMessageId,
      remainingMs,
      persisted,
    });
  }
}
