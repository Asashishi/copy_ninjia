import type { LinkedQueue } from "../../../libs/linkedQueue";
import {
  RATE_LIMIT_LONG_WINDOW_MS,
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
} from "../../../consts/aiChat/rateLimit";
import type { QueuedReplyTrigger } from "../../../types/aiChat/replies";
import { trimSlidingWindow } from "../../../libs/slidingWindowRateLimit";

/**
 * AI 回复调度的内存状态，由回复流水线的多个子模块共同驱动，没有单一 owner：
 * packages/workers/aiChat/replyQueue.ts（排队/溢出提示消费）、replyRound.ts
 * （并发位与长窗口触发时刻）、replyPipeline.ts（在途计数读取/溢出提示登记）、
 * replyState.ts（代际读取、限频提示冷却）；失效与整体重置经
 * cache/workers/aiChat/index.ts 的门面函数，由 replyState.ts/rollingMemory.ts 调用。
 */

/**
 * 每群当前的唯一回复 epoch。首次接纳该群的异步工作时分配；群失效时删除，Worker
 * 重建时随 isolate 清空，因此容量只随当前有回复工作的群数增长，不保留历史群。
 *
 * epoch 在同一 isolate 内绝不复用：在途回复轮、限频提示、媒体描述与记忆压缩捕获
 * 旧值后，即使本群条目已回收并重新启用，也不可能重新匹配旧任务。
 */
export const replyGenerations: Map<number, number> = new Map();
/**
 * 回复 epoch 的单调分配器；Worker 重建时从零开始。测试隔离的 cache reset 刻意
 * 不回退它，防止 reset 前尚未回调的异步工作与 reset 后的新工作复用同一个 epoch。
 */
const replyGenerationCounter: { current: number } = { current: 0 };
/** 每群最近一次限频提示时刻；周期 sweep 删除过期项，Worker 重建后清空。 */
export const rateLimitNoticeTimes: Map<number, number> = new Map();
/** 每群长窗口触发时刻队列；周期 sweep 删除过期项，长度受窗口请求上限约束。 */
export const longTriggerTimes: Map<number, LinkedQueue<number>> = new Map();
/** 每群当前在途回复数；回复 finally 递减，Worker 重建后归零。 */
export const activeReplyCounts: Map<number, number> = new Map();
/** 同群并发满载后的直接触发有界队列；轮次接纳或群失效时消费/清除。 */
export const pendingReplyTriggers: Map<number, LinkedQueue<QueuedReplyTrigger>> = new Map();
/**
 * 已安排溢出提示的群 -> 那条被丢掉的触发所在的论坛话题（General/非论坛群为
 * undefined）；提示任务 settle 或群失效时删除。
 *
 * 记话题而不只是记群：提示是对某一条具体触发的回应，话题群里不带
 * message_thread_id 发出去就会掉进 General（见 libs/forumTopic.ts）。
 * 容量与 pendingReplyTriggers 同阶（每群至多一项）。
 */
export const pendingOverflowNotices: Map<number, number | undefined> = new Map();
/**
 * 每个 chat:generation 的取消控制器。回复轮或限频提示开始时创建，invalidate
 * 同步 abort 旧代；该代任务全部 settle 后删除。
 */
export const replyAbortControllers: Map<string, AbortController> = new Map();
/** 每个 chat:generation 尚未 settle 的回复、提示、媒体描述与记忆压缩任务。 */
export const replyGenerationTasks: Map<string, Set<Promise<void>>> = new Map();

/** 读取某群当前回复 epoch；未登记时分配一个本 isolate 内唯一的新值。 */
export function cachedReplyGeneration(chatId: number): number {
  const cached: number | undefined = replyGenerations.get(chatId);
  if (cached !== undefined) return cached;
  if (replyGenerationCounter.current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("AI reply generation epoch exhausted.");
  }
  replyGenerationCounter.current += 1;
  const generation: number = replyGenerationCounter.current;
  replyGenerations.set(chatId, generation);
  return generation;
}

/** 无副作用地核对捕获的 epoch；条目已回收时一律视为旧任务。 */
export function isCachedReplyGenerationCurrent(chatId: number, generation: number): boolean {
  return replyGenerations.get(chatId) === generation;
}

/** 使旧异步工作失效，并清理尚未启动的工作与本群限频历史。activeReplyCounts
 * 刻意保留到各在途轮 finally 自行释放，避免禁用/重启用之间复用并发位时，
 * 旧轮的迟到 finally 把新轮计数误减掉。 */
export function invalidateChatReplyCache(chatId: number): void {
  replyGenerations.delete(chatId);
  pendingReplyTriggers.delete(chatId);
  pendingOverflowNotices.delete(chatId);
  longTriggerTimes.delete(chatId);
  rateLimitNoticeTimes.delete(chatId);
}

/** 定时收掉已过期的限频窗口和提示冷却记录。 */
export function sweepAiChatReplyCache(now: number = Date.now()): void {
  for (const [chatId, times] of longTriggerTimes) {
    trimSlidingWindow({ timestamps: times, windowMs: RATE_LIMIT_LONG_WINDOW_MS, now });
    if (times.size === 0) longTriggerTimes.delete(chatId);
  }
  for (const [chatId, at] of rateLimitNoticeTimes) {
    if (at > now || now - at >= RATE_LIMIT_NOTICE_COOLDOWN_MS) rateLimitNoticeTimes.delete(chatId);
  }
}

/** Worker dispose/测试隔离时清空全部回复运行时状态。 */
export function resetAiChatReplyCache(): void {
  replyGenerations.clear();
  rateLimitNoticeTimes.clear();
  longTriggerTimes.clear();
  activeReplyCounts.clear();
  pendingReplyTriggers.clear();
  pendingOverflowNotices.clear();
  for (const controller of replyAbortControllers.values()) controller.abort();
  replyAbortControllers.clear();
  replyGenerationTasks.clear();
}
