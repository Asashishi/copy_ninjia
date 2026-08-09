/**
 * Telegram 429 的独立退避域。同一域共享 Telegram 返回的 retry_after，不同域
 * 互不阻塞；message 仍会先经过 grammY throttler 的主动发送限流。
 */
export type TelegramRetryCategory =
  | "message"
  | "inline"
  | "download"
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
 * 一条被主线程接纳的 Telegram 请求。只有命中 429 或进入已冷却类别时才挂入
 * 侵入式链表；正常请求直接执行，不制造第二条常规等待队列。
 */
export interface TelegramOutboundJob {
  /** 调用方取消与当前出站生命周期组合后的信号；每次尝试都必须传到网络层。 */
  signal: AbortSignal;
  previous: TelegramOutboundJob | null;
  next: TelegramOutboundJob | null;
  category: TelegramRetryCategory;
  state: "created" | "active" | "retryQueued" | "settled";
  fromRetryQueue: boolean;
  abortListener: (() => void) | undefined;
  /** 仅破坏性请求使用；每次从 429 队列重放前重新验证授权前置条件。 */
  beforeRetry: (() => Promise<void>) | undefined;
  call: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

/**
 * 一个 429 域的 FIFO 与恢复窗口。冷却结束先放行一个探测请求，成功后逐步扩大
 * 并发；再次 429 会立即收回到一个，避免把整条积压同时打回 Telegram。
 */
export interface TelegramRetryLane {
  head: TelegramOutboundJob | null;
  tail: TelegramOutboundJob | null;
  /** 该类别已开始、尚未结算的请求；包含下游 grammY throttler 内部等待。 */
  activeCount: number;
  /** 该类别当前在 429 FIFO 中等待的请求数。 */
  pendingCount: number;
  retryAt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  recoveryLimit: number;
  recoveryActive: number;
  recovering: boolean;
}

/** 等待 Telegram 出站请求和 429 队列完全排空的调用方。 */
export interface TelegramOutboundDrainWaiter {
  readonly resolve: (drained: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
