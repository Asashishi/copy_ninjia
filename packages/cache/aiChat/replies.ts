import type { LinkedQueue } from "../../libs/linkedQueue";
import { LruCache } from "../../libs/lruCache";
import {
  RATE_LIMIT_LONG_WINDOW_MS,
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  REPLY_GENERATIONS_MAX,
} from "../../consts/aiChat/rateLimit";
import type { QueuedReplyTrigger } from "../../types/aiChat/replies";

/**
 * AI 回复调度的内存状态，由回复流水线的多个子模块共同驱动，没有单一 owner：
 * packages/workers/aiChat/replyQueue.ts（排队/溢出提示消费）、replyRound.ts
 * （并发位与长窗口触发时刻）、replyPipeline.ts（在途计数读取/溢出提示登记）、
 * replyState.ts（代际读取、限频提示冷却）；失效与整体重置经
 * cache/aiChat/index.ts 的门面函数，由 replyState.ts/rollingMemory.ts 调用。
 */

/** 回复调度的唯一运行时 owner。全部状态不落盘，Worker 重建时清空。代际表
 * 使用有界 LRU；窗口队列、提示冷却和待处理队列都按群主动清理。 */
export const replyGenerations: LruCache<number, number> = new LruCache(REPLY_GENERATIONS_MAX);
/** 每群最近一次限频提示时刻；周期 sweep 删除过期项，Worker 重建后清空。 */
export const rateLimitNoticeTimes: Map<number, number> = new Map();
/** 每群长窗口触发时刻队列；周期 sweep 删除过期项，长度受窗口请求上限约束。 */
export const longTriggerTimes: Map<number, LinkedQueue<number>> = new Map();
/** 每群当前在途回复数；回复 finally 递减，Worker 重建后归零。 */
export const activeReplyCounts: Map<number, number> = new Map();
/** 同群并发满载后的直接触发有界队列；轮次接纳或群失效时消费/清除。 */
export const pendingReplyTriggers: Map<number, LinkedQueue<QueuedReplyTrigger>> = new Map();
/** 已安排溢出提示的群集合；提示任务 settle 或群失效时删除。 */
export const pendingOverflowNotices: Set<number> = new Set();

/** 读取某群当前回复代际；未登记或 Worker 重建后返回 0。 */
export function cachedReplyGeneration(chatId: number): number {
  return replyGenerations.get(chatId) ?? 0;
}

/** 使旧异步工作失效，并清理尚未启动的工作与本群限频历史。activeReplyCounts
 * 刻意保留到各在途轮 finally 自行释放，避免禁用/重启用之间复用并发位时，
 * 旧轮的迟到 finally 把新轮计数误减掉。 */
export function invalidateChatReplyCache(chatId: number): number {
  const generation: number = cachedReplyGeneration(chatId) + 1;
  replyGenerations.set(chatId, generation);
  pendingReplyTriggers.delete(chatId);
  pendingOverflowNotices.delete(chatId);
  longTriggerTimes.delete(chatId);
  rateLimitNoticeTimes.delete(chatId);
  return generation;
}

/** 定时收掉已过期的限频窗口和提示冷却记录。 */
export function sweepAiChatReplyCache(now: number = Date.now()): void {
  for (const [chatId, times] of longTriggerTimes) {
    if ((times.last(1)[0] ?? now) > now) {
      longTriggerTimes.delete(chatId);
      continue;
    }
    while (times.size > 0 && now - times.peek()! >= RATE_LIMIT_LONG_WINDOW_MS) times.shift();
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
}
