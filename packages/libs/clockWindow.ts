/**
 * 墙钟时间窗判定。两个判定都把「系统校时回拨」按窗口已结束处理：回拨后的 now 早于
 * 记录时刻、或截止时刻远于任何一档延迟时，不再等回拨量走完才过期。
 */

/** recordedAt 到 now 的经过时长是否落在 [0, maxAgeMs] 内。 */
export function isRecordedWithin(recordedAt: number, now: number, maxAgeMs: number): boolean {
  const age: number = now - recordedAt;
  return age >= 0 && age <= maxAgeMs;
}

/** deadlineAt 是否仍在 now 之后且距 now 不超过 maxDelayMs。 */
export function isPendingWithin(deadlineAt: number, now: number, maxDelayMs: number): boolean {
  const remaining: number = deadlineAt - now;
  return remaining > 0 && remaining <= maxDelayMs;
}
