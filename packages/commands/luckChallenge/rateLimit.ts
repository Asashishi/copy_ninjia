import {
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from "../../consts/luckChallenge";
import { recentCallTimestamps } from "../../cache/luckChallenge";

/** 全局滑动窗口；内联查询超限立即拒绝，不排队。 */
export function tryConsumeLuckRateLimit(now: number = Date.now()): boolean {
  // 系统时钟回拨后，队尾会落在“未来”，原队列也不再满足单调
  // 前提。整窗清空并以新时间轴重建，避免配额被长时间冻结。
  if (recentCallTimestamps.length > 0 && recentCallTimestamps.at(-1)! > now) {
    recentCallTimestamps.length = 0;
  }
  const cutoff: number = now - RATE_LIMIT_WINDOW_MS;
  while (recentCallTimestamps.length > 0 && recentCallTimestamps[0]! < cutoff) {
    recentCallTimestamps.shift();
  }
  if (recentCallTimestamps.length >= RATE_LIMIT_MAX_CALLS_PER_WINDOW) return false;
  recentCallTimestamps.push(now);
  return true;
}
