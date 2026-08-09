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
   * 入群公告的消息 id（机器人自己制造的那条痕迹）。
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
  /** 入群公告 id；首次动作须在落盘回执后先清理该痕迹再踢人。 */
  announcementMessageId?: number;
  /** Worker 本地的 effect 幂等门；不持久化，重建后允许安全重放。 */
  effectStarted: boolean;
  /** Telegram 请求已同步发出，之后到达的豁免已无法撤销这次调用。 */
  executionStarted: boolean;
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
  readonly label: string;
  readonly isBot: boolean;
  /** 入群公告 id；只清理机器人/Telegram 制造的验证痕迹，不删除成员发言。 */
  readonly announcementMessageId?: number;
  readonly reminderMessageId?: number;
  readonly replyReminderMessageId?: number;
  readonly joinedAt: number;
  readonly expiresAt: number;
}

/** 已持久化后才可执行拉人者终核；Worker/进程重建会继续本阶段。 */
export interface CheckingInviterState {
  kind: "checkingInviter";
  inviterId: number;
  snapshot: ExpelSnapshot;
  /** Worker 本地幂等门；不持久化，Worker 重建后允许安全重放。 */
  executionStarted?: boolean;
}

/** 已持久化后才可执行验证痕迹清理/踢人；这些 API 均按幂等方式重放。 */
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
  /** 「没能确认成员是否仍在群里或群类型」告警已发送；理由同 failureNoticeSent。 */
  unconfirmedNoticeSent?: boolean;
  /**
   * 成功播报已经发出并进入持久化快照。落盘确认后可直接结束终态，Worker
   * 重建不再重放踢人、删消息和成功播报。
   */
  successNoticeSent?: boolean;
  /**
   * 踢人请求已被 Telegram 确认成功，但那条成功播报还没发出去。
   *
   * 随快照持久化，且**只在播报发送失败时才写**（正常一轮里踢人与播报同轮结算，
   * 不必多付一次落盘）。它存在的唯一理由是让下一轮认得出「人已经不在群里」的
   * 来路：没有它的话，重试时的成员探测只会答「不在群里」，终态直接静默结算，
   * 群里看着一个成员凭空消失，而那条唯一的说明再也不会出现。
   */
  removalConfirmed?: boolean;
  /**
   * 机器人自己的验证消息已经一条不剩地清理完毕。
   *
   * **Worker 本地幂等门，不持久化**（同 executionStarted）：重放一次删除是幂等
   * 的，重发一条播报不是，所以这条不必跟着快照走。它只用来给
   * verificationEffects/terminal.ts 里那道「确证没有封禁权限就不再发请求」的
   * 短路加一个前提——清理还欠着账时不能短路，否则一条删除失败过的验证公告会
   * 带着可点击的按钮永远挂在群里，再也没有任何一轮会重试它。
   */
  cleanupSettled?: boolean;
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
  /**
   * 本群的入群守卫被 `/antiraid disable` 关掉了（见 commands/antiRaid.ts）。
   *
   * 与 `left` 的区别是**谁走了**：`left` 是这个成员离开了群，验证自然作废；
   * 这条是功能本身被关掉，群里的人一个都没动，因此每一种状态都要就地收摊
   * ——包括已经落盘、正等着踢人的那两个终态。开关关掉之后还把人踢出去，是
   * 管理员最不可能预期的结果。
   */
  | { type: "guardDisabled" }
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
