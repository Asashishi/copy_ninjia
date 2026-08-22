import { logger } from "../../infra/logger";
import type { ChatPermissions, ChatFullInfo } from "@grammyjs/types";
import { deleteMessage, joinVerificationApi, sendMessage } from "../../infra/telegram";
import { restoreLockdownInvitePermission } from "../../infra/telegram/lockdownPermissions";
import {
  ANTI_RAID_PER_MINUTE_LIMIT,
  JOIN_WINDOW_MS,
  LOCKDOWN_MS,
} from "../../consts/antiRaid/lockdown";
import { INDEPENDENT_CHAT_PERMISSIONS_OTHER } from "../../consts/telegram";
import {
  joinWindows,
  lastLockdownIntentId,
  lockdownApiChains,
  lockdownApiRunner,
  lockdownEntries,
  lockdownRetriggerCooldowns,
} from "../../cache/workers/antiRaid/lockdown";
import { LinkedQueue } from "../../libs/linkedQueue";
import { normalizeChatPermissions } from "../../libs/chatPermissions";
import type { LockdownEvent, UnlockEvent } from
  "../../types/antiRaid/events";
import type {
  AdoptableLockdown,
  LockdownPersistedMessage,
  LockdownPersistFailedMessage,
} from "../../types/antiRaid/protocol";
import { transitionLockdown } from "../../states/lockdown";
import type {
  LockdownAbandonReason,
  LockdownEffect,
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";
import { fetchAdminIds, freshAdminIds } from "./adminCache";
import { trimSlidingWindow } from "../../libs/slidingWindowRateLimit";
import type { JoinWindow, LockdownEntry } from "../../types/antiRaid/internal";
import { trackAntiRaidTask } from "./taskTracker";

declare const self: Worker;

function nextLockdownIntentId(): number {
  lastLockdownIntentId.current = Math.max(Date.now(), lastLockdownIntentId.current + 1);
  return lastLockdownIntentId.current;
}

/**
 * 反刷群私密模式状态机（packages/states/lockdown.ts）的解释器：把每条投递翻译成
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

function lockdownAnnouncementText(joinCount?: number): string {
  const influx: string = joinCount === undefined
    ? "检测到短时间内大量成员入群"
    : `${JOIN_WINDOW_MS / 1000} 秒内冲进来了 ${joinCount} 个杂鱼`;
  return `哼，${influx}，本天才怀疑是有人在拉人头，先禁止普通成员邀请新人 ${LOCKDOWN_MS / 60_000} 分钟压压惊♡`;
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
        break;
      }
      case "scheduleRestoreRetry": {
        const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
        if (!entry) break;
        if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
        entry.retryTimer = setTimeout((): void => {
          entry.retryTimer = undefined;
          dispatchLockdown(chatId, { type: "restoreRetryFired" });
        }, effect.delayMs);
        break;
      }
      case "scheduleReapplyRetry": {
        const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
        if (!entry) break;
        if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
        entry.retryTimer = setTimeout((): void => {
          entry.retryTimer = undefined;
          dispatchLockdown(chatId, { type: "reapplyRetryFired" });
        }, effect.delayMs);
        break;
      }
      case "prepareApply":
        prepareApplyLockdown(chatId, effect.joinCount);
        break;
      case "persistState":
        publishLockdownState(chatId);
        break;
      case "commitApply":
        commitApplyLockdown(chatId);
        break;
      case "beginRestore":
        beginRestoreLockdown(chatId, effect.originalPermissions);
        break;
      case "beginReapply":
        reapplyLockdownRestriction(chatId);
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
        beginLockdownAnnouncement(chatId, effect.joinCount);
        break;
      case "deleteLockdownAnnouncement":
        deleteLockdownAnnouncement(chatId, effect.messageId);
        break;
      case "suppressRetrigger":
        beginLockdownRetriggerCooldown(chatId, effect.reason, effect.durationMs);
        break;
      case "announceUnlock":
        void trackAntiRaidTask({
          task: sendMessage({
            chatId,
            text: `${LOCKDOWN_MS / 60_000} 分钟到啦，解除限制，普通成员又能拉人了，杂鱼们悠着点哦♡`,
            api: joinVerificationApi,
          }),
        });
        break;
    }
  }
}

function publishLockdownState(chatId: number): void {
  const entry: LockdownEntry | undefined = lockdownEntries.get(chatId);
  if (entry === undefined) return;
  const state: LockdownState = entry.state;
  // 公告记账在所有阶段都成立：公告与占位同刻发出，早于 intent 形成。
  const announced: boolean = state.announced;
  const announcementMessageId: number | undefined = state.announcementMessageId;
  let intentId: number;
  let originalPermissions: ChatPermissions;
  let expiresAt: number;
  if (state.kind === "applying") {
    if (state.stage !== "prepared") return;
    intentId = state.intentId;
    originalPermissions = state.originalPermissions;
    expiresAt = Date.now();
  } else {
    intentId = state.intentId;
    originalPermissions = state.originalPermissions;
    if (state.kind === "active" || state.kind === "reconciling") {
      if (entry.restoreAt === undefined) {
        throw new Error(`Lockdown ${state.kind} state for chat ${chatId} is missing its restore deadline.`);
      }
      expiresAt = entry.restoreAt;
    } else {
      expiresAt = Date.now();
    }
  }
  self.postMessage({
    type: "lockdown",
    chatId,
    phase: state.kind,
    intentId,
    originalPermissions,
    announced,
    announcementMessageId,
    expiresAt,
  } satisfies LockdownEvent);
}

/**
 * 主线程报告这一轮意图写不进 SQLite：按阶段 fail-safe 打开，并进入重触发冷却。
 *
 * 落盘是「崩溃后还有人能恢复这条限制」的唯一凭据。写不进去还继续锁着群，就是
 * 今天这条故障的形态：占位永远停在 APPLYING，秒踢不停、5 分钟的倒计时压根
 * 没被安排过（见 states/lockdown.ts 的 persistFailed 分支）。
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
  lockdownRetriggerCooldowns.delete(chatId);
  dispatchLockdown(chatId, { type: "deactivate", intentId: nextLockdownIntentId() });
}

/** 丢弃某群的入群滑窗与它的静默清理计时器；重新计数从零开始。 */
function clearJoinWindow(chatId: number): void {
  const window: JoinWindow | undefined = joinWindows.get(chatId);
  if (window === undefined) return;
  clearTimeout(window.resetTimeout);
  joinWindows.delete(chatId);
}

/** 私密模式加锁/纠偏共用：在给定权限上关闭 can_invite_users，其余字段原样保留。 */
function restrictedPermissions(permissions: ChatPermissions): ChatPermissions {
  return { ...permissions, can_invite_users: false };
}

/**
 * 把一次私密模式相关的 setChatPermissions 调用（加锁/恢复/纠偏）挂到该群的
 * 串行链上：保证这三类调用严格按 dispatch 顺序一个个执行完，不会因为各自
 * 独立发起的网络往返乱序，让后发起的调用比先发起的调用更早/更晚落地在
 * Telegram 上（比如纠偏的加锁比它之后才发起的解锁更晚生效，两者都是各自
 * 独立的 fire-and-forget 调用时就可能发生，见 states/lockdown.ts
 * restoreResult 分支的类头注释）。链的机制见 libs/keyedSerialTaskRunner.ts；
 * task 自身兜错，链永不因此中断。
 */
function runLockdownApiCall(chatId: number, task: () => Promise<void>): void {
  void trackAntiRaidTask({ task: lockdownApiRunner.run(chatId, task) });
}

/**
 * 占位一落地就发封锁公告（新进群的人从这一刻起被直接请出去），并把发送结果
 * 连同 message ID 回投状态机。与权限调用共用群级串行链，确保显式解除不会越过
 * 仍在途的公告后先行落地。
 *
 * message ID 走 onSent 同步登记：停机 abort 可能恰好落在「远端已经收下、await
 * 还没解开」的窗口里，返回值会连同 ID 一起丢失，本轮结束时就再也删不掉群里
 * 那条公告（见 infra/telegram/actions/messages.ts 的 onSent 注释）。
 */
function beginLockdownAnnouncement(chatId: number, joinCount?: number): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    let messageId: number | undefined;
    try {
      const sentMessageId: number | undefined = await sendMessage({
        chatId,
        text: lockdownAnnouncementText(joinCount),
        api: joinVerificationApi,
        onSent: (pendingMessageId: number): void => {
          messageId = pendingMessageId;
        },
      });
      if (sentMessageId !== undefined) messageId = sentMessageId;
    } catch (error: unknown) {
      logger.error(`Error sending anti-raid lockdown announcement for chat ${chatId}:`, error);
    }
    dispatchLockdown(chatId, {
      type: "announcementResult",
      ok: messageId !== undefined,
      messageId,
    });
  });
}

