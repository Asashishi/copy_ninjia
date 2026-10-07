import { STATE_MANAGED_CHAT_LIMIT } from "../storage";

/** AI 随机搭话的按群活跃度观察窗口；不落盘，重启后从冷群起步。 */
export const AI_REPLY_ACTIVITY_WINDOW_MS: number = 60 * 60 * 1000;
/** 冷群随机搭话概率的初始分母；当前消息入窗后再参与递减。 */
export const AI_REPLY_PROBABILITY_BASE_INITIAL: number = 125;
/** 高活跃群随机搭话概率的分母下限，防止概率随消息数无限提高。 */
export const AI_REPLY_PROBABILITY_BASE_MIN: number = 10;
/** 达到封底后更旧的时刻已不影响概率。 */
export const AI_REPLY_ACTIVITY_MAX_TIMESTAMPS: number =
  AI_REPLY_PROBABILITY_BASE_INITIAL - AI_REPLY_PROBABILITY_BASE_MIN;
/**
 * 活跃度表最多保留的群数；超额淘汰最久未活动群。进表的只有通过 init 网关的群消息，
 * 受管群不超过 STATE_MANAGED_CHAT_LIMIT；停管群的条目要等一个观察窗口空闲后才被清理，
 * 可能与同样多的新受管群短暂并存，取值为 STATE_MANAGED_CHAT_LIMIT 的固定倍数。所属模块：auto/message/aiReplyActivity.ts。
 */
export const AI_REPLY_ACTIVITY_MAX_CHATS: number = 2 * STATE_MANAGED_CHAT_LIMIT;

/** 单群长滚动窗口时长。 */
export const RATE_LIMIT_LONG_WINDOW_MS: number = 5 * 60_000;
/** 单群长窗口内允许启动的最大回复轮数。 */
export const RATE_LIMIT_LONG_MAX_TRIGGERS: number = 150;
/**
 * AI 回复同群最多同时处理的有序并行模型轮数；完整链就绪即释放，发送等待不计入。直接轮（群里没有在途
 * 轮次时启动、边生成边发送的发送链队首）独立于这个上限，在模型阶段另占 1 轮，同群合计最多
 * REPLY_ROUND_MAX_CONCURRENT + 1 轮（见 states/replyAdmission.ts 的 replyRoundConcurrencyLimit）。
 */
export const REPLY_ROUND_MAX_CONCURRENT: number = 5;
/** 单群尚未按序回收的回复轮次硬顶，包含已取消但仍存活的旧代；独立于模型并发与时间窗口。 */
export const REPLY_DELIVERY_MAX_PER_CHAT: number = 32;
/** AI Worker 全部群及代际共同持有的回复轮次硬顶，按顺位回收后才归还容量。 */
export const REPLY_DELIVERY_MAX_TOTAL: number = 128;
/** 同群直接触发在并发满载时允许排队的最大数量。 */
export const REPLY_TRIGGER_QUEUE_MAX: number = 15;
/** 排队触发原文快照的截断上限。 */
export const QUEUED_TRIGGER_SNIPPET_MAX_CHARS: number = 200;
/** 同群限频提示的冷却时长；冷却期内不重复发提示（提示文案在 consts/atmosphere/ 各风格的 aiChat_rateLimit.ts）。 */
export const RATE_LIMIT_NOTICE_COOLDOWN_MS: number = 60_000;
