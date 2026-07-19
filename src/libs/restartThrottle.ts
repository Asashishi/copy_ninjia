/**
 * Worker 崩溃自愈的重启节流器：记录最近的重启时间戳，滑动窗口内超过上限
 * 就放弃自愈（调用方据此停止重建 Worker，只保留兜底降级行为）。
 */
export function createRestartThrottle(maxRestarts: number, windowMs: number): { shouldGiveUp: () => boolean } {
  let timestamps: number[] = [];
  return {
    shouldGiveUp: (): boolean => {
      const now: number = Date.now();
      timestamps = timestamps.filter((t) => now - t < windowMs);
      if (timestamps.length >= maxRestarts) return true;
      timestamps.push(now);
      return false;
    },
  };
}
