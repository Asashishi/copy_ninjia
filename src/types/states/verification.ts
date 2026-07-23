/** 早于入群更新到达、被暂存下来的评论区留言。 */
export interface RecentComment {
  messageId: number;
}

/** 正在等待点击验证按钮的成员。 */
export interface PendingState {
  kind: "pending";
  label: string;
  isBot: boolean;
  /** 超时踢出时要删除的入群公告、提醒和等待期间发言。 */
  messageIds: number[];
  /** 最近 JOIN_WINDOW_MS 内由该成员发送的消息时间。 */
  trackedMessageTimes: number[];
  /** 被他人拉入群时的拉人者 ID；超时前要做最终管理员核查。 */
  invitedBy?: number;
  reminderMessageId?: number;
  replyReminderMessageId?: number;
  replyReminderRequested: boolean;
  welcomeAnchorMessageId?: number;
  reminderSuperseded: boolean;
  /** 创建记录的入群时刻，也是刷群窗口中待精确撤销的时间戳。 */
  joinedAt: number;
  /** 验证结束的绝对毫秒时刻；恢复时据此重建剩余时间。 */
  expiresAt: number;
}

/** 已豁免的短期去重占位。 */
export interface ExemptState {
  kind: "exempt";
  label: string;
  isBot: boolean;
}

/** 已秒踢的短期去重占位。 */
export interface KickedState {
  kind: "kicked";
  label: string;
  isBot: boolean;
  /** 用于区分同一次入群的双路投递与真正重新入群。 */
  kickedAt: number;
}

/** 供终核与最终清理使用的不可变语义快照。 */
export interface ExpelSnapshot {
  label: string;
  isBot: boolean;
  messageIds: number[];
  reminderMessageId?: number;
  replyReminderMessageId?: number;
  joinedAt: number;
  expiresAt: number;
}

/** 已持久化后才可执行拉人者终核；Worker/进程重建会继续本阶段。 */
export interface CheckingInviterState {
  kind: "checkingInviter";
  inviterId: number;
  snapshot: ExpelSnapshot;
  /** Worker 本地幂等门；不持久化，Worker 重建后允许安全重放。 */
  executionStarted?: boolean;
}

/** 已持久化后才可执行删消息/踢人；这些 API 均按幂等方式重放。 */
export interface ExpellingState {
  kind: "expelling";
  reason: "timeout" | "flood";
  snapshot: ExpelSnapshot;
  /** Worker 本地幂等门；不持久化，Worker 重建后允许安全重放。 */
  executionStarted?: boolean;
  /** 避免同一 Worker 内每次失败重试都重复发送管理员告警。 */
  failureNoticeSent?: boolean;
  /**
   * 成功播报已经发出并进入持久化快照。落盘确认后可直接结束终态，Worker
   * 重建不再重放踢人、删消息和成功播报。
   */
  successNoticeSent?: boolean;
}

export type VerificationTerminalState = CheckingInviterState | ExpellingState;
export type VerificationState = PendingState | ExemptState | KickedState | VerificationTerminalState;

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

export interface TrackedMessageEvent {
  type: "trackedMessage";
  messageId: number;
  inCommentThread: boolean;
  now: number;
}

export interface VerificationCallbackEvent {
  type: "callback";
  callbackQueryId: string;
  isSelf: boolean;
  fromIsPrivileged: boolean;
  fromLabel: string;
}

export interface VerifyTimeoutEvent {
  type: "verifyTimeout";
  now: number;
}

export interface TimeoutInviterVerdictEvent {
  type: "timeoutInviterVerdict";
  inviterIsAdmin: boolean;
}

export interface ReminderLandedEvent {
  type: "reminderLanded";
  reminderKind: "original" | "reply";
  messageId: number;
  now: number;
}

export type VerificationEvent =
  | JoinEvent
  | { type: "left" }
  | TrackedMessageEvent
  | VerificationCallbackEvent
  | { type: "adminCheckResolved" }
  | VerifyTimeoutEvent
  | { type: "terminalPersisted" }
  | TimeoutInviterVerdictEvent
  | { type: "expelSettled" }
  | ReminderLandedEvent
  | { type: "dedupeExpired" };

/** 状态机只描述意图；antiRaid Worker 按顺序解释这些副作用。 */
export type VerificationEffect =
  | { kind: "deleteMessage"; messageId: number }
  | { kind: "kickMember" }
  | { kind: "sendReminder"; label: string; isBot: boolean }
  | { kind: "sendReplyReminder"; label: string; targetMessageId: number }
  | { kind: "sendWelcome"; variant: "verified" | "vouchedBot" | "channelComment"; targetLabel: string; fromLabel?: string; anchorMessageId?: number }
  | { kind: "answerCallback"; callbackQueryId: string; reply: "ok" | "invalid" | "notYourButton" | "notYourBotButton" }
  | { kind: "deleteReminders"; reminderMessageId?: number; replyReminderMessageId?: number }
  | { kind: "startAdminCheck"; actorId: number }
  | { kind: "logStaleKickedExemption"; label: string }
  | { kind: "retractJoinCount"; joinedAt: number }
  | { kind: "recheckInviter"; inviterId: number; snapshot: ExpelSnapshot }
  | { kind: "expel"; snapshot: ExpelSnapshot }
  | { kind: "expelFlood"; snapshot: ExpelSnapshot };

export interface VerificationTransition {
  /** undefined = 删除；同一引用 = 原地更新。 */
  next: VerificationState | undefined;
  effects: VerificationEffect[];
  /** 仅原地修改 pending 时置 true。 */
  snapshotChanged?: boolean;
  /** expiresAt 原地变化时通知解释器重建验证 timer。 */
  rescheduleTimer?: boolean;
}
