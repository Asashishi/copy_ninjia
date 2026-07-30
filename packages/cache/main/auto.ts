import type { TimestampDeque } from "../../libs/timestampDeque";

/** 消息自动流水线（packages/auto）的内存状态。 */

/**
 * 记录各用户上一次触发随机 AI 回复（随机插话/媒体评价）的时刻，以 chatId + 用户 id
 * 拼接作为 key。权威副本只属于主线程自动消息流水线；统一清扫 timer 在冷却
 * 到期后删除条目，进程重启从空表重建。没有条目表示当前没有个人随机回复冷却。
 */
export const userReplyTriggerTimes: Map<string, number> = new Map();

/**
 * 随机回复个人冷却表唯一的清扫 timer。首次 claim 时建立，表清空时释放；
 * 不按群、用户或消息创建额外 timer，进程退出时无需恢复。
 */
export const userReplyTriggerSweepState: {
  timer: ReturnType<typeof setTimeout> | null;
} = { timer: null };

/** 单群随机 AI 触发概率所需的最近活跃窗口。 */
export interface AiReplyActivityEntry {
  /** 只保留足以计算 1/10 下限的最新消息时间戳。 */
  timestamps: TimestampDeque;
  lastObservedAt: number;
}

/** 按群的一小时滑动活跃度；纯内存、Map 顺序同时是 LRU 顺序。 */
export const aiReplyActivityByChat: Map<number, AiReplyActivityEntry> = new Map();

/** 所有群共用一个到期计时器，不为每群/每消息创建 timer。 */
export const aiReplyActivitySweepState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
