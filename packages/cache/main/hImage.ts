import { H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../consts/hImage";
import { TimestampDeque } from "../../libs/timestampDeque";

/** Owner: 主线程。`/h_image`（packages/commands/hImage.ts）的内存状态。 */

/**
 * `/h_image` 的全局滑动窗口频率限制：最近 H_IMAGE_RATE_LIMIT_WINDOW_MS（1 秒）内各次
 * 受理的时刻戳，按时间升序。每次判定时就地淘汰出窗的队首，且只在仍有配额时填入本次时刻
 * 并记账，因此长度恒不超过 H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW（5），无需额外的清理
 * 时机；环形缓冲按这个数定容，永远撑不满。纯进程内配额，不落盘也不镜像给 Worker：进程
 * 重启后从空窗口重新开始，重启本身已经中断了要限的那波流量。
 */
export const recentHImageCallTimestamps: TimestampDeque =
  new TimestampDeque(H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW);
