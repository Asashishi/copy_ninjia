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
 * - `trimSlidingWindowArray`：给**要随持久化快照落盘、且调用方需要一份新数组**的窗口用。
 * - `trimSlidingWindowArrayInPlace`：同一判据的就地形态，给**已经独占该数组**的热调用点用。
 *   两者的谓词必须逐字相同，对拍见 test/libs/slidingWindowBoundary.test.ts。
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

/**
 * `trimSlidingWindowArray` 的就地形态：同一谓词、同一相对顺序，不新建数组。
 *
 * 判定必须与上面那个函数**逐字相同**——两者共用一份对拍用例
 * （test/libs/slidingWindowBoundary.test.ts），任何一边改了边界都会当场对不上。
 *
 * **不要**改写成 `TimestampDeque.trim` 那种「先裁未来尾段、再裁过期队首」的两段式：
 * 时钟回拨后数组不再单调，deque 只裁连续尾段，而这里的谓词会裁掉**任意位置**的
 * 未来项，两者对 `[100, 200, 50]`（now=60）就会给出不同结果。数组形态的权威判据
 * 就是这一条单趟压缩。
 *
 * 只给**独占该数组**的调用方用：入群验证的 `trackedMessageTimes` 由状态机原地持有，
 * 全部消费方都用 `[...]` 复制出去（controller / verificationMirror /
 * verificationSnapshot / verificationWrites / verificationCodec），没有第二处别名。
 * 需要一份新数组的冷路径（恢复与接管）继续用 `trimSlidingWindowArray`。
 *
 * **参数刻意用位置形式，不要改成 options interface**：相邻的
 * `trimSlidingWindowArray` 用 options 是因为它本来就要新建数组，多一个字面量无所谓；
 * 而本函数存在的唯一理由就是「每条待验证成员消息不再分配」。改成 options 会在同一条
 * 热路径上每次现造一个入参对象，收益当场归零。三个位置参数也在 AGENTS.md 的上限内。
 *
 * @param timestamps 就地修剪的时间戳数组；长度可能变短，元素相对顺序不变。
 */
export function trimSlidingWindowArrayInPlace(
  timestamps: number[],
  windowMs: number,
  now: number
): void {
  const cutoff: number = now - windowMs;
  // 写指针恒不超过读进度，因此回写只落在**已经读过**的槽位上，边读边写安全；
  // 长度收尾在循环之后一次改完，迭代期间不改变数组长度。
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
