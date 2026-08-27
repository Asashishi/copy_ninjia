import type { TimestampDeque } from "./timestampDeque";

/**
 * 全局滑动窗口限流的共用判定。本模块不持有任何状态：时间戳队列由调用方在
 * 对应的 `packages/cache/<domain>.ts` 里声明并传入，生命周期与容量语义也归
 * 那份缓存说明（见 AGENTS.md 的缓存约定）。超限立即拒绝、不排队——Telegram
 * 请求的排队与 429 退避由 infra/telegram/outboundGate.ts 处理，不要用这里。
 *
 * **窗口边界的唯一定义在 libs/timestampDeque.ts 的 `TimestampDeque.trim`**；
 * 本文件只提供持久化数组形态，且必须与它逐字一致（对拍见
 * test/libs/slidingWindowBoundary.test.ts）：
 *
 * - `trimSlidingWindowArray`：给**要随持久化快照落盘**的窗口用。
 *
 * 其余窗口一律用 `TimestampDeque`：容量取领域硬上限，逐次记账不分配节点。
 */

/** trimSlidingWindowArray 的入参。 */
export interface TrimSlidingWindowArrayParams {
  /** 按时间升序的时间戳数组；本函数不就地修改，返回修剪后的新数组。 */
  timestamps: readonly number[];
  /** 滑动窗口时长（ms）。 */
  windowMs: number;
  /** 当前时刻；默认取墙钟，测试可注入固定值。 */
  now?: number;
}

/**
 * 数组形态的窗口修剪，边界语义与 `TimestampDeque.trim` 逐字一致：保留
 * `(now - windowMs, now]`，同时丢掉时钟回拨后落在未来的那些。
 *
 * 入群验证窗口挂在要随记录一起快照并落盘的 `trackedMessageTimes` 上，因此保持
 * 数组形状。实现必须同时裁掉过期队首和时钟回拨后落在未来的队尾。
 */
export function trimSlidingWindowArray({
  timestamps,
  windowMs,
  now = Date.now(),
}: TrimSlidingWindowArrayParams): number[] {
  const cutoff: number = now - windowMs;
  return timestamps.filter((at: number): boolean => at > cutoff && at <= now);
}

/** tryConsumeSlidingWindow 的入参。 */
export interface TryConsumeSlidingWindowParams {
  /** 调用方持有的时间戳环形缓冲，按时间升序，就地修改；容量至少要有 maxCalls。 */
  timestamps: TimestampDeque;
  /** 滑动窗口时长（ms）。 */
  windowMs: number;
  /** 一个窗口内允许的最大次数。 */
  maxCalls: number;
  /** 当前时刻；默认取墙钟，测试可注入固定值。 */
  now?: number;
}

/**
 * 判定本次调用是否还在配额内：在配额内则把本次时刻记入队列并返回 true，
 * 已达上限则返回 false 且不记账（拒绝的调用不占用后续窗口的名额）。
 *
 * 只在 `size < maxCalls` 时 push，因此队列长度恒不超过 maxCalls——调用方按
 * 这个数构造 `TimestampDeque` 即可，环形缓冲永远撑不满。
 */
export function tryConsumeSlidingWindow({
  timestamps,
  windowMs,
  maxCalls,
  now = Date.now(),
}: TryConsumeSlidingWindowParams): boolean {
  timestamps.trim(windowMs, now);
  if (timestamps.size >= maxCalls) return false;
  timestamps.push(now);
  return true;
}
