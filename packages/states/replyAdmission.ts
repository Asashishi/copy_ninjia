import { RATE_LIMIT_LONG_MAX_TRIGGERS, REPLY_ROUND_MAX_CONCURRENT, REPLY_TRIGGER_QUEUE_MAX } from "../consts/aiChat/rateLimit";
import type {
  AdmitDecision,
  AdmitTriggerInput,
} from "../types/states/replyAdmission";

/**
 * AI 回复准入控制的纯决策规则（不做任何 I/O、不持有计时器，也不碰任何
 * Map/LinkedQueue/Date.now()）。容器与计时留在 workers/aiChat/replyPipeline.ts
 * 与 replyRound.ts，本模块只出这两道闸的判定：
 *
 * - admitTrigger：并发闸，在触发到达时判定。
 * - isReplyRoundRateLimited：限频闸，在真正开始一轮前判定。
 *
 * 两道闸是两次独立的阈值判定，之间隔着「入队等待补跑」的中间态（补跑时才走到
 * isReplyRoundRateLimited，见 replyQueue.ts），各自只接收调用方算好的标量。滑动
 * 窗口（longTriggerTimes）、队列（pendingReplyTriggers）、在途计数
 * （activeReplyCounts）、提示冷却（rateLimitNoticeTimes）等容器与计时属于
 * replyState/replyQueue/replyRound 等运行时模块。
 */

/**
 * 同群允许同时处理的模型轮数（含直接轮）：有序并行轮最多 REPLY_ROUND_MAX_CONCURRENT 个，直接轮
 * 独立于它们，仍在模型阶段时额外占一个并发位；Telegram 发送高压时降为单轮。
 * @param telegramBackpressured 触发投递时刻的发送面高压快照。
 * @param directRoundActive 该群的直接轮仍在模型阶段。
 */
export function replyRoundConcurrencyLimit(telegramBackpressured: boolean, directRoundActive: boolean): number {
  if (telegramBackpressured) return 1;
  return directRoundActive ? REPLY_ROUND_MAX_CONCURRENT + 1 : REPLY_ROUND_MAX_CONCURRENT;
}

/**
 * 按模型并发、存活容量、等待队列及触发种类决定启动、排队或丢弃。
 * 队列非空时，即使有空模型位也先入队；补跑按 FIFO 消费空位。
 * 模型完成、发送收尾、入队后及维护节拍均由 replyPipeline.ts 驱动补跑。
 * 完整发送链有独立容量闸；生命周期约束见 docs/cn/04-invariants.md。
 * @param input.activeRounds 该群当前模型处理尚未完成的回复轮数（含直接轮）。
 * @param input.queueSize 该群当前排队等待补跑的直接触发数。
 * @param input.kind 本次触发的种类。
 */
export function admitTrigger(input: AdmitTriggerInput): AdmitDecision {
  if (
    input.telegramBackpressured &&
    (input.kind === "random" || input.kind === "mediaRandom")
  ) return "dropSilently";
  const maxConcurrent: number = replyRoundConcurrencyLimit(input.telegramBackpressured, input.directRoundActive);
  if (input.deliveryAvailable && input.queueSize === 0 && input.activeRounds < maxConcurrent) {
    return "startRound";
  }
  if (input.kind === "random" || input.kind === "mediaRandom") return "dropSilently";
  if (input.queueSize >= REPLY_TRIGGER_QUEUE_MAX) return "enqueueOverflow";
  return "enqueue";
}

/**
 * 限频闸判定：该群 RATE_LIMIT_LONG_WINDOW_MS 滑动窗口内的触发数是否已达
 * RATE_LIMIT_LONG_MAX_TRIGGERS。调用方先挤掉窗口外的旧触发再数 windowCount；本函数只比较数量。
 * 返回 true 时调用方不记账，按触发来源通知或保留队首；false 时记账后执行。
 * @param windowCount 挤掉过期项之后，窗口内剩余的触发数。
 */
export function isReplyRoundRateLimited(windowCount: number): boolean {
  return windowCount >= RATE_LIMIT_LONG_MAX_TRIGGERS;
}
