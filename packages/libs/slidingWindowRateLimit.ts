import type { TimestampDeque } from "./timestampDeque";

/**
 * 全局滑动窗口限流的共用判定。本模块不持有任何状态：时间戳队列由调用方在
 * 对应的 `packages/cache/<domain>.ts` 里声明并传入，生命周期与容量语义归
 * 那份缓存说明（见 AGENTS.md 的缓存约定）。超限立即拒绝、不排队；Telegram
 * 请求的排队与 429 退避由 infra/telegram/outboundGate.ts 处理。
 *
 * 窗口边界的唯一定义在 libs/timestampDeque.ts 的 `TimestampDeque.trim`；
 * 本文件只提供持久化数组形态，且与它逐字一致（对拍见
 * test/libs/slidingWindowBoundary.test.ts）：
 *
 * - `trimSlidingWindowArray`：用于随持久化快照落盘、且调用方需要一份新数组的窗口。
 * - `trimSlidingWindowArrayInPlace`：同一判据的就地形态，用于已经独占该数组的热调用点。
 *   两者的谓词逐字相同。
 *
 * 其余窗口使用 `TimestampDeque`：容量取领域硬上限，逐次记账不分配节点。
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
 * 入群验证窗口挂在随记录一起快照并落盘的 `trackedMessageTimes` 上，保持数组形状；
 * 同时裁掉过期队首和时钟回拨后落在未来的队尾。
 */
export function trimSlidingWindowArray({
  timestamps,
  windowMs,
  now = Date.now(),
}: TrimSlidingWindowArrayParams): number[] {
  const cutoff: number = now - windowMs;
  return timestamps.filter((at: number): boolean => at > cutoff && at <= now);
}

/**
 * `trimSlidingWindowArray` 的就地形态：同一谓词、同一相对顺序，不新建数组。
 *
 * 判定与上面那个函数逐字相同，两者共用一份对拍用例
 * （test/libs/slidingWindowBoundary.test.ts）。
 *
 * 判据是单趟压缩，不是 `TimestampDeque.trim` 那种「先裁未来尾段、再裁过期队首」的
 * 两段式：时钟回拨后数组不再单调，deque 只裁连续尾段，这里的谓词裁掉任意位置的
 * 未来项，两者对 `[100, 200, 50]`（now=60）给出不同结果。
 *
 * 只给独占该数组的调用方用：入群验证的 `trackedMessageTimes` 由状态机原地持有，
 * 全部消费方都用 `[...]` 复制出去（antiRaid/verificationMirror.ts /
 * workers/antiRaid/verificationSnapshot.ts / workers/diskIO/verificationWrites.ts /
 * workers/diskIO/verificationCodec.ts），没有第二处别名。
 * 需要一份新数组的冷路径（恢复与接管）使用 `trimSlidingWindowArray`。
 *
 * 参数用位置形式（三个，在 AGENTS.md 的位置参数上限内），不分配入参对象。
 *
 * @param timestamps 就地修剪的时间戳数组；长度可能变短，元素相对顺序不变。
 */
export function trimSlidingWindowArrayInPlace(
  timestamps: number[],
  windowMs: number,
  now: number
): void {
  const cutoff: number = now - windowMs;
  // 写指针不超过读进度，回写只落在已读过的槽位；长度在循环之后一次改完。
  let write: number = 0;
  for (const at of timestamps) {
    if (at > cutoff && at <= now) {
      timestamps[write] = at;
      write += 1;
    }
  }
  if (write !== timestamps.length) timestamps.length = write;
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
 * 只在 `size < maxCalls` 时 push，队列长度恒不超过 maxCalls，调用方按
 * 这个数构造 `TimestampDeque`。
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
