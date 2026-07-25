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
export const REPLY_GENERATIONS_MAX: number = 3_500;

/** 单群五分钟滚动窗口及其触发上限。 */
export const RATE_LIMIT_LONG_WINDOW_MS: number = 5 * 60_000;
/** 单群长窗口内允许启动的最大回复轮数。 */
export const RATE_LIMIT_LONG_MAX_TRIGGERS: number = 150;
/** 同群允许同时在途的最大回复轮数；心跳、贴纸发送等路径必须保持跨轮并发安全。 */
export const REPLY_ROUND_MAX_CONCURRENT: number = 5;
/** 同群直接触发在并发满载时允许排队的最大数量。 */
export const REPLY_TRIGGER_QUEUE_MAX: number = 25;
/** 排队触发原文快照的截断上限。 */
export const QUEUED_TRIGGER_SNIPPET_MAX_CHARS: number = 200;
/** 限频提示本身的冷却与固定文案。 */
export const RATE_LIMIT_NOTICE_COOLDOWN_MS: number = 60_000;
/** 达到回复限频时发送给群聊的固定提示。 */
export const RATE_LIMIT_NOTICE_TEXT: string = "你们太快了……本天才的嘴巴也是要休息的，这波先不接了，杂鱼们悠着点♡";
