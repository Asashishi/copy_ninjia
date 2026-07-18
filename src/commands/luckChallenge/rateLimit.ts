import {
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from "../../consts/luckChallenge";
import { recentCallTimestamps } from "../../cache/luckChallenge";

/** 全局滑动窗口；内联查询超限立即拒绝，不排队。 */
export function tryConsumeLuckRateLimit(now: number = Date.now()): boolean {
  const cutoff: number = now - RATE_LIMIT_WINDOW_MS;
  while (recentCallTimestamps.length > 0 && recentCallTimestamps[0]! < cutoff) {
    recentCallTimestamps.shift();
  }
  if (recentCallTimestamps.length >= RATE_LIMIT_MAX_CALLS_PER_WINDOW) return false;
  recentCallTimestamps.push(now);
  return true;
}
