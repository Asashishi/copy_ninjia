import type { ExpelSnapshot, VerificationState } from "./state";

/** 状态机只描述意图；antiRaid Worker 按顺序解释这些副作用。 */
export type VerificationEffect =
  | { kind: "deleteMessage"; messageId: number }
  | { kind: "kickMember" }
  | { kind: "sendReminder"; label: string; isBot: boolean }
  | { kind: "sendReplyReminder"; label: string; targetMessageId: number; inCommentThread: boolean }
  | { kind: "sendWelcome"; variant: "verified" | "vouchedBot" | "channelComment"; targetLabel: string; fromLabel?: string; anchorMessageId?: number }
  | { kind: "answerCallback"; callbackQueryId: string; reply: "ok" | "invalid" | "notYourButton" | "notYourBotButton" }
  | { kind: "deleteReminders"; reminderMessageId?: number; replyReminderMessageId?: number }
  | { kind: "startAdminCheck"; actorId: number }
  | { kind: "logStaleKickedExemption"; label: string }
  | { kind: "retractJoinCount"; joinedAt: number }
  | { kind: "recheckInviter"; inviterId: number; snapshot: ExpelSnapshot }
  | { kind: "expel"; snapshot: ExpelSnapshot }
  | { kind: "expelFlood"; snapshot: ExpelSnapshot }
  | { kind: "restartVerifyTimer" };

export interface VerificationTransition {
  /** undefined = 删除；同一引用 = 原地更新。 */
  next: VerificationState | undefined;
  effects: VerificationEffect[];
  /** 仅原地修改 pending 时置 true。 */
  snapshotChanged?: boolean;
}
