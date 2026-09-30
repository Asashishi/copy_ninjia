import { TimestampDeque } from "./timestampDeque";
import { tryConsumeSlidingWindow } from "./slidingWindowRateLimit";

/**
 * Worker 崩溃自愈的重启节流器：记录最近的重启时间戳，滑动窗口内超过上限
 * 就放弃自愈（调用方据此停止重建 Worker，只保留兜底降级行为）。
 *
 * 判定复用 libs/slidingWindowRateLimit.ts：系统时钟回拨后只丢落在未来的那段队尾、
 * 保留仍然合法的历史记录，因此回拨不会让 `shouldGiveUp()` 误判为真。
 *
 * @param maxRestarts 窗口内允许的重启次数，必须为正整数——它同时是时间戳环形
 *   缓冲的容量，非正值在构造时即拒绝（见 libs/dequeCapacity.ts）。
 */
export function createRestartThrottle(maxRestarts: number, windowMs: number): { shouldGiveUp: () => boolean } {
  // 只在仍有配额时记账，长度恒不超过 maxRestarts；环形缓冲按这个数定容。
  const timestamps: TimestampDeque = new TimestampDeque(maxRestarts);
  return {
    // 语义与 tryConsumeSlidingWindow 恰好互为反面：还在配额内就记一次本次重启并继续自愈，
    // 配额已满则不记账（被拒的这次不占后续窗口名额）并放弃。
    shouldGiveUp: (): boolean => !tryConsumeSlidingWindow({ timestamps, windowMs, maxCalls: maxRestarts }),
  };
}
