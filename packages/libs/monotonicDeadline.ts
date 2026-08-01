/** 可注入的单调时钟；只用于进程内耗时预算，不用于持久化时间戳。 */
export type MonotonicClock = () => number;

/** 读取不受系统校时影响的进程内单调时间。 */
export function monotonicNow(): number {
  return performance.now();
}

/**
 * 从当前单调时间创建绝对截止点。负预算与零预算都立即到期，避免调用方
 * 各自实现略有差异的边界处理。
 */
export function createMonotonicDeadline(
  timeoutMs: number,
  clock: MonotonicClock = monotonicNow
): number {
  return clock() + Math.max(0, timeoutMs);
}

/** 返回截止点的剩余整毫秒预算；到期后稳定保持为零。 */
export function remainingMonotonicTime(
  deadline: number,
  clock: MonotonicClock = monotonicNow
): number {
  return Math.max(0, deadline - clock());
}

/** 判断单调截止点是否已经到期。 */
export function isMonotonicDeadlineExpired(
  deadline: number,
  clock: MonotonicClock = monotonicNow
): boolean {
  return remainingMonotonicTime(deadline, clock) === 0;
}
