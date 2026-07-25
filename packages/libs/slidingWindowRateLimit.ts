import type { LinkedQueue } from "./linkedQueue";

/**
 * 全局滑动窗口限流的共用判定。本模块不持有任何状态：时间戳队列由调用方在
 * 对应的 `packages/cache/<domain>.ts` 里声明并传入，生命周期与容量语义也归
 * 那份缓存说明（见 AGENTS.md 的缓存约定）。超限立即拒绝、不排队——需要排队
 * 重试的场景用 infra/telegram/client.ts 的 apiThrottler，不要用这里。
 * 队列用 LinkedQueue 而非数组：修剪窗口靠的就是反复从队首出队，数组 shift()
 * 每次都要整体前移剩余元素（O(n)），链表出队是 O(1)，见 libs/linkedQueue.ts。
 */

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
  // 系统时钟回拨后，队尾会落在"未来"，原队列也不再满足单调
  // 前提。整窗清空并以新时间轴重建，避免配额被长时间冻结。
  // last(1) 走 tail 指针，是 LinkedQueue 特判过的 O(1) 路径。
  if ((timestamps.last(1)[0] ?? now) > now) {
    timestamps.clear();
  }
  const cutoff: number = now - windowMs;
  while (timestamps.size > 0 && timestamps.peek()! < cutoff) {
    timestamps.shift();
  }
  if (timestamps.size >= maxCalls) return false;
  timestamps.push(now);
  return true;
}
