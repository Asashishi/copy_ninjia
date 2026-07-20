import type { ChatPermissions } from "@grammyjs/types";
export type * from "./antiRaid/internal";

/** 主线程投递给入群守卫 Worker 的成员身份（生成展示标签所需的最小字段）。 */
export interface AntiRaidMember {
  id: number;
  username?: string;
  first_name?: string;
  /** 是不是机器人（本机器人自身不投递）。机器人入群走白名单用户代点验证的流程。 */
  isBot?: boolean;
}

/** 主线程 -> Worker：一位新成员（真人或机器人，但不含本机器人自身）加入了群聊。 */
export interface NewMemberMessage {
  type: "join";
  chatId: number;
  member: AntiRaidMember;
  /** 若本次由 new_chat_members 服务消息触发，该消息的 ID（用于之后删除）。 */
  announcementMessageId?: number;
  /**
   * 若为 true，该成员以管理员/群主身份入群（典型如群主退群重进；只有
   * chat_member 路径能看到身份），免验证、不计入刷群统计、私密模式下也不踢。
   */
  exempt?: boolean;
  /** 触发该入群事件的操作者 ID。 */
  actorId?: number;
}

/** 主线程 -> Worker：某成员离开了群聊（取消其待验证记录）。 */
export interface MemberLeftMessage {
  type: "left";
  chatId: number;
  userId: number;
}

/** 主线程 -> Worker：统一拆除某群的验证计时器，并恢复/保留 lockdown owner。 */
export interface DeactivateChatMessage {
  type: "deactivateChat";
  chatId: number;
}

/**
 * 主线程 -> Worker：一条普通群消息的（chatId, userId, messageId）三元组。
 * Worker 用它追踪待验证成员在等待期间发送的消息，验证超时被踢出时一并清理；
 * 与验证无关的（绝大多数）投递会在 Worker 侧的一次 Map 查找后被丢弃。
 */
export interface TrackedChatMessage {
  type: "message";
  chatId: number;
  userId: number;
  messageId: number;
  /**
   * 该消息是否直接回复了一条自动转发的频道帖（即在评论区对帖子本身留言）。
   * 这是确证的评论区活动——留言者是被这条留言自动拉进群的真人。
   */
  repliesToChannelPost?: boolean;
  /**
   * 该消息是否为线程内的回复（带 message_thread_id）。评论区的楼中楼回复
   * 都带；但 Bot API 无法按 ID 反查线程根，无法确证线程根就是频道帖，
   * 所以这个信号只用于「把验证提醒追发到 TA 的回复下」，不用于豁免。
   */
  isThreadReply?: boolean;
}

/** 主线程 -> Worker：入群验证按钮被点击（callback_query）。 */
export interface VerifyCallbackMessage {
  type: "callback";
  callbackQueryId: string;
  /** 按钮所在消息的聊天；极端情况下（消息太旧等）Telegram 可能不给，Worker 只应答不处理。 */
  chatId?: number;
  /** callback_data 里携带的待验证成员 userId。 */
  targetUserId: number;
  /** 实际点击按钮的用户。 */
  from: AntiRaidMember;
}

/** adopt 重放里的一条私密模式记录（见 AdoptLockdownsMessage）。 */
export interface AdoptableLockdown {
  chatId: number;
  phase: "applying" | "active" | "restoring";
  intentId: number;
  originalPermissions: ChatPermissions;
  /** false 表示仅存在主线程内存镜像，必须继续等待原 saveState 的落盘回执。 */
  persisted?: boolean;
  /**
   * 距离应当恢复原始权限还剩多久（ms，已按 Math.max(0, ...) 夹到不为负）
   * ——由主线程根据持久化的 LockdownRecord.expiresAt 与当前时刻算出，见
   * src/antiRaid.ts 的 collectActiveLockdowns。
   */
  remainingMs: number;
}

/**
 * 主线程 -> Worker：Worker 崩溃重启后，把主线程镜像里仍在生效的私密模式
 * 交给新 Worker 接管——权限限制已实际落在群上，必须重新排恢复计时，
 * 否则无人解锁。
 */
export interface AdoptLockdownsMessage {
  type: "adopt";
  lockdowns: AdoptableLockdown[];
}

