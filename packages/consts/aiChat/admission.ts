import type { AdmitDecision, RoundDecision } from "../../types/states/replyAdmission";

/** AI 回复准入的共享启动决策，模型与存活容量均允许启动时只读返回。 */
export const START_REPLY_ROUND: Readonly<AdmitDecision> = { action: "startRound" };
/** AI 直接触发的共享排队决策，等待队列尚有空位时只读返回。 */
export const ENQUEUE_REPLY: Readonly<AdmitDecision> = { action: "enqueue" };
/** AI 随机触发的共享丢弃决策，容量不足或出站高压时只读返回。 */
export const DROP_REPLY_SILENTLY: Readonly<AdmitDecision> = { action: "dropSilently" };
/** AI 直接触发的共享溢出决策，等待队列已满时只读返回。 */
export const REPLY_QUEUE_OVERFLOW: Readonly<AdmitDecision> = { action: "enqueueOverflow" };
/** AI 轮次限频的共享运行决策，滑动窗口仍有额度时只读返回。 */
export const RUN_REPLY_ROUND: Readonly<RoundDecision> = { action: "run" };
/** AI 轮次限频的共享拒绝决策，滑动窗口额度耗尽时只读返回。 */
export const REPLY_ROUND_RATE_LIMITED: Readonly<RoundDecision> = { action: "rateLimited" };
