/** AI 主动搭话按群统计最近一小时活跃度；不落盘，重启后从冷群起步。 */
export const AI_REPLY_ACTIVITY_WINDOW_MS: number = 60 * 60 * 1000;
/** 概率为 1 / base；每观察到一条群消息，base 从 175 减 1。 */
export const AI_REPLY_PROBABILITY_BASE_INITIAL: number = 175;
/** 最热时封底到 1/10。 */
export const AI_REPLY_PROBABILITY_BASE_MIN: number = 10;
/** 达到封底后更旧的时刻已不影响概率。 */
export const AI_REPLY_ACTIVITY_MAX_TIMESTAMPS: number =
  AI_REPLY_PROBABILITY_BASE_INITIAL - AI_REPLY_PROBABILITY_BASE_MIN;
/** 活跃度表最多保留的群数；超额淘汰最久未活动群。 */
export const AI_REPLY_ACTIVITY_MAX_CHATS: number = 500;

/** replyGenerations 有界 LRU 的容量。 */
export const REPLY_GENERATIONS_MAX: number = 3500;

/** 单群五分钟滚动窗口及其触发上限。 */
export const RATE_LIMIT_LONG_WINDOW_MS: number = 5 * 60_000;
export const RATE_LIMIT_LONG_MAX_TRIGGERS: number = 150;
/** 同群在途回复轮数和直接触发等候队列上限。 */
export const REPLY_ROUND_MAX_CONCURRENT: number = 5;
export const REPLY_TRIGGER_QUEUE_MAX: number = 15;
/** 排队触发原文快照的截断上限。 */
export const QUEUED_TRIGGER_SNIPPET_MAX_CHARS: number = 200;
/** 限频提示本身的冷却与固定文案。 */
export const RATE_LIMIT_NOTICE_COOLDOWN_MS: number = 60_000;
export const RATE_LIMIT_NOTICE_TEXT: string = "你们太快了……本天才的嘴巴也是要休息的，这波先不接了，杂鱼们悠着点♡";
