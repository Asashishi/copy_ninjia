import { getCurrentTime } from "../../libs/time";
import type { CurrentTimeResult } from "../../types/time";

/** 本次联网检索的一份配置时区基准时间，供检索与组稿核对时效。 */
export function currentWebSearchTime(): string {
  const now: CurrentTimeResult = getCurrentTime();
  return `检索基准时间：${now.formatted}（${now.timezone}）。`;
}
