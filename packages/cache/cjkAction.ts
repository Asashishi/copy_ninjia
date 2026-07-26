import { LinkedQueue } from "../libs/linkedQueue";

/** 中文动作命令（packages/commands/cjkAction.ts）的内存状态。 */

/**
 * 动作命令的全局滑动窗口频率限制：最近 CJK_ACTION_RATE_LIMIT_WINDOW_MS
 * （90 秒）内各次应答的时刻戳，按时间升序。每次判定时就地淘汰出窗的队首，
 * 因此长度恒不超过 CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW（450），
 * 无需额外的清理时机；修剪只发生在队首，故用 LinkedQueue 而非数组
 * （见 libs/slidingWindowRateLimit.ts）。纯进程内配额，不落盘也不镜像给
 * Worker：进程重启后从空窗口重新开始，重启本身已经中断了要限的那波流量。
 */
export const recentActionCallTimestamps: LinkedQueue<number> = new LinkedQueue();
