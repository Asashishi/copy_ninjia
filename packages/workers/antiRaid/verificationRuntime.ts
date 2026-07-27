import { logger } from "../../infra/logger";
import { JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import {
  LOCKDOWN_KICK_DEDUPE_MS,
} from "../../consts/antiRaid/verification";
import {
  threadCommentConfirmations,
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
} from "../../cache/antiRaid/verification";
import type {
  AdoptVerificationsMessage,
  NewMemberMessage,
  TrackedChatMessage,
  VerificationDeleteEvent,
  VerificationPersistedMessage,
  VerificationSnapshot,
  VerificationUpsertEvent,
  VerifyCallbackMessage,
} from "../../types/antiRaid";
import {
  transitionVerification,
} from "../../states/verification";
import type {
  ExpelSnapshot,
  PendingState,
  VerificationEvent,
  VerificationState,
  VerificationTerminalState, VerificationTransition,
} from "../../types/states/verification";
import { verificationKey } from "../../libs/verificationKey";
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
import type { VerificationEntry } from "../../cache/antiRaid/verification";

declare const self: Worker;

/**
 * 入群验证状态机（packages/states/verification.ts）的核心解释器。
 *
 * 本模块只负责同步状态更替、timer、generation/revision 镜像与恢复；Telegram
 * 副作用、提醒投递、入站事件翻译分别位于 verificationEffects.ts、
 * verificationReminders.ts、verificationEvents.ts。异步结果都通过本模块的
 * dispatcher 回投，保持状态对象同一性和单一 revision 发布入口。
 */

/** pending 起验证超时计时，exempt/kicked 起去重窗口计时。 */
function startVerificationTimer(
  chatId: number,
  userId: number,
  state: VerificationState
): ReturnType<typeof setTimeout> | undefined {
  if (state.kind === "pending") {
    return setTimeout(
      (): void => dispatchVerification(
        chatId,
        userId,
        { type: "verifyTimeout", now: Date.now() }
      ),
      Math.max(0, state.expiresAt - Date.now())
    );
  }
  if (state.kind === "checkingInviter" || state.kind === "expelling") {
    return undefined;
  }
  return setTimeout(
    (): void => dispatchVerification(chatId, userId, { type: "dedupeExpired" }),
    LOCKDOWN_KICK_DEDUPE_MS
  );
}

type PersistedVerificationState = PendingState | VerificationTerminalState;

function isPersistedVerificationState(
  state: VerificationState | undefined
): state is PersistedVerificationState {
  return state?.kind === "pending" ||
    state?.kind === "checkingInviter" ||
    state?.kind === "expelling";
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
    publishVerificationChange(chatId, userId, previousWasPersisted);
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

interface VerificationSnapshotParams {
  chatId: number;
  userId: number;
  state: PersistedVerificationState;
  revision: number;
}

function verificationSnapshot({
  chatId,
  userId,
  state,
  revision,
}: VerificationSnapshotParams): VerificationSnapshot {
  const source: PendingState | ExpelSnapshot =
    state.kind === "pending" ? state : state.snapshot;
  return {
    chatId,
    userId,
    generation: verificationGeneration.current,
    revision,
    phase: state.kind,
    label: source.label,
    isBot: source.isBot,
    messageIds: [...source.messageIds],
    trackedMessageTimes:
      state.kind === "pending" ? [...state.trackedMessageTimes] : [],
    invitedBy: state.kind === "pending" ? state.invitedBy : undefined,
    reminderMessageId: source.reminderMessageId,
    replyReminderMessageId: source.replyReminderMessageId,
    replyReminderRequested:
      state.kind === "pending" ? state.replyReminderRequested : false,
    welcomeAnchorMessageId:
      state.kind === "pending" ? state.welcomeAnchorMessageId : undefined,
    reminderSuperseded:
      state.kind === "pending" ? state.reminderSuperseded : true,
    joinedAt: source.joinedAt,
    expiresAt: source.expiresAt,
    terminalInviterId:
      state.kind === "checkingInviter" ? state.inviterId : undefined,
    expelReason: state.kind === "expelling" ? state.reason : undefined,
    successNoticeSent:
      state.kind === "expelling" ? state.successNoticeSent : undefined,
  };
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
    threadCommentConfirmations.clear();
    clearReminderDeliveries();
    verificationGeneration.current = message.generation;
  }

  const now: number = Date.now();
  for (const record of message.verifications) {
    const key: string = verificationKey(record.chatId, record.userId);
    if ((verificationRevisions.get(key)?.revision ?? 0) >= record.revision) {
      continue;
    }
    verificationRevisions.set(key, { revision: record.revision });
    const expelSnapshot: ExpelSnapshot = {
      label: record.label,
      isBot: record.isBot,
      messageIds: [...record.messageIds],
      reminderMessageId: record.reminderMessageId,
      replyReminderMessageId: record.replyReminderMessageId,
      joinedAt: record.joinedAt,
      expiresAt: record.expiresAt,
    };
    const state: VerificationState = record.phase === "checkingInviter"
      ? {
        kind: "checkingInviter",
        inviterId: record.terminalInviterId!,
        snapshot: expelSnapshot,
      }
      : record.phase === "expelling"
        ? {
          kind: "expelling",
          reason: record.expelReason!,
          snapshot: expelSnapshot,
          successNoticeSent: record.successNoticeSent,
        }
        : {
          kind: "pending",
          label: record.label,
          isBot: record.isBot,
          messageIds: [...record.messageIds],
          trackedMessageTimes: record.trackedMessageTimes.filter(
            (timestamp: number): boolean => timestamp > now - JOIN_WINDOW_MS
          ),
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
      (state.kind === "checkingInviter" || state.kind === "expelling") &&
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
  const separator: number = message.key.lastIndexOf(":");
  if (separator <= 0) return;
  const chatId: number = Number(message.key.slice(0, separator));
  const userId: number = Number(message.key.slice(separator + 1));
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(userId)) return;
  const state: VerificationState | undefined =
    verificationEntries.get(message.key)?.state;
  if (state?.kind !== "checkingInviter" && state?.kind !== "expelling") return;
  dispatchVerification(
    chatId,
    userId,
    state.kind === "expelling" && state.successNoticeSent === true
      ? { type: "expelSettled" }
      : { type: "terminalPersisted" }
  );
}

/** 取消某群所有验证 owner，并为每条持久化记录发布 tombstone。 */
export function deactivateVerificationChat(chatId: number): void {
  const prefix: string = `${chatId}:`;
  for (const key of threadCommentConfirmations.keys()) {
    if (key.startsWith(prefix)) threadCommentConfirmations.delete(key);
  }
  for (const [key, entry] of [...verificationEntries]) {
    if (!key.startsWith(prefix)) continue;
    cancelReminderDelivery(key);
    const userId: number = Number(key.slice(prefix.length));
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    verificationEntries.delete(key);
    if (
      isPersistedVerificationState(entry.state) &&
      Number.isSafeInteger(userId)
    ) {
      publishVerificationChange(chatId, userId, true);
    }
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
