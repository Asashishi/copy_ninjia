import type { ChatPermissions } from "@grammyjs/types";

/**
 * 追踪一位尚未通过入群验证的新成员。仅存于 Worker 线程内存中
 * （见 src/workers/antiRaidWorker.ts）——不会在重启后保留。
 */
export interface PendingVerification {
  chatId: number;
  userId: number;
  /** 入群时捕获的展示用标签，用于踢人公告（提到 TA 的入群公告/提醒消息届时会被删除）。 */
  label: string;
  /** 验证窗口过期时要删除的消息 ID：入群公告、提醒消息、以及验证期间 TA 发的所有消息。 */
  messageIds: number[];
  /** 带验证按钮的提醒消息 ID，验证通过后要把这条消息删掉。 */
  reminderMessageId?: number;
  timeout: ReturnType<typeof setTimeout>;
  /**
   * 若为 true，说明这不是真正在等待验证的记录，而是反防刷群私密模式下
   * 直接踢人后留下的短期占位——用于给 chat_member 更新和 new_chat_members
   * 服务消息（针对同一次入群各自触发）去重，避免重复计数/重复踢人。
   */
  kicked?: boolean;
  /**
   * 若为 true，这是管理员/群主入群（只有 chat_member 更新携带身份）留下的
   * 豁免占位——管理员不需要验证，占位只用于给稍后可能到达的 new_chat_members
   * 服务消息去重，防止它重新开一个验证窗口。
   */
  exempt?: boolean;
}

/** 反刷群的入群滑动计数窗口（Worker 线程内存状态）。 */
export interface JoinWindow {
  /** 最近 JOIN_WINDOW_MS 内每次入群的毫秒时间戳（升序），每次记录时修剪过期项。 */
  timestamps: number[];
  /** 窗口静默满 JOIN_WINDOW_MS 后清理整个条目的计时器，每次入群重置。 */
  resetTimeout: ReturnType<typeof setTimeout>;
}

/** 一次生效中的反刷群私密模式（Worker 线程内存状态）。 */
export interface Lockdown {
  /**
   * 触发私密模式前的原始默认权限，用于到期后精确恢复——而不是简单把
   * can_invite_users 设回 true，避免覆盖管理员本来就设置的其他限制。
   */
  originalPermissions: ChatPermissions;
  restoreTimeout: ReturnType<typeof setTimeout>;
}

/** 主线程投递给入群守卫 Worker 的成员身份（生成展示标签所需的最小字段）。 */
export interface AntiRaidMember {
  id: number;
  username?: string;
  first_name?: string;
}

/** 主线程 -> Worker：一位（非机器人的）新成员加入了群聊。 */
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
}

/** 主线程 -> Worker：某成员离开了群聊（取消其待验证记录）。 */
export interface MemberLeftMessage {
  type: "left";
  chatId: number;
  userId: number;
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
  originalPermissions: ChatPermissions;
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

export type AntiRaidWorkerMessage =
  | NewMemberMessage
  | MemberLeftMessage
  | TrackedChatMessage
  | VerifyCallbackMessage
  | AdoptLockdownsMessage;

/** Worker -> 主线程：某群的私密模式已实际生效（setChatPermissions 成功）。 */
export interface LockdownEvent {
  type: "lockdown";
  chatId: number;
  originalPermissions: ChatPermissions;
}

/** Worker -> 主线程：某群的私密模式已解除（原始权限恢复成功）。 */
export interface UnlockEvent {
  type: "unlock";
  chatId: number;
}

export type AntiRaidWorkerEvent = LockdownEvent | UnlockEvent;