/**
 * 本轮封锁结束，撤掉群里那条封锁公告。
 *
 * 删不掉只记日志：解除的关键动作是把邀请权限还回去，不能让一条留在群里的
 * 旧公告把恢复链带崩（串行链要求 task 自身兜错，见 runLockdownApiCall）。
 */
function deleteLockdownAnnouncement(chatId: number, messageId: number): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      await deleteMessage(chatId, messageId, joinVerificationApi);
    } catch (error: unknown) {
      logger.error(
        `Error deleting the anti-raid lockdown announcement in chat ${chatId}:`,
        error
      );
    }
  });
}

/**
 * 让这个群在冷却期内不再触发私密模式（由状态机的 suppressRetrigger 副作用驱动）。
 *
 * 触发判定挂在每一条越过阈值的入群上，而「状态写不进 SQLite」「原权限读不回来」
 * 这类失败对同一个群通常是系统性的：不冷却就会每进一个人重来一次公告与 API
 * 往返（见 consts/antiRaid/lockdown.ts）。写入时顺手清掉已过期条目——只有作废
 * 路径才会走到这里，条目数与群数同阶，扫一遍远比给每个群挂一个 timer 便宜。
 */
function beginLockdownRetriggerCooldown(
  chatId: number,
  reason: LockdownAbandonReason,
  durationMs: number
): void {
  const now: number = Date.now();
  for (const [cooledChatId, until] of lockdownRetriggerCooldowns) {
    if (now >= until) lockdownRetriggerCooldowns.delete(cooledChatId);
  }
  lockdownRetriggerCooldowns.set(chatId, now + durationMs);
  logger.error(
    `Anti-raid lockdown for chat ${chatId} was abandoned (${reason}); ` +
    `suppressing new lockdown triggers there for ${durationMs / 60_000} minutes. ` +
    "Per-member join verification is unaffected."
  );
}

