import type { AiReplyActivityEntry } from "../../types/auto";

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

/**
 * 按群的一小时滑动活跃度；权威副本只属于主线程自动消息流水线，最多保留
 * AI_REPLY_ACTIVITY_MAX_CHATS 个群。命中路径不重排 Map；满载新增时按 entry
 * 中的访问序号选择 LRU，进程重启从空表重建。
 */
export const aiReplyActivityByChat: Map<number, AiReplyActivityEntry> = new Map();

/**
 * 群活跃度表的进程内访问序号。每次观察递增，清空活跃度表时归零；它只为
 * 满载新增群提供严格 LRU 次序，不参与持久化或跨线程消息。
 */
export const aiReplyActivitySequenceState: { current: number } = { current: 0 };

/** 所有群共用一个到期计时器，不为每群/每消息创建 timer。 */
export const aiReplyActivitySweepState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