/**
 * pending 验证的纯数据快照。主线程持有镜像、Disk I/O Worker 按日落盘；
 * 计时器、Promise 和 API 在途状态由业务 Worker 按 expiresAt 重建。
 */
export interface VerificationSnapshot {
  chatId: number;
  userId: number;
  /** 当前 Anti-Raid Worker 代际；主线程据此拒绝旧实例的迟到事件。 */
  generation: number;
  /** 同一代际、同一 key 内单调递增的状态修订号。 */
  revision: number;
  /** 缺失表示旧版 pending；终态必须在落盘确认后才能执行外部处置。 */
  phase?: "pending" | "checkingInviter" | "expelling";
  label: string;
  isBot: boolean;
  messageIds: number[];
  /** 最近一分钟的待验证成员消息时间戳；旧版当日记录缺失时按空窗口恢复。 */
  trackedMessageTimes?: number[];
  invitedBy?: number;
  reminderMessageId?: number;
  replyReminderMessageId?: number;
  replyReminderRequested: boolean;
  welcomeAnchorMessageId?: number;
  reminderSuperseded: boolean;
  joinedAt: number;
  expiresAt: number;
  /** checkingInviter 终态的最终核查对象。 */
  terminalInviterId?: number;
  /** expelling 终态的处置原因。 */
  expelReason?: "timeout" | "flood";
}

/** 主线程 -> Worker：Worker 重建时接管尚未结束的验证。 */
export interface AdoptVerificationsMessage {
  type: "adoptVerifications";
  generation: number;
  verifications: VerificationSnapshot[];
  /** 进程启动恢复来自磁盘，可直接续跑终态；Worker 内重建则重新等待落盘回执。 */
  resumePersistedTerminals?: boolean;
}

/** 主线程 -> Worker：某条验证 revision 已进入当天文件，可安全执行终态副作用。 */
export interface VerificationPersistedMessage {
  type: "verificationPersisted";
  key: string;
  generation: number;
  revision: number;
}

/**
 * 主线程 -> Worker：某成员的管理员身份发生了变化（任免、管理员入群/离群）。
 * 管理员任免本身就以 chat_member 更新送达，借此让 Worker 侧的管理员表缓存
 * 近乎实时，TTL 只是兜底。
 */
export interface AdminsChangedMessage {
  type: "adminsChanged";
  chatId: number;
  userId: number;
  /** 变化后的身份是否为管理员/群主。 */
  isAdmin: boolean;
}

/** 主线程完成 state.json 写入后，允许 Worker 执行对应权限副作用。 */
export interface LockdownPersistedMessage {
  type: "lockdownPersisted";
  chatId: number;
  phase: "applying" | "active" | "restoring";
  intentId: number;
}

export type AntiRaidWorkerMessage =
  | NewMemberMessage
  | MemberLeftMessage
  | DeactivateChatMessage
  | TrackedChatMessage
  | VerifyCallbackMessage
  | AdoptLockdownsMessage
  | AdoptVerificationsMessage
  | VerificationPersistedMessage
  | LockdownPersistedMessage
  | AdminsChangedMessage;

/** Worker -> 主线程：写入 applying/active/restoring 的持久化阶段。 */
export interface LockdownEvent {
  type: "lockdown";
  chatId: number;
  phase: "applying" | "active" | "restoring";
  intentId: number;
  originalPermissions: ChatPermissions;
  expiresAt: number;
}

/** Worker -> 主线程：某群的私密模式已解除（原始权限恢复成功）。 */
export interface UnlockEvent {
  type: "unlock";
  chatId: number;
}

/** Worker -> 主线程：新增或更新一条仍待验证的纯数据记录。 */
export interface VerificationUpsertEvent {
  type: "verificationUpsert";
  record: VerificationSnapshot;
}

/** Worker -> 主线程：验证已终结；主线程从内存镜像移除对应快照。 */
export interface VerificationDeleteEvent {
  type: "verificationDelete";
  chatId: number;
  userId: number;
  generation: number;
  revision: number;
}

export type AntiRaidWorkerEvent = LockdownEvent | UnlockEvent | VerificationUpsertEvent | VerificationDeleteEvent;
