/** 验证持久化快照的各 phase 共享字段。 */
export interface VerificationSnapshotBase {
  chatId: number;
  userId: number;
  /** 当前 Anti-Raid Worker 代际；主线程据此拒绝旧实例的迟到事件。 */
  generation: number;
  /** 同一代际、同一 key 内单调递增的状态修订号。 */
  revision: number;
  label: string;
  isBot: boolean;
  /** 入群公告 id；只清理机器人/Telegram 制造的验证痕迹，不删除成员发言。 */
  announcementMessageId?: number;
  /** 最近一分钟的待验证成员消息时间戳。 */
  trackedMessageTimes: number[];
  invitedBy?: number;
  reminderMessageId?: number;
  replyReminderMessageId?: number;
  replyReminderRequested: boolean;
  welcomeAnchorMessageId?: number;
  reminderSuperseded: boolean;
  joinedAt: number;
  expiresAt: number;
}

/** 正在等待按钮或超时的可恢复验证快照。 */
export interface PendingVerificationSnapshot extends VerificationSnapshotBase {
  phase: "pending";
  requestedAt?: never;
  countedJoinAt?: never;
  terminalInviterId?: never;
  expelReason?: never;
  successNoticeSent?: never;
  failureNoticeSent?: never;
  unconfirmedNoticeSent?: never;
  removalConfirmed?: never;
}

/** 私密模式即时踢人尚未结算的可恢复快照。 */
export interface KickPendingVerificationSnapshot
  extends VerificationSnapshotBase {
  phase: "kickPending";
  /** 该次物理入群的动作代际时间戳。 */
  requestedAt: number;
  /** 仅在该次入群实际计入刷群窗口时存在。 */
  countedJoinAt?: number;
  terminalInviterId?: never;
  expelReason?: never;
  successNoticeSent?: never;
  failureNoticeSent?: never;
  unconfirmedNoticeSent?: never;
  removalConfirmed?: never;
}

/** 已落盘后等待拉人者最终核查的可恢复终态。 */
export interface CheckingInviterVerificationSnapshot
  extends VerificationSnapshotBase {
  phase: "checkingInviter";
  requestedAt?: never;
  countedJoinAt?: never;
  /** checkingInviter 终态的最终核查对象。 */
  terminalInviterId: number;
  expelReason?: never;
  successNoticeSent?: never;
  failureNoticeSent?: never;
  unconfirmedNoticeSent?: never;
  removalConfirmed?: never;
}

/** 已落盘后等待踢人/清理结算的可恢复终态。 */
export interface ExpellingVerificationSnapshot
  extends VerificationSnapshotBase {
  phase: "expelling";
  requestedAt?: never;
  countedJoinAt?: never;
  terminalInviterId?: never;
  /** expelling 终态的处置原因。 */
  expelReason: "timeout" | "flood";
  /** 成功处置播报已发送；仅 expelling 终态可携带。 */
  successNoticeSent?: boolean;
  /** 「踢不动」告警已发送；仅 expelling 终态可携带（见 ExpellingState）。 */
  failureNoticeSent?: boolean;
  /** 「没能确认成员是否仍在群里或群类型」告警已发送；仅 expelling 终态可携带。 */
  unconfirmedNoticeSent?: boolean;
  /** 踢人已确认成功、成功播报还欠着；仅 expelling 终态可携带（见 ExpellingState）。 */
  removalConfirmed?: boolean;
}

/**
 * pending 验证的纯数据快照。主线程持有镜像、Disk I/O Worker 按日落盘；
 * 计时器、Promise 和 API 在途状态由业务 Worker 按 expiresAt 重建。phase
 * 同时约束每类终态的必填/禁用字段，非法恢复组合不能在类型层构造。
 */
export type VerificationSnapshot =
  | PendingVerificationSnapshot
  | KickPendingVerificationSnapshot
  | CheckingInviterVerificationSnapshot
  | ExpellingVerificationSnapshot;

/** 本进程已耗尽终态执行预算、但仍保留在磁盘中的验证最小索引。 */
export interface DeferredVerificationRecord {
  chatId: number;
  userId: number;
  /** 当前 Anti-Raid Worker 代际；主线程据此拒绝旧实例的迟到事件。 */
  generation: number;
  /** 延后时最后一份已持久化快照的 revision。 */
  revision: number;
}
