import type { RecentComment } from "./state";

export interface JoinEvent {
  type: "join";
  memberId: number;
  label: string;
  isBot: boolean;
  announcementMessageId?: number;
  /** undefined 或 memberId 表示自主入群，否则是拉人者。 */
  actorId?: number;
  identityExempt: boolean;
  actorSyncExempt: boolean;
  /** 管理员缓存是否未过期；决定是否还需异步核查。 */
  adminCacheFresh: boolean;
  /** 必须在 recordJoin 可能触发锁定之后读取。 */
  lockdownActive: boolean;
  recentComment?: RecentComment;
  now: number;
}

export type VerificationEvent =
  | JoinEvent
  | { type: "left" }
  | { type: "trackedMessage"; messageId: number; inCommentThread: boolean; now: number }
  | { type: "callback"; callbackQueryId: string; isSelf: boolean; fromIsPrivileged: boolean; fromLabel: string }
  | { type: "adminCheckResolved" }
  | { type: "verifyTimeout" }
  | { type: "terminalPersisted" }
  | { type: "timeoutInviterVerdict"; inviterIsAdmin: boolean }
  | { type: "expelSettled" }
  | { type: "reminderLanded"; reminderKind: "original" | "reply"; messageId: number }
  | { type: "dedupeExpired" };
