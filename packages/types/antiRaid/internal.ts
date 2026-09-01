import type { ChatPermissions } from "grammy/types";
import type { LockdownPhase } from "../chatState";
import type { TimestampDeque } from "../../libs/timestampDeque";
import type { LockdownState } from "../states/lockdown";
import type {
  PendingState,
  VerificationEvent,
  VerificationState,
} from "../states/verification";

/** Worker 侧验证运行时各职责模块回投纯状态机事件的统一入口。 */
export type VerificationDispatcher = (
  chatId: number,
  userId: number,
  event: VerificationEvent
) => void;

/** 一次 lockdown 权限意图的稳定身份；供紧急恢复判断迟到结果是否仍属当前轮次。 */
export interface LockdownIntentFingerprint {
  phase: LockdownPhase;
  intentId: number;
}

/**
 * 主线程判断 lockdown 落盘回执是否覆盖当前恢复语义的指纹。
 *
 * announced 一轮最多从 false 变为 true 一次，且决定能否发送解锁公告，必须被
 * 落盘确认覆盖；expiresAt 不参与身份判定——APPLYING/RESTORING 阶段每次发布都
 * 按当刻墙钟填，同一份意图前后两次发布就会不相等，纳入指纹会让对账循环永远
 * 等不到「存下去的还是当前这份」。
 */
export interface PersistedLockdownFingerprint extends LockdownIntentFingerprint {
  announced: boolean;
}

/** Worker 永久不可用后，单群主线程权限恢复链的运行态。 */
export interface EmergencyLockdownRecovery {
  fingerprint: LockdownIntentFingerprint;
  originalPermissions: ChatPermissions;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
}

/** 一条私密模式状态机条目：纯状态 + 独立的到期与失败重试计时器。 */
export interface LockdownEntry {
  state: LockdownState;
  restoreTimer: ReturnType<typeof setTimeout> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** ACTIVE/RECONCILING 共用的绝对恢复截止时间；与 restoreTimer 同步更新。 */
  restoreAt: number | undefined;
}

/** 一条验证状态机条目：纯状态 + 解释器持有的活动计时器。 */
export interface VerificationEntry {
  state: VerificationState;
  timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 终态处置（踢人/删消息）连续失败次数；只调节本地重试节奏，不进入状态机
   * 或持久化快照。记录不能因重试耗尽被删除，否则等于把未处置成员当成完成；
   * 条目删除即消失，Worker 重建后从头计数。
   */
  terminalRetries?: number;
}

/** 反刷群 Worker 的入群滑动计数窗口。 */
export interface JoinWindow {
  /**
   * 窗口内最近的入群时刻，按时间升序；容量固定为 JOIN_WINDOW_CAPACITY。
   * 达到硬顶后覆盖最早一项，并由 overflowThrough 保留保守饱和语义。
   */
  timestamps: TimestampDeque;
  /**
   * 最近一个被硬顶覆盖的时间戳。它仍在窗口内时，即使后续异步撤销无法确认
   * 被覆盖项的身份，也按已经越过阈值处理；过期或墙钟回拨后恢复精确计数。
   */
  overflowThrough: number | undefined;
  /** 最近一次入群到达后，整个条目最早可以删除的墙钟时刻。 */
  expiresAt: number;
  /** 每群唯一的静默清理 timer；到点发现仍活跃时按 expiresAt 续排。 */
  resetTimeout: ReturnType<typeof setTimeout> | undefined;
}

/** 刷屏禁言 Worker 的单成员发言滑动窗口。 */
export interface FloodWindowEntry {
  /** 所属群与成员；LRU 尾部淘汰时用数值键 O(1) 删除分层索引。 */
  readonly chatId: number;
  readonly userId: number;
  /**
   * 窗口内的发言时刻，按时间升序。到期项在每次发言时就地修剪；达到阈值触发
   * 禁言后整条清空——清空既是去重（禁言落地前还在路上的那几条不会再触发一次
   * 判定），也是失败时的天然退避（这次没禁成就得再刷满一整个窗口才会重来）。
   * 因此队列长度恒不超过 FLOOD_MESSAGE_LIMIT。
   */
  timestamps: TimestampDeque;
  /** 上一次观测到的时刻；系统校时回拨时用它保持队列单调，也用于空闲清扫。 */
  lastObservedAt: number;
  /**
   * 在此之前到达的消息一律不计数（ms 绝对时刻，0 表示不抑制）。
   *
   * 判定命中的那一刻就地置位、不等禁言落地：mailbox handler 是同步的，一次
   * 爆发式刷屏可以在第一次网络往返回来之前就把下一个窗口填满，等结果再置位
   * 就是同一个人挨两次禁言、群里挨两条公告。落地之后它正好等于禁言结束时刻。
   *
   * 判定结论是确定性的那几种（禁言成功、目标是管理员、机器人没有限制成员
   * 权限）保留这次抑制——重判换不来新结果，只会重复打请求或重复刷同一行日志；
   * 瞬时失败（管理员身份没查出来、禁言请求本身失败）则回滚成 0，让下一个
   * 填满的窗口重试。
   */
  suppressedUntil: number;
  /** LRU 中比本条更新的条目；最新条目为 null。 */
  lruNewer: FloodWindowEntry | null;
  /** LRU 中比本条更旧的条目；最旧条目为 null。 */
  lruOlder: FloodWindowEntry | null;
}

/** 刷屏窗口缓存的全局容量与 LRU 两端，和分层索引同步更新。 */
export interface FloodWindowCacheState {
  /** 当前“群 + 成员”条目总数，不是群数。 */
  entryCount: number;
  /** 最近访问的条目。 */
  newest: FloodWindowEntry | null;
  /** 最久未访问的条目。 */
  oldest: FloodWindowEntry | null;
}

/** 某群是否有关联频道的 TTL 缓存条目。 */
export interface LinkedChannelCache {
  hasLinked: boolean;
  fetchedAt: number;
}

/** 某群可为邀请提供验证豁免的非匿名管理员 TTL 缓存条目。 */
export interface ChatAdminCache {
  adminIds: Set<number>;
  fetchedAt: number;
}

/** 评论先于入群事件到达时暂存的最近消息。 */
export interface RecentChannelComment {
  messageId: number;
  observedAt: number;
}

/** 冷缓存楼中楼消息等待关联频道确认时、每名成员唯一且可更新的在途 owner。 */
export interface ThreadCommentConfirmation {
  messageId: number;
  observedAt: number;
  expectedState: VerificationState | undefined;
  boundToJoin: boolean;
  /** 本 owner 覆盖的消息是否把同一 pending 同步推进到了 flood 终态。 */
  allowFloodTerminalExemption: boolean;
}

/** 验证提醒的发送形态。 */
export type ReminderKind = "original" | "reply";

/** 每名待验证成员唯一的提醒投递 owner。 */
export interface ReminderDelivery {
  key: string;
  chatId: number;
  userId: number;
  kind: ReminderKind;
  text: string;
  replyToMessageId: number | undefined;
  expectedState: PendingState;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  inFlight: boolean;
}
