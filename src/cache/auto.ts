import type { LinkedQueue } from "../libs/linkedQueue";

/** 消息自动流水线（src/auto）的内存状态。 */

/**
 * 记录各用户上一次触发随机 AI 回复（随机插话/媒体评价）的时刻，以 chatId + 用户 id
 * 拼接作为 key。条目由 src/auto/message/ 的 tryClaimUserReplyTrigger 在
 * 冷却期满后自动清理。
 */
export const userReplyTriggerTimes: Map<string, number> = new Map();

/** 单群随机 AI 触发概率所需的最近活跃窗口。 */
export interface AiReplyActivityEntry {
  /** 只保留足以计算 1/10 下限的最新消息时间戳。 */
  timestamps: LinkedQueue<number>;
  lastObservedAt: number;
}

/** 按群的一小时滑动活跃度；纯内存、Map 顺序同时是 LRU 顺序。 */
export const aiReplyActivityByChat: Map<number, AiReplyActivityEntry> = new Map();

/** 所有群共用一个到期计时器，不为每群/每消息创建 timer。 */
export const aiReplyActivitySweepState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
