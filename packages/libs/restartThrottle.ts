import { LinkedQueue } from "./linkedQueue";
import { tryConsumeSlidingWindow } from "./slidingWindowRateLimit";

/**
 * Worker 崩溃自愈的重启节流器：记录最近的重启时间戳，滑动窗口内超过上限
 * 就放弃自愈（调用方据此停止重建 Worker，只保留兜底降级行为）。
 *
 * 判定复用 libs/slidingWindowRateLimit.ts，不自己写窗口修剪：手写的
 * `now - t < windowMs` 在系统时钟回拨后差值为负、恒小于窗口长度，于是一条
 * 过期记录都修剪不掉——下一次崩溃会和一堆早该出局的时间戳一起计数，
 * `shouldGiveUp()` 立刻为真，Worker 被永久判死（业务 Worker 则连带停掉
 * runner）。共用实现只丢落在未来的那段队尾，保留仍然合法的历史记录。
 */
export function createRestartThrottle(maxRestarts: number, windowMs: number): { shouldGiveUp: () => boolean } {
  const timestamps: LinkedQueue<number> = new LinkedQueue();
  return {
    // 语义与 tryConsume 恰好互为反面：还在配额内就记一次本次重启并继续自愈，
    // 配额已满则不记账（被拒的这次不占后续窗口名额）并放弃。
    shouldGiveUp: (): boolean => !tryConsumeSlidingWindow({ timestamps, windowMs, maxCalls: maxRestarts }),
  };
}
