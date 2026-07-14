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
  /**
   * 待验证的是不是一个机器人。机器人既看不到验证提醒也点不了按钮
   * （Bot API 不向机器人投递其他机器人的消息/按钮），验证只能由
   * PRIVILEGED_USERS_ID 白名单用户代为点击作保，提醒/超时文案也单独措辞。
   */
  isBot?: boolean;
  /** 验证窗口过期时要删除的消息 ID：入群公告、提醒消息、以及验证期间 TA 发的所有消息。 */
  messageIds: number[];
  /** 带验证按钮的提醒消息 ID，验证通过后要把这条消息删掉。 */
  reminderMessageId?: number;
  /**
   * 以「回复 TA 的消息」形式补发的验证提醒的消息 ID（楼中楼回复时追发到
   * 评论线程里让频道侧可见，群内正常发言时改锚到发言下戳中 TA），验证
   * 通过后同样要删掉。
   */
  replyReminderMessageId?: number;
  /** 是否已补发过回复式验证提醒——TA 连发多条消息也只补发一次。 */
  replyReminderRequested?: boolean;
  /**
   * 回复式提醒锚定的那条消息（TA 的评论/发言）的 ID。验证通过后的欢迎
   * 消息也回复它——楼中楼场景下欢迎消息因此落进评论线程，频道侧可见。
   */
  welcomeAnchorMessageId?: number;
  /**
   * 原始提醒（reminderMessageId）是否已被回复式提醒取代并删除：置位后，
   * 若原始提醒还在限流队列里没落地，落地时的回填回调会将其直接自删。
   */
  reminderSuperseded?: boolean;
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
  /**
   * 限制是否已实际落在群上（triggerLockdown 的 setChatPermissions 成功、
   * originalPermissions 已是取到的真实权限）。false 说明还是占位阶段——
   * 此时 originalPermissions 是空对象 {}，restoreChat 绝不能拿它去恢复：
   * setChatPermissions 会把省略的字段全部当 false，等于把全群禁言。
   */
  permissionsApplied: boolean;
}

/** 某群「是否有关联频道」的缓存条目（Worker 线程内存状态），用于评论区判定的按群开关。 */
export interface LinkedChannelCache {
  /** getChat 结果里是否带 linked_chat_id（即本群是不是频道的讨论群）。 */
  hasLinked: boolean;
  /** 拉取落地的时刻，超过 LINKED_CHANNEL_TTL_MS 视为过期，下次需要时重新拉取。 */
  fetchedAt: number;
}

/** 某群管理员表的缓存条目（Worker 线程内存状态），用于管理员拉人免验证的同步判定。 */
export interface ChatAdminCache {
  /** 群管理员 + 群主的用户 ID 集合，管理员任免事件（adminsChanged）到达时原地增删。 */
  adminIds: Set<number>;
  /** 全量拉取落地的时刻，超过 ADMIN_CACHE_TTL_MS 视为过期，下次需要时重新全量拉取。 */
  fetchedAt: number;
}

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

export type AntiRaidWorkerMessage =
  | NewMemberMessage
  | MemberLeftMessage
  | TrackedChatMessage
  | VerifyCallbackMessage
  | AdoptLockdownsMessage
  | AdminsChangedMessage;

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