/** 冷却是否仍然生效；到期条目就地删除，避免长期占位。 */
function lockdownRetriggerCoolingDown(chatId: number, now: number): boolean {
  const until: number | undefined = lockdownRetriggerCooldowns.get(chatId);
  if (until === undefined) return false;
  if (now < until) return true;
  lockdownRetriggerCooldowns.delete(chatId);
  return false;
}

/**
 * 异步执行加锁：取当前默认权限、把 can_invite_users 关掉，结果以 applyResult
 * 回投。真实刷群下这两个调用可能在限流队列里排几分钟，期间占位状态挡住
 * 重复触发（见状态机注释）。
 */
function prepareApplyLockdown(chatId: number, joinCount: number): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      const chat: ChatFullInfo = await joinVerificationApi.getChat(chatId);
      if (!("permissions" in chat) || !chat.permissions) {
        // permissions 字段对群/超级群实际总会返回，缺失多半是异常响应——
        // 放弃这次锁定（入群验证的逐个踢人仍在兜底），也不能拿 {} 当"原始
        // 权限"存进 ACTIVE：到期恢复会把所有省略字段当 false，整群被永久禁言。
        logger.error(`Chat ${chatId} getChat response missing permissions field, skipping anti-raid lockdown`);
        dispatchLockdown(chatId, { type: "applyPreparationFailed" });
        return;
      }
      // 只留持久化 schema 认识的字段：平台新增一个权限键，原样存下去会在落盘
      // 自检处变成致命错误（见 libs/chatPermissions.ts）。写回 Telegram 的那两
      // 处仍用当场读回的原始对象，不能拿这份收敛过的快照去覆盖群权限。
      const originalPermissions: ChatPermissions = normalizeChatPermissions(chat.permissions);
      dispatchLockdown(chatId, {
        type: "applyPrepared",
        originalPermissions,
        joinCount,
        intentId: nextLockdownIntentId(),
      });
    } catch (error: unknown) {
      logger.error("Error preparing anti-raid lockdown:", error);
      dispatchLockdown(chatId, { type: "applyPreparationFailed" });
    }
  });
}

