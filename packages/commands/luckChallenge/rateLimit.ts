import {
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from "../../consts/luckChallenge";
import { recentCallTimestamps } from "../../cache/luckChallenge";
import { tryConsumeSlidingWindow } from "../../libs/slidingWindowRateLimit";

/** 全局滑动窗口；内联查询超限立即拒绝，不排队。窗口判定见 libs/slidingWindowRateLimit.ts。 */
export function tryConsumeLuckRateLimit(now: number = Date.now()): boolean {
  return tryConsumeSlidingWindow({
    timestamps: recentCallTimestamps,
    windowMs: RATE_LIMIT_WINDOW_MS,
    maxCalls: RATE_LIMIT_MAX_CALLS_PER_WINDOW,
    now,
  });
}
