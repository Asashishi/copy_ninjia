import type {
  ExpelSnapshot,
  PendingState,
  VerificationEffect,
  VerificationTransition,
} from "../../types/states/verification";

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
