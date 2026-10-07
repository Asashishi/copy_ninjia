import {
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
  replyGenerations,
  replyAbortControllers,
  replyGenerationTasks,
  activeReplyCounts,
} from "../../cache/workers/aiChat/replies";
import { invalidateChatRuntimeCache } from "../../cache/workers/aiChat/index";
import { AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS } from "../../consts/lifecycle";
import { logger } from "../../infra/logger";
import { settleWithinBudget } from "../../libs/inflight";

/**
 * AI 回复 epoch 与其异步任务的统一生命周期边界。epoch 的读取与核对由各调用方直接
 * 使用 cache/workers/aiChat/replies.ts 的 cachedReplyGeneration 与
 * isCachedReplyGenerationCurrent。回复轮、限频提示、媒体描述和记忆压缩都必须在
 * 本模块登记；群失效时同步撤销旧 epoch，再等待该 epoch 的任务 settle。
 *
 * epoch 由 cachedReplyGeneration 在本 isolate 内单调分配、绝不复用，取消控制器与任务表因此
 * 直接以 epoch 为键，不拼群 id。
 */

/** 记忆淘汰优先保护在途模型和当前代际尚未结算的任务，包含独立发送链。 */
export function hasActiveAiChatTasks(chatId: number): boolean {
  if ((activeReplyCounts.get(chatId) ?? 0) > 0) return true;
  const generation: number | undefined = replyGenerations.get(chatId);
  return generation !== undefined && (replyGenerationTasks.get(generation)?.size ?? 0) > 0;
}

/**
 * 记忆淘汰的失效边界：同 invalidateChatRuntimeCache，不 abort 在途任务；当前代已无
 * 在途任务时一并回收它的取消控制器，有在途任务时由 trackReplyGenerationTask 在
 * 结算后回收（那时该代已不是当前代）。
 */
export function evictChatReplyGeneration(chatId: number): void {
  const generation: number | undefined = replyGenerations.get(chatId);
  invalidateChatRuntimeCache(chatId);
  if (generation === undefined) return;
  if (!replyGenerationTasks.has(generation)) replyAbortControllers.delete(generation);
}

/** 取得本轮 generation 的唯一取消信号。 */
export function replyGenerationSignal(generation: number): AbortSignal {
  let controller: AbortController | undefined = replyAbortControllers.get(generation);
  if (controller === undefined) {
    controller = new AbortController();
    replyAbortControllers.set(generation, controller);
  }
  return controller.signal;
}

/** 登记需要被 invalidate 等待的 generation-sensitive 异步任务。 */
export function trackReplyGenerationTask(
  chatId: number,
  generation: number,
  task: Promise<void>
): void {
  let tasks: Set<Promise<void>> | undefined = replyGenerationTasks.get(generation);
  if (tasks === undefined) {
    tasks = new Set();
    replyGenerationTasks.set(generation, tasks);
  }
  tasks.add(task);
  void task.finally((): void => {
    const current: Set<Promise<void>> | undefined = replyGenerationTasks.get(generation);
    current?.delete(task);
    if (current?.size === 0) {
      replyGenerationTasks.delete(generation);
      if (!isCachedReplyGenerationCurrent(chatId, generation)) {
        replyAbortControllers.delete(generation);
      }
    }
  }).catch((): void => {
    // 原 task 的 owner 负责记录错误；这里只维护任务集合。
  });
}

/**
 * 停机时同步使全部回复 epoch 失效并取消可取消请求，再等待回复、提示、媒体描述
 * 与记忆压缩任务全部 settle。调用方已先关闭新任务入口；循环每轮重新取任务快照，
 * 覆盖在途任务结算过程中登记的子任务。本函数完成后 flush 才上报最后一份 dirty 记忆。
 */
export async function quiesceAiChatReplies(): Promise<void> {
  for (const controller of replyAbortControllers.values()) {
    controller.abort(new DOMException("AI chat Worker is quiescing.", "AbortError"));
  }
  for (const chatId of [...replyGenerations.keys()]) {
    invalidateChatRuntimeCache(chatId);
  }
  while (replyGenerationTasks.size > 0) {
    const tasks: Promise<void>[] = [];
    for (const generationTasks of replyGenerationTasks.values()) {
      tasks.push(...generationTasks);
    }
    if (tasks.length === 0) break;
    await Promise.allSettled(tasks);
  }
  replyAbortControllers.clear();
}

/**
 * 同步使旧 generation 失效并 abort，返回的 Promise 在该代相关异步任务 settle
 * 后完成，最多等 AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS，到点放行。调用栈内
 * 先删除旧 epoch，后续 trigger 会分配全新的唯一 epoch。
 *
 * 放行时未结算的任务按 generation 自检，失效后不再写状态（见
 * compaction.ts 的 rotateCompaction 与 mediaIngest.ts 的回填守卫）。
 */
export function invalidateChatReplies(chatId: number): Promise<void> {
  const generation: number = cachedReplyGeneration(chatId);
  replyAbortControllers.get(generation)?.abort(
    new DOMException("AI chat generation invalidated.", "AbortError")
  );
  invalidateChatRuntimeCache(chatId);
  const tasks: Set<Promise<void>> | undefined = replyGenerationTasks.get(generation);
  if (tasks === undefined || tasks.size === 0) {
    replyAbortControllers.delete(generation);
    return Promise.resolve();
  }
  const pending: number = tasks.size;
  return settleWithinBudget(tasks, AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS).then((settled: boolean): void => {
    if (!settled) {
      logger.error(
        `AI chat invalidation for chat ${chatId} gave up waiting on ${pending} generation task(s) ` +
        `after ${AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS}ms; they stay generation-guarded and cannot write anymore.`
      );
    }
    replyGenerationTasks.delete(generation);
    replyAbortControllers.delete(generation);
  });
}
