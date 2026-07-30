/** 早于入群更新到达、被暂存下来的评论区留言。 */
export interface RecentComment {
  messageId: number;
}

/** 正在等待点击验证按钮的成员。 */
export interface PendingState {
  kind: "pending";
  label: string;
  isBot: boolean;
  /**
   * 超时踢出时要删除的提醒和等待期间发言。有上限
   * （VERIFICATION_TRACKED_MESSAGE_IDS_MAX），满了从最旧的开始丢。
   */
  messageIds: number[];
  /**
   * 入群公告的消息 id（机器人自己制造的那条痕迹）。
   *
   * 单独存而不混进 messageIds：它是最早入列的一条，混在一起时上限一满第一个
   * 被丢掉的就是它，而除了处置路径没有任何地方会再删它——提醒发不出去、记录
   * 被反复续期那条退化路径下，成员足以发够几百条把上限撑满，公告于是永远留在
   * 群里。单独存就与成员发言数彻底无关。
   */
  announcementMessageId?: number;
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

/** 私密模式踢人尚未发出或仍在途；状态替换会使未发出的动作失效。 */
export interface KickPendingState {
  kind: "kickPending";
  label: string;
  isBot: boolean;
  /** 用于区分同一次入群的双路投递与真正重新入群。 */
  requestedAt: number;
  /**
   * 本次入群计入刷群统计时用的那个时间戳；没计过数时为 undefined。
   *
   * 不能拿 requestedAt 顶替：只有 joinCreatesNewRecord 为真的那次入群才由
   * 调用方 recordJoin，而「踢完之后真的重新申请入群」那条路径状态已存在、
   * 不会再计一次数。撤销按值删队列里第一个相等的时间戳，同一 tick 内处理的
   * 多名入群成员时间戳完全相同，拿一个从未计数的值去撤，删掉的就是另一名
   * 合法计数成员那一格（见 packages/libs/linkedQueue.ts 的 removeValue）。
   */
  countedJoinAt?: number;
  /** Telegram 请求已同步发出，之后到达的豁免已无法撤销这次调用。 */
  executionStarted?: boolean;
}

/** 私密模式踢人请求已经结算后的短期去重占位。 */
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
  /** 入群公告 id；与 messageIds 分开的理由见 PendingState 同名字段。 */
  announcementMessageId?: number;
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
  /**
   * 「想踢却踢不动」（缺 can_restrict_members）这条告警已发送。
   *
   * 与 unconfirmedNoticeSent 分开记：两条文案指向完全不同的原因，共用一个名额
   * 时，先发出去的那条会把另一条永久顶掉——探测抖动先占了名额，之后每次重试
   * 都不再发那条唯一点名「去检查封禁权限」的诊断，人留在群里而管理员被引向
   * 网络问题。随快照持久化，Worker 重生/进程重启后不重发（这条告警不自删）。
   */
  failureNoticeSent?: boolean;
  /** 「没能确认人还在不在群里」这条告警已发送；理由同 failureNoticeSent。 */
  unconfirmedNoticeSent?: boolean;
  /**
   * 成功播报已经发出并进入持久化快照。落盘确认后可直接结束终态，Worker
   * 重建不再重放踢人、删消息和成功播报。
   */
  successNoticeSent?: boolean;
}

export type VerificationTerminalState = CheckingInviterState | ExpellingState;
export type VerificationState =
  | PendingState
  | ExemptState
  | KickPendingState
  | KickedState
  | VerificationTerminalState;

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

/** 冷缓存 getChat 回来后，对精确状态 token 投递的权威评论区确认。 */
export interface ConfirmedThreadCommentEvent {
  type: "confirmedThreadComment";
  messageId: number;
  now: number;
  /** 只允许撤回由本 owner 覆盖消息同步触发、且尚未开始执行的 flood 终态。 */
  allowFloodTerminalExemption: boolean;
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
  | ConfirmedThreadCommentEvent
  | VerificationCallbackEvent
  | { type: "adminCheckResolved" }
  | VerifyTimeoutEvent
  | { type: "terminalPersisted" }
  | TimeoutInviterVerdictEvent
  | { type: "expelSettled" }
  | { type: "kickRetry" }
  | { type: "kickSettled"; now: number }
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
  | { kind: "logUncancelableKickExemption"; label: string }
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