/**
 * applying intent 已落盘后才真正修改 Telegram。先重新读取最新权限，只合并
 * invite 限制，避免 T0 快照覆盖落盘窗口内的管理员修改。读取失败发生在写
 * 操作之前，可安全撤销 intent；set 失败的远端结果不确定，仍需恢复协调。
 */
function commitApplyLockdown(chatId: number): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    let currentPermissions: ChatPermissions;
    try {
      const chat: ChatFullInfo = await joinVerificationApi.getChat(chatId);
      if (!("permissions" in chat) || !chat.permissions) {
        logger.error(
          `Chat ${chatId} commit getChat response missing permissions field, abandoning anti-raid lockdown`
        );
        dispatchLockdown(chatId, { type: "applyCommitPreparationFailed" });
        return;
      }
      currentPermissions = chat.permissions;
    } catch (error: unknown) {
      logger.error(
        "Error refreshing chat permissions before anti-raid lockdown; abandoning unapplied intent:",
        error
      );
      dispatchLockdown(chatId, { type: "applyCommitPreparationFailed" });
      return;
    }
    try {
      await joinVerificationApi.setChatPermissions(
        chatId,
        restrictedPermissions(currentPermissions),
        INDEPENDENT_CHAT_PERMISSIONS_OTHER
      );
      dispatchLockdown(chatId, { type: "applyResult", ok: true });
    } catch (error: unknown) {
      logger.error("Error applying anti-raid lockdown; scheduling a restorative reconciliation:", error);
      dispatchLockdown(chatId, { type: "applyResult", ok: false, restoreIntentId: nextLockdownIntentId() });
    }
  });
}

/** 异步恢复群组原本的默认权限，结果以 restoreResult 回投（失败由状态机安排重试）。 */
function beginRestoreLockdown(chatId: number, originalPermissions: ChatPermissions): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      await restoreLockdownInvitePermission({
        chatId,
        originalPermissions,
        api: joinVerificationApi,
      });
      dispatchLockdown(chatId, { type: "restoreResult", ok: true });
    } catch (error: unknown) {
      logger.error(`Failed to restore chat permissions for ${chatId}, retrying shortly:`, error);
      dispatchLockdown(chatId, { type: "restoreResult", ok: false });
    }
  });
}

/**
 * 迟到的旧 beginRestore 成功回执撞上新峰值重新给满的 ACTIVE 时用来纠偏：
 * 重新读取当前权限，只把 invite 字段补回限制，保留管理员并发修改的其它字段。
 * 结果必须回投状态机：成功后才能从 RECONCILING 回到 ACTIVE；失败由状态机
 * 安排退避重试。挂在同一条 runLockdownApiCall 串行链上，保证不会比它之后才
 * 发起的一次恢复更晚落地。
 */
