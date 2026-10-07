/** owner: main。消息自动流水线（packages/auto）的内存状态。 */

import type { AiReplyActivityEntry } from "../../types/auto";

/**
 * 按 chatId 分群，记录各用户上一次触发随机 AI 回复（随机插话/媒体评价）的时刻。
 * 权威副本只属于主线程自动消息流水线，进程重启从空表重建。没有条目表示当前没有个人随机回复冷却。
 * 容量：硬顶 USER_REPLY_TRIGGER_CACHE_MAX（见 consts/auto.ts）。统一清扫 timer
 * 在冷却到期后删除条目；达到硬顶时新增前先补扫一次，仍满则 fail closed 放弃本次随机
 * 回复，不淘汰仍生效的冷却。空群桶随清扫删除，群桶数不超过全局条目硬顶。
 */
export const userReplyTriggerTimes: Map<number, Map<number, number>> = new Map();

/**
 * 随机回复个人冷却表唯一的清扫 timer 与计数。首次 claim 时建立，表清空时释放；
 * 不按群、用户或消息创建额外 timer。
 * validFrom/validUntil 记录最近清扫确认的满表有效区间，区间内不重复遍历；
 * 满表条目换代、清扫后不足硬顶或整表清空时失效。不跨线程重放。
 * size 记录全局用户条目数，认领和清扫同步维护，清空归零；进程重启从空表重建。
 */
export const userReplyTriggerSweepState: {
  timer: ReturnType<typeof setTimeout> | null;
  size: number;
  validFrom: number;
  validUntil: number;
} = { timer: null, size: 0, validFrom: 0, validUntil: Number.NEGATIVE_INFINITY };

/**
 * 按群的滑动窗口（AI_REPLY_ACTIVITY_WINDOW_MS）活跃度；权威副本只属于主线程自动消息流水线，
 * 最多保留 AI_REPLY_ACTIVITY_MAX_CHATS 个群。命中路径不重排 Map；满载新增时按 entry
 * 中的访问序号选择 LRU，进程重启从空表重建。
 */
export const aiReplyActivityByChat: Map<number, AiReplyActivityEntry> = new Map();

/**
 * 群活跃度表的进程内访问序号。每次观察递增，清空活跃度表时归零；
 * 为满载新增群提供严格 LRU 次序，不参与持久化或跨线程消息。
 */
export const aiReplyActivitySequenceState: { current: number } = { current: 0 };

/** 活跃度表唯一的到期清扫 timer，按各群最早到期时刻调度，表空时不挂；进程重启后为 null。 */
export const aiReplyActivitySweepState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
