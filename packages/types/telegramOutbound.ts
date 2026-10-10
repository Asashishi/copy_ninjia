import type { TimestampDeque } from "../libs/timestampDeque";

/**
 * Telegram 429 的独立退避域。同一域共享 Telegram 返回的 retry_after，不同域
 * 互不阻塞；message 类不走域级退避，由每聊天发送调度器（infra/telegram/sendScheduler.ts）
 * 主动控速并按聊天冻结。download 只承载 getFile 与 Telegram 文件服务的下载；
 * externalFetch 承载 Bot API 文件服务以外的抓取（默认头像直链、telegram.me 公开主页
 * 及其头像图），两者的 429 互不牵连。
 */
export type TelegramRetryCategory =
  | "message"
  | "inline"
  | "download"
  | "externalFetch"
  | "kick"
  | "query"
  | "restrict"
  | "delete"
  | "chatAction"
  | "reaction"
  | "callback"
  | "edit"
  | "profile"
  | "management"
  | "other";

/**
 * 一条被主线程接纳的 Telegram 请求。非发送类只有命中 429 或进入已冷却类别时才挂入
 * 类别的侵入式链表，正常请求直接执行；发送类一律进入所属聊天的发送 FIFO
 * （sendQueued），有额度时当即开始。同一时刻只在一条链表里，previous/next 复用。
 */
export interface TelegramOutboundJob {
  /** 调用方取消与当前出站生命周期组合后的信号；每次尝试都必须传到网络层。 */
  signal: AbortSignal;
  previous: TelegramOutboundJob | null;
  next: TelegramOutboundJob | null;
  /** 构造时分配的接纳序号，主线程内严格递增；429 FIFO 按它保持接纳顺序。 */
  readonly admissionSeq: number;
  category: TelegramRetryCategory;
  state: "created" | "active" | "retryQueued" | "sendQueued" | "settled";
  /**
   * 非发送类：本次尝试来自 429 FIFO，占用类别的恢复并发位。发送类：在聊天 FIFO 里
   * 等本聊天 429 冻结结束，计入 message 类的 pendingCount。
   */
  fromRetryQueue: boolean;
  /** 发送类所属的聊天车道；非发送类恒为 null。 */
  sendLane: TelegramSendLane | null;
  /** 发送类扣的额度条数（相册按张数、批量转发按条数）；非发送类恒为 0。 */
  sendCost: number;
  abortListener: (() => void) | undefined;
  /** 仅破坏性请求使用；每次从 429 队列重放前重新验证授权前置条件。 */
  beforeRetry: (() => Promise<void>) | undefined;
  call: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

/**
 * 一个 429 域的 FIFO 与恢复窗口。冷却结束先放行一个探测请求，成功后逐步扩大
 * 并发；再次 429 立即收回到一个。
 */
export interface TelegramRetryLane {
  head: TelegramOutboundJob | null;
  tail: TelegramOutboundJob | null;
  /** 该类别已开始、尚未结算的请求；message 类含发送调度器里已接纳、等额度的发送（infra/telegram/sendScheduler.ts）。 */
  activeCount: number;
  /** 该类别当前在 429 FIFO 中等待的请求数；message 类为真实 429 后在聊天 FIFO 里等待重发的发送。 */
  pendingCount: number;
  retryAt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  recoveryLimit: number;
  recoveryActive: number;
  recovering: boolean;
}

/** 发送调度器的聊天键：数字 chat_id 原样使用，`@username` 小写后作字符串键。 */
export type TelegramSendChatKey = number | string;

/**
 * 一个聊天的发送车道（infra/telegram/sendScheduler.ts）。同一聊天同时只有一条在途，其余按
 * 接纳顺序在侵入式 FIFO 里等单聊天令牌桶、群类窗口、全局窗口与 429 冻结。
 */
export interface TelegramSendLane {
  readonly key: TelegramSendChatKey;
  /** 负数 id 与 `@username`（群、超级群、频道）额外受群类窗口约束。 */
  readonly groupClass: boolean;
  head: TelegramOutboundJob | null;
  tail: TelegramOutboundJob | null;
  /** FIFO 中等待的任务数，不含在途那一条。 */
  queued: number;
  /** 已发出、网络尚未结算的那一条；调用方取消后仍占位到网络结算，保持同聊天串行。 */
  inFlight: TelegramOutboundJob | null;
  /** 单聊天令牌桶余量；单次超容量的请求放行后可为负（欠额顺延）。 */
  tokens: number;
  /** tokens 最近一次按时间补充的时刻（performance.now 毫秒）。 */
  tokensAt: number;
  /** 群类车道的发送窗口（TELEGRAM_SEND_GROUP_WINDOW_MS，按条数记时间戳）；私聊为 null。 */
  readonly minuteWindow: TimestampDeque | null;
  /** 本聊天 429 冻结截止；0 表示未冻结。 */
  frozenUntil: number;
  /** 保守档截止：429 冻结结束后的一段时间内突发容量降为 1；0 表示正常档。 */
  cautiousUntil: number;
  /** 最近一次发出请求的时刻；空闲车道据此在窗口全部恢复后删除。 */
  lastSendAt: number;
  /** 本车道唯一的定时器：下一次有额度、冻结结束或空闲删除。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 只差全局秒窗口额度时排在全局轮转队列里。 */
  inGlobalRing: boolean;
}

/** 等待 Telegram 出站请求和 429 队列完全排空的调用方。 */
export interface TelegramOutboundDrainWaiter {
  readonly resolve: (drained: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 出站 job 唯一构造点的稳定字段集合。 */
export interface CreateTelegramOutboundJobOptions {
  readonly signal: AbortSignal;
  readonly category: TelegramRetryCategory;
  readonly beforeRetry: (() => Promise<void>) | undefined;
  readonly call: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

/** 复用分类型 429 队列的一次外部请求。 */
export interface TelegramCategorizedRequestOptions<T> {
  readonly category: TelegramRetryCategory;
  readonly execute: (signal: AbortSignal) => Promise<T>;
  readonly signal?: AbortSignal;
}