function reapplyLockdownRestriction(chatId: number): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      const chat: ChatFullInfo = await joinVerificationApi.getChat(chatId);
      if (!("permissions" in chat) || !chat.permissions) throw new Error("getChat response missing permissions");
      await joinVerificationApi.setChatPermissions(
        chatId,
        restrictedPermissions(chat.permissions),
        INDEPENDENT_CHAT_PERMISSIONS_OTHER
      );
      dispatchLockdown(chatId, { type: "reapplyResult", ok: true });
    } catch (error: unknown) {
      logger.error(`Error reapplying anti-raid restriction for chat ${chatId} after a stale restore succeeded; retrying shortly:`, error);
      dispatchLockdown(chatId, { type: "reapplyResult", ok: false });
    }
  });
}

/**
 * 记录一次已确认的新成员加入（由 verificationRuntime.ts 的 handleJoin 按
 * joinCreatesNewRecord 去重后调用）。滑动窗口：最近 JOIN_WINDOW_MS 内的
 * 入群人数超过阈值即触发临时私密模式——不用「首次入群起算、到点整体清零」
 * 的固定桶，是为了防住横跨桶边界的刷群（前桶尾 + 后桶头各塞半个阈值，
 * 固定桶永远数不满）。
 */
export function recordJoin(chatId: number, now: number): void {
  let window: JoinWindow | undefined = joinWindows.get(chatId);
  if (!window) {
    window = { timestamps: new LinkedQueue<number>(), resetTimeout: setTimeout((): boolean => joinWindows.delete(chatId), JOIN_WINDOW_MS) };
    joinWindows.set(chatId, window);
  } else {
    // 清理计时器在每次入群时重置：它到期即意味着窗口静默满 JOIN_WINDOW_MS，
    // 届时所有时间戳都已过期，整个条目可以安全删除。
    clearTimeout(window.resetTimeout);
    window.resetTimeout = setTimeout((): boolean => joinWindows.delete(chatId), JOIN_WINDOW_MS);
  }

  trimSlidingWindow({ timestamps: window.timestamps, windowMs: JOIN_WINDOW_MS, now });
  window.timestamps.push(now);

  if (
    window.timestamps.size > ANTI_RAID_PER_MINUTE_LIMIT &&
    !lockdownRetriggerCoolingDown(chatId, now)
  ) {
    dispatchLockdown(chatId, { type: "thresholdExceeded", joinCount: window.timestamps.size });
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
 * 与状态机），按值精确移除，不能像早期实现那样无差别 shift 队首——
 * VERIFICATION_TIMEOUT_MS（3 分钟）比 JOIN_WINDOW_MS（60s）长，超时终核这条
 * 路径触发时，这条 join 自己的时间戳几乎总是已经被期间其它入群的
 * recordJoin 自然修剪出窗口了；这时无差别 shift 队首会误删窗口内其它人
 * 仍然合法在场的时间戳，让统计总数比真实入群数更少，反而更难触发本该
 * 触发的私密模式。按值查找找不到（已被自然修剪，或窗口已整体过期清空）
 * 就是正确的 no-op——说明这次撤销早就没有意义了。
 */
export function retractJoin(chatId: number, joinedAt: number): void {
  const window: JoinWindow | undefined = joinWindows.get(chatId);
  if (!window) return;
  window.timestamps.removeValue(joinedAt);
}

/** Worker 停止时清除全部 lockdown timer、滑窗和串行链；主线程镜像负责重建。 */
export function stopLockdownRuntime(): void {
  for (const window of joinWindows.values()) clearTimeout(window.resetTimeout);
  for (const entry of lockdownEntries.values()) {
    clearLockdownEntryTimers(entry);
  }
  joinWindows.clear();
  lockdownEntries.clear();
  lockdownApiChains.clear();
  lockdownRetriggerCooldowns.clear();
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
