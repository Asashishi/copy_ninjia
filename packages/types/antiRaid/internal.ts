import type { Api } from "grammy";
import type { LinkedQueue } from "../../libs/linkedQueue";
import type { TimestampDeque } from "../../libs/timestampDeque";
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

/**
 * 一条已发出、等着到点自删的群内公告。停机时按它把删除动作提前执行，
 * 见 cache/workers/antiRaid/notices.ts。
 */
export interface PendingNoticeDeletion {
  chatId: number;
  messageId: number;
  /** 用哪个客户端删；与发这条公告时用的那个保持一致（限流队列同一条）。 */
  api: Api;
  timer: ReturnType<typeof setTimeout>;
}

/** 反刷群 Worker 的入群滑动计数窗口。 */
export interface JoinWindow {
  timestamps: LinkedQueue<number>;
  resetTimeout: ReturnType<typeof setTimeout>;
}

/** 刷屏禁言 Worker 的单成员发言滑动窗口。 */
export interface FloodWindowEntry {
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
