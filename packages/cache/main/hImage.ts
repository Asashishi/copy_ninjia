/** owner: main。`/h_image`（packages/commands/hImage.ts）的内存状态。 */

import { H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW } from "../../consts/hImage";
import { TimestampDeque } from "../../libs/timestampDeque";

/**
 * `/h_image` 的全局滑动窗口频率限制：最近 H_IMAGE_RATE_LIMIT_WINDOW_MS 内各次
 * 受理的时刻戳，按时间升序。每次判定时就地淘汰出窗的队首，仅在仍有配额时填入本次时刻
 * 并记账，长度不超过 H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW，环形缓冲按该值定容，
 * 无需额外的清理时机。纯进程内配额，不落盘也不镜像给 Worker；进程重启后从空窗口开始。
 */
export const recentHImageCallTimestamps: TimestampDeque =
  new TimestampDeque(H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW);
