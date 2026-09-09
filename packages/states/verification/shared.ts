import type {
  CheckingInviterState,
  ExpelSnapshot,
  ExpellingState,
  PendingState,
  VerificationEffect,
  VerificationTransition,
} from "../../types/states/verification";

/** 落盘快照里带过来的终态播报记账；新建终态时四项均为 undefined。 */
export interface PersistedExpelNotices {
  readonly failureNoticeSent?: boolean;
  readonly unconfirmedNoticeSent?: boolean;
  readonly successNoticeSent?: boolean;
  readonly removalConfirmed?: boolean;
}

/**
 * 建立 checkingInviter 终态。
 *
 * 全部字段在这里按声明顺序一次写齐，Worker 本地幂等门显式置 undefined：状态
 * 对象活到整个终态结算结束，期间 verificationSnapshot 与解释器要反复读它，
 * 各构造点少写一个字段就多出一个 hidden class（见 AGENTS.md「性能、内存与
 * Bun/JSC JIT」）。新建与 adopt 重建共用本函数，两条路产出同一个形状。
 */
export function checkingInviterOf(
  inviterId: number,
  snapshot: ExpelSnapshot
): CheckingInviterState {
  return {
    kind: "checkingInviter",
    inviterId,
    snapshot,
    executionStarted: undefined,
  };
}

/**
 * 建立 expelling 终态；构造顺序与形状约束同 checkingInviterOf。
 *
 * `executionStarted` 与 `cleanupSettled` 是 Worker 本地幂等门，不随快照持久化，
 * 因此重建时同样从 undefined 起；其余四项由 adopt 从落盘记账带回。
 */
export function expellingOf(
  reason: ExpellingState["reason"],
  snapshot: ExpelSnapshot,
  persisted?: PersistedExpelNotices
): ExpellingState {
  return {
    kind: "expelling",
    reason,
    snapshot,
    executionStarted: undefined,
    failureNoticeSent: persisted?.failureNoticeSent,
    unconfirmedNoticeSent: persisted?.unconfirmedNoticeSent,
    successNoticeSent: persisted?.successNoticeSent,
    removalConfirmed: persisted?.removalConfirmed,
    cleanupSettled: undefined,
  };
}

/** 把待验证记录冻结为终态处置所需的最小语义快照。 */
export function snapshotOf(state: PendingState): ExpelSnapshot {
  return {
    label: state.label,
    isBot: state.isBot,
    announcementMessageId: state.announcementMessageId,
    reminderMessageId: state.reminderMessageId,
    replyReminderMessageId: state.replyReminderMessageId,
    joinedAt: state.joinedAt,
    expiresAt: state.expiresAt,
  };
}

/** 生成清理当前两类验证提醒的副作用，不包含成员自己的消息。 */
export function remindersOf(
  source: Pick<PendingState, "reminderMessageId" | "replyReminderMessageId">
): VerificationEffect {
  return {
    kind: "deleteReminders",
    reminderMessageId: source.reminderMessageId,
    replyReminderMessageId: source.replyReminderMessageId,
  };
}

/**
 * 返回已原地修改的 pending 状态。同一对象引用是异步失效 token，不能为了
 * 表达持久化而复制对象；所有持久字段原地更新都经此处显式发布快照。
 */
export function pendingUpdated(
  state: PendingState,
  effects: VerificationEffect[],
  rescheduleTimer: boolean = false
): VerificationTransition {
  if (rescheduleTimer) {
    return {
      next: state,
      effects,
      snapshotChanged: true,
      rescheduleTimer: true,
    };
  }
  return { next: state, effects, snapshotChanged: true };
}
