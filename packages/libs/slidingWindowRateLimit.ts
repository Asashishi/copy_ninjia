import type { LinkedQueue } from "./linkedQueue";

/**
 * 全局滑动窗口限流的共用判定。本模块不持有任何状态：时间戳队列由调用方在
 * 对应的 `packages/cache/<domain>.ts` 里声明并传入，生命周期与容量语义也归
 * 那份缓存说明（见 AGENTS.md 的缓存约定）。超限立即拒绝、不排队——需要排队
 * 重试的场景用 infra/telegram/client.ts 的 apiThrottler，不要用这里。
 * 队列用 LinkedQueue 而非数组：修剪窗口靠的就是反复从队首出队，数组 shift()
 * 每次都要整体前移剩余元素（O(n)），链表出队是 O(1)，见 libs/linkedQueue.ts。
 */

/** trimSlidingWindow 的入参。 */
export interface TrimSlidingWindowParams {
  /** 调用方持有的时间戳队列，按时间升序，就地修改。 */
  timestamps: LinkedQueue<number>;
  /** 滑动窗口时长（ms）。 */
  windowMs: number;
  /** 当前时刻；默认取墙钟，测试可注入固定值。 */
  now?: number;
}

/**
 * 把窗口修剪到半开区间 `(now - windowMs, now]`。全仓所有滑动窗口共用这一个
 * 边界定义，不要各自手写 `while (peek() < cutoff) shift()`——历史上各处
 * 对边界的写法（`<` / `<=` / `>=`）并不一致，同样的窗口长度会因为读的是哪份
 * 副本而差出一个刻度。
 *
 * 两件事：
 * 1. 丢掉已滑出窗口的队首（`ts <= now - windowMs`）；
 * 2. 系统时钟回拨后队尾会落在「未来」，**只丢这些越界项**，保留仍然合法的
 *    历史记录。绝不能整窗清空：那等于把配额清零重来，往回拨 1 毫秒就能凭空
 *    换到一整个新窗口，限流形同虚设。
 */
export function trimSlidingWindow({
  timestamps,
  windowMs,
  now = Date.now(),
}: TrimSlidingWindowParams): void {
  // last(1) 走 tail 指针，是 LinkedQueue 特判过的 O(1) 路径。
  if ((timestamps.last(1)[0] ?? now) > now) {
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
 * 数组形态的窗口修剪，边界语义与 trimSlidingWindow 逐字一致：保留
 * `(now - windowMs, now]`，同时丢掉时钟回拨后落在未来的那些。
 *
 * 单独一个数组版本、而不是让调用方改用 LinkedQueue：入群验证那边的窗口挂在
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
  /** 调用方持有的时间戳队列，按时间升序，就地修改。 */
  timestamps: LinkedQueue<number>;
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
 */
export function tryConsumeSlidingWindow({
  timestamps,
  windowMs,
  maxCalls,
  now = Date.now(),
}: TryConsumeSlidingWindowParams): boolean {
  trimSlidingWindow({ timestamps, windowMs, now });
  if (timestamps.size >= maxCalls) return false;
  timestamps.push(now);
  return true;
}
