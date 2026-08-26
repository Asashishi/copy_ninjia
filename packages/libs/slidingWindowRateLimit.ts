import type { LinkedQueue } from "./linkedQueue";
import type { TimestampDeque } from "./timestampDeque";

/**
 * 全局滑动窗口限流的共用判定。本模块不持有任何状态：时间戳队列由调用方在
 * 对应的 `packages/cache/<domain>.ts` 里声明并传入，生命周期与容量语义也归
 * 那份缓存说明（见 AGENTS.md 的缓存约定）。超限立即拒绝、不排队——Telegram
 * 请求的排队与 429 退避由 infra/telegram/outboundGate.ts 处理，不要用这里。
 *
 * **窗口边界的唯一定义在 libs/timestampDeque.ts 的 `TimestampDeque.trim`**；
 * 本文件只提供它覆盖不到的两种形态，且必须与它逐字一致（对拍见
 * test/libs/slidingWindowBoundary.test.ts）：
 *
 * - `trimSlidingWindow`：给**没有硬顶**的窗口用。`TimestampDeque` 是定容环形
 *   缓冲，撑满即抛 RangeError，只能承载配额本身就封住长度的窗口；反刷群入群
 *   窗口的 `recordJoin` 是无条件记账的，刷群规模没有上界，因此只能用可无界
 *   增长的 `LinkedQueue`。它同时是唯一还需要按值精确撤销（`removeValue`）的
 *   窗口。
 * - `trimSlidingWindowArray`：给**要随持久化快照落盘**的窗口用。
 *
 * 其余窗口一律用 `TimestampDeque`：容量取该窗口自己的配额上限，逐次记账因此
 * 不分配链表节点。
 */

/** trimSlidingWindow 的入参。 */
export interface TrimSlidingWindowParams {
  /** 调用方持有的无硬顶时间戳队列，按时间升序，就地修改。 */
  timestamps: LinkedQueue<number>;
  /** 滑动窗口时长（ms）。 */
  windowMs: number;
  /** 当前时刻；默认取墙钟，测试可注入固定值。 */
  now?: number;
}

/**
 * 无硬顶窗口的修剪，边界语义与 `TimestampDeque.trim` 逐字一致：保留
 * `(now - windowMs, now]`，同时丢掉时钟回拨后落在未来的那些。
 *
 * 只有当前唯一一个没有配额上界的窗口用它——反刷群的入群滑动窗口
 * （workers/antiRaid/lockdownRuntime.ts 的 recordJoin/retractJoin）。理由见
 * 本文件头注：定容环形缓冲在刷群时会撑满抛错，而入群记账正是那一刻必须继续
 * 工作的东西；按值精确撤销也只有链表提供。新增窗口不要用它，先确认自己的
 * 配额上限，再用 `TimestampDeque`。
 */
export function trimSlidingWindow({
  timestamps,
  windowMs,
  now = Date.now(),
}: TrimSlidingWindowParams): void {
  if ((timestamps.peekLast() ?? now) > now) {
    // 队列单调升序，落在未来的必然是连续的一段队尾；整条重建最直观，且只在
    // 罕见的回拨路径上付这一次 O(n)。
    const kept: number[] = timestamps.last(timestamps.size).filter((at: number): boolean => at <= now);
    timestamps.clear();
    for (const at of kept) timestamps.push(at);
  }
  const cutoff: number = now - windowMs;
  while (timestamps.size > 0 && timestamps.peek()! <= cutoff) {
    timestamps.shift();
  }
}

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
 * 单独一个数组版本、而不是让调用方改用队列容器：入群验证那边的窗口挂在
 * **要随记录一起快照并落盘**的状态对象上（`trackedMessageTimes`），换成链表就得
 * 连持久化形状一起改。两个版本必须共用同一份边界定义——历史上这类窗口各处
 * 手写 `filter(ts > cutoff)`，漏掉的正是「未来」这一侧：NTP 往回跳一次，
 * 那些时间戳就永远满足 `ts > now - windowMs`、再也不会被驱逐，同一个
 * 45 条/分钟的阈值于是把一个根本没刷屏的人判成刷屏。
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
