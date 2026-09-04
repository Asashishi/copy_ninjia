import { logger } from "../../infra/logger";
import { JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import { trimSlidingWindowArray } from "../../libs/slidingWindowRateLimit";
import {
  LOCKDOWN_KICK_DEDUPE_MS,
} from "../../consts/antiRaid/verification";
import {
  deferredVerificationRecords,
  threadCommentConfirmations,
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
} from "../../cache/workers/antiRaid/verification";
import type {
  AdoptVerificationsMessage,
  NewMemberMessage,
  TrackedChatMessage,
  VerificationPersistedMessage,
  VerifyCallbackMessage,
} from "../../types/antiRaid/protocol";
import type {
  DeferredVerificationRecord,
} from "../../types/antiRaid/verification";
import type {
  VerificationDeleteEvent,
  VerificationDeferredEvent,
  VerificationUpsertEvent,
} from "../../types/antiRaid/events";
import {
  transitionVerification,
} from "../../states/verification";
import type {
  ExpelSnapshot,
  VerificationEvent,
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import {
  type ParsedVerificationKey,
  parseVerificationKey,
  verificationKey,
  verificationKeyPrefix,
} from "../../libs/verificationKey";
import { runVerificationEffects } from "./verificationEffects";
import {
  handleJoinEvent,
  handleTrackedMessageEvent,
  handleVerificationCallbackEvent,
} from "./verificationEvents";
import {
  cancelReminderDelivery,
  clearReminderDeliveries,
  ensurePendingReminder,
} from "./verificationReminders";
import { trackAntiRaidTask } from "./taskTracker";
import type { VerificationEntry } from "../../types/antiRaid/internal";
import {
  isPersistedVerificationState,
  verificationSnapshot,
} from "./verificationSnapshot";

declare const self: Worker;

/**
 * 入群验证状态机（packages/states/verification.ts）的核心解释器。
 *
 * 本模块只负责同步状态更替、timer、generation/revision 镜像与恢复；Telegram
 * 副作用、提醒投递、入站事件翻译分别位于 verificationEffects.ts、
 * verificationReminders.ts、verificationEvents.ts。异步结果都通过本模块的
 * dispatcher 回投，保持状态对象同一性和单一 revision 发布入口。
 */

/** pending 起验证超时计时，exempt/kicked 起去重窗口；kickPending 等调用结算。 */
function startVerificationTimer(
  chatId: number,
  userId: number,
  state: VerificationState
): ReturnType<typeof setTimeout> | undefined {
  if (state.kind === "pending") {
    const expiryTimer: ReturnType<typeof setTimeout> = setTimeout(
      (): void => dispatchVerification(
        chatId,
        userId,
        { type: "verifyTimeout", now: Date.now() }
      ),
      Math.max(0, state.expiresAt - Date.now())
    );
    expiryTimer.unref();
    return expiryTimer;
  }
  if (
    state.kind === "kickPending" ||
    state.kind === "checkingInviter" ||
    state.kind === "expelling"
  ) {
    return undefined;
  }
  const dedupeTimer: ReturnType<typeof setTimeout> = setTimeout(
    (): void => dispatchVerification(chatId, userId, { type: "dedupeExpired" }),
    LOCKDOWN_KICK_DEDUPE_MS
  );
  dedupeTimer.unref();
  return dedupeTimer;
}

/**
 * 把事件喂给某成员的状态机并同步落地结果；网络副作用异步执行，不阻塞
 * Worker mailbox 中后续投递。
 */
export function dispatchVerification(
  chatId: number,
  userId: number,
  event: VerificationEvent
): void {
  const key: string = verificationKey(chatId, userId);
  const entry: VerificationEntry | undefined = verificationEntries.get(key);
  const previousWasPersisted: boolean =
    isPersistedVerificationState(entry?.state);
  const {
    next,
    effects,
    snapshotChanged = false,
    rescheduleTimer = false,
    retainPersistedSnapshot = false,
  }: VerificationTransition = transitionVerification(entry?.state, event);
  if (next !== entry?.state) {
    cancelReminderDelivery(key);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    if (next === undefined) {
      verificationEntries.delete(key);
    } else {
      verificationEntries.set(key, {
        state: next,
        timer: startVerificationTimer(chatId, userId, next),
      });
    }
  } else if (rescheduleTimer && entry !== undefined && next !== undefined) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = startVerificationTimer(chatId, userId, next);
  }
  if (snapshotChanged || next !== entry?.state) {
    if (retainPersistedSnapshot) {
      publishVerificationDeferred(chatId, userId);
    } else {
      publishVerificationChange(chatId, userId, previousWasPersisted);
    }
  }
  if (effects.length > 0) {
    void trackAntiRaidTask({
      task: runVerificationEffects({
        chatId,
        userId,
        effects,
        dispatchVerification,
        publishVerificationChange,
      }).catch((error: unknown): void => {
        logger.error("Error running join verification effects:", error);
      }),
    });
  }
}

/** 预算耗尽只发布最小延后索引；不得递增 revision 或写删除墓碑。 */
function publishVerificationDeferred(chatId: number, userId: number): void {
  if (verificationGeneration.current <= 0) return;
  const key: string = verificationKey(chatId, userId);
  const revision: number | undefined = verificationRevisions.get(key)?.revision;
  if (revision === undefined) return;
  const record: DeferredVerificationRecord = {
    chatId,
    userId,
    generation: verificationGeneration.current,
    revision,
  };
  deferredVerificationRecords.set(key, record);
  verificationRevisions.set(key, { revision, retiredAt: Date.now() });
  self.postMessage({
    type: "verificationDeferred",
    record,
  } satisfies VerificationDeferredEvent);
}

/** 离群或显式关闭时把本进程延后的磁盘终态转成正常 tombstone。 */
export function deleteDeferredVerification(
  chatId: number,
  userId: number
): boolean {
  const key: string = verificationKey(chatId, userId);
  const deferred: DeferredVerificationRecord | undefined =
    deferredVerificationRecords.get(key);
  if (deferred === undefined) return false;
  deferredVerificationRecords.delete(key);
  const revision: number = deferred.revision + 1;
  verificationRevisions.set(key, { revision, retiredAt: Date.now() });
  self.postMessage({
    type: "verificationDelete",
    chatId,
    userId,
    generation: verificationGeneration.current,
    revision,
  } satisfies VerificationDeleteEvent);
  return true;
}

/** pending/终态发布 upsert，只在彻底收尾后发布 delete。 */
function publishVerificationChange(
  chatId: number,
  userId: number,
  previousWasPersisted: boolean
): void {
  if (verificationGeneration.current <= 0) return;
  const key: string = verificationKey(chatId, userId);
  const state: VerificationState | undefined =
    verificationEntries.get(key)?.state;
  const revision: number =
    (verificationRevisions.get(key)?.revision ?? 0) + 1;
  if (isPersistedVerificationState(state)) {
    verificationRevisions.set(key, { revision });
    self.postMessage({
      type: "verificationUpsert",
      record: verificationSnapshot({ chatId, userId, state, revision }),
    } satisfies VerificationUpsertEvent);
  } else if (previousWasPersisted) {
    verificationRevisions.set(key, { revision, retiredAt: Date.now() });
    self.postMessage({
      type: "verificationDelete",
      chatId,
      userId,
      generation: verificationGeneration.current,
      revision,
    } satisfies VerificationDeleteEvent);
  }
}

/** Worker 重建时接管主线程内存镜像；重复 adopt 按 revision 幂等。 */
export function adoptVerifications(message: AdoptVerificationsMessage): void {
  if (message.generation < verificationGeneration.current) return;
  if (message.generation > verificationGeneration.current) {
    for (const entry of verificationEntries.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    verificationEntries.clear();
    verificationRevisions.clear();
    deferredVerificationRecords.clear();
    threadCommentConfirmations.clear();
    clearReminderDeliveries();
    verificationGeneration.current = message.generation;
  }

  const now: number = Date.now();
  for (const record of message.deferredVerifications ?? []) {
    if (record.generation !== message.generation) continue;
    const key: string = verificationKey(record.chatId, record.userId);
    deferredVerificationRecords.set(key, { ...record });
    verificationRevisions.set(key, {
      revision: record.revision,
      retiredAt: now,
    });
  }

  for (const record of message.verifications) {
    const key: string = verificationKey(record.chatId, record.userId);
    if ((verificationRevisions.get(key)?.revision ?? 0) >= record.revision) {
      continue;
    }
    verificationRevisions.set(key, { revision: record.revision });
    const expelSnapshot: ExpelSnapshot = {
      label: record.label,
      isBot: record.isBot,
      announcementMessageId: record.announcementMessageId,
      reminderMessageId: record.reminderMessageId,
      replyReminderMessageId: record.replyReminderMessageId,
      joinedAt: record.joinedAt,
      expiresAt: record.expiresAt,
    };
    const state: VerificationState = record.phase === "kickPending"
      ? {
        kind: "kickPending",
        label: record.label,
        isBot: record.isBot,
        requestedAt: record.requestedAt,
        countedJoinAt: record.countedJoinAt,
        announcementMessageId: record.announcementMessageId,
        effectStarted: false,
        executionStarted: false,
      }
      : record.phase === "checkingInviter"
      ? {
        kind: "checkingInviter",
        inviterId: record.terminalInviterId,
        snapshot: expelSnapshot,
      }
      : record.phase === "expelling"
        ? {
          kind: "expelling",
          reason: record.expelReason,
          snapshot: expelSnapshot,
          successNoticeSent: record.successNoticeSent,
          failureNoticeSent: record.failureNoticeSent,
          unconfirmedNoticeSent: record.unconfirmedNoticeSent,
          removalConfirmed: record.removalConfirmed,
        }
        : {
          kind: "pending",
          label: record.label,
          isBot: record.isBot,
          announcementMessageId: record.announcementMessageId,
          // 与 states/verification.ts 的刷屏窗口共用同一份边界判定：手写 filter
          // 会漏掉时钟回拨后落在「未来」的那些，恢复出来的记录带着一整窗永不
          // 过期的时间戳，接着几条发言就能把人判成 flood。
          trackedMessageTimes: trimSlidingWindowArray({
            timestamps: record.trackedMessageTimes,
            windowMs: JOIN_WINDOW_MS,
            now,
          }),
          invitedBy: record.invitedBy,
          reminderMessageId: record.reminderMessageId,
          replyReminderMessageId: record.replyReminderMessageId,
          replyReminderRequested: record.replyReminderRequested,
          welcomeAnchorMessageId: record.welcomeAnchorMessageId,
          reminderSuperseded: record.reminderSuperseded,
          joinedAt: record.joinedAt,
          expiresAt: record.expiresAt,
        };
    // 同代增量重放也要先清旧 timer，否则旧期限会提前触发新状态。
    const previousEntry: VerificationEntry | undefined = verificationEntries.get(key);
    if (previousEntry?.timer !== undefined) clearTimeout(previousEntry.timer);
    cancelReminderDelivery(key);
    verificationEntries.set(key, {
      state,
      timer: startVerificationTimer(record.chatId, record.userId, state),
    });
    if (state.kind === "pending" && record.expiresAt <= now) {
      dispatchVerification(
        record.chatId,
        record.userId,
        { type: "verifyTimeout", now }
      );
    } else if (state.kind === "pending") {
      ensurePendingReminder({
        chatId: record.chatId,
        userId: record.userId,
        state,
        dispatchVerification,
      });
    } else if (
      (
        state.kind === "kickPending" ||
        state.kind === "checkingInviter" ||
        state.kind === "expelling"
      ) &&
      message.resumePersistedTerminals === true
    ) {
      dispatchVerification(
        record.chatId,
        record.userId,
        state.kind === "expelling" && state.successNoticeSent === true
          ? { type: "expelSettled" }
          : { type: "terminalPersisted" }
      );
    }
  }
}

/** 只有精确匹配当前终态 revision 的落盘回执才能启动副作用。 */
export function handleVerificationPersisted(
  message: VerificationPersistedMessage
): void {
  if (message.generation !== verificationGeneration.current) return;
  const knownRevision: number | undefined =
    verificationRevisions.get(message.key)?.revision;
  if (knownRevision !== message.revision) return;
  const parsed: ParsedVerificationKey | null = parseVerificationKey(message.key);
  if (parsed === null) return;
  const chatId: number = parsed.chatId;
  const userId: number = parsed.userId;
  const state: VerificationState | undefined =
    verificationEntries.get(message.key)?.state;
  if (
    state?.kind !== "kickPending" &&
    state?.kind !== "checkingInviter" &&
    state?.kind !== "expelling"
  ) return;
  dispatchVerification(
    chatId,
    userId,
    state.kind === "expelling" && state.successNoticeSent === true
      ? { type: "expelSettled" }
      : { type: "terminalPersisted" }
  );
}

/**
 * `/antiraid disable`：把这个群每一条验证记录**经状态机**收摊。
 *
 * 与 deactivateVerificationChat 的区别不只是范围，更是**走不走状态机**。那条是
 * 停管/退群的紧急拆除，直接删内存条目再补 tombstone；这条把每条记录都喂给
 * dispatchVerification 走一次 guardDisabled 转移，让「关掉之后哪些事不再发生」
 * 由状态机自己说了算，而不是散落在这里的删表逻辑（见 states/verification/disable.ts：
 * 一律回 ABSENT；仍在群里的带按钮提醒会删除，但不再提醒、不踢人）。
 *
 * 这样写还有一个实际好处：终态（checkingInviter/expelling）的 tombstone 由
 * dispatchVerification 统一发布，重启后不会被 adopt 重放回来接着踢人。
 *
 * 时序上先删 thread comment 确认 owner：它们持有指向状态对象的 token，逐条转移
 * 之后再删只是让那些 token 先落一次空。
 */
export function disableJoinGuardChat(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  for (const key of threadCommentConfirmations.keys()) {
    if (key.startsWith(prefix)) threadCommentConfirmations.delete(key);
  }
  for (const key of [...verificationEntries.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const parsed: ParsedVerificationKey | null = parseVerificationKey(key);
    if (parsed === null) {
      // 理论上进不来（键由 verificationKey 生成）；真的进来了也不能把条目留下，
      // 但没有 userId 就没法投递 tombstone，只能就地删掉并留一行诊断。
      const entry: VerificationEntry | undefined = verificationEntries.get(key);
      if (entry?.timer !== undefined) clearTimeout(entry.timer);
      cancelReminderDelivery(key);
      verificationEntries.delete(key);
      logger.error(`Dropped a join verification entry with an unparsable key while disabling the guard: ${key}`);
      continue;
    }
    dispatchVerification(chatId, parsed.userId, { type: "guardDisabled" });
  }
  for (const key of [...deferredVerificationRecords.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const parsed: ParsedVerificationKey | null = parseVerificationKey(key);
    if (parsed === null) {
      deferredVerificationRecords.delete(key);
      logger.error(`Dropped a deferred join verification with an unparsable key while disabling the guard: ${key}`);
      continue;
    }
    deleteDeferredVerification(chatId, parsed.userId);
  }
}

/** 取消某群所有验证 owner，并为每条持久化记录发布 tombstone。 */
export function deactivateVerificationChat(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  for (const key of threadCommentConfirmations.keys()) {
    if (key.startsWith(prefix)) threadCommentConfirmations.delete(key);
  }
  for (const [key, entry] of [...verificationEntries]) {
    if (!key.startsWith(prefix)) continue;
    cancelReminderDelivery(key);
    const parsed: ParsedVerificationKey | null = parseVerificationKey(key);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    verificationEntries.delete(key);
    if (isPersistedVerificationState(entry.state) && parsed !== null) {
      publishVerificationChange(chatId, parsed.userId, true);
    }
  }
  for (const key of [...deferredVerificationRecords.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const parsed: ParsedVerificationKey | null = parseVerificationKey(key);
    if (parsed === null) {
      deferredVerificationRecords.delete(key);
      logger.error(`Dropped a deferred join verification with an unparsable key during chat teardown: ${key}`);
      continue;
    }
    deleteDeferredVerification(chatId, parsed.userId);
  }
}

/** Worker 停止时清理所有本地 timer/owner；主线程镜像仍保留恢复数据。 */
export function stopVerificationRuntime(): void {
  clearReminderDeliveries();
  threadCommentConfirmations.clear();
  for (const entry of verificationEntries.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
  }
  verificationEntries.clear();
  verificationRevisions.clear();
  deferredVerificationRecords.clear();
  verificationGeneration.current = 0;
}

/** 保持 Worker 与测试使用的既有入口不变。 */
export function handleJoin(message: NewMemberMessage): void {
  handleJoinEvent({ message, dispatchVerification });
}

/** 保持 Worker 与测试使用的既有入口不变。 */
export function handleTrackedMessage(message: TrackedChatMessage): void {
  handleTrackedMessageEvent({ message, dispatchVerification });
}

/** 保持 Worker 与测试使用的既有入口不变。 */
export function handleVerificationCallback(message: VerifyCallbackMessage): void {
  handleVerificationCallbackEvent({ message, dispatchVerification });
}
