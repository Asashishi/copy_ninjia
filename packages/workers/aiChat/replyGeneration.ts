import {
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
  replyGenerations,
  replyAbortControllers,
  replyGenerationTasks,
} from "../../cache/workers/aiChat/replies";
import { invalidateChatRuntimeCache } from "../../cache/workers/aiChat/index";
import { AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS } from "../../consts/lifecycle";
import { logger } from "../../infra/logger";

/**
 * AI 回复 epoch 与其异步任务的统一生命周期边界。回复轮、限频提示、媒体描述和
 * 记忆压缩都必须登记；群失效时同步撤销旧 epoch，再等待该 epoch 的任务 settle。
 */

export function currentReplyGeneration(chatId: number): number {
  return cachedReplyGeneration(chatId);
}

export function isReplyGenerationCurrent(chatId: number, generation: number): boolean {
  return isCachedReplyGenerationCurrent(chatId, generation);
}

function generationKey(chatId: number, generation: number): string {
  return `${chatId}:${generation}`;
}

/** 取得本轮 generation 的唯一取消信号。 */
export function replyGenerationSignal(chatId: number, generation: number): AbortSignal {
  const key: string = generationKey(chatId, generation);
  let controller: AbortController | undefined = replyAbortControllers.get(key);
  if (controller === undefined) {
    controller = new AbortController();
    replyAbortControllers.set(key, controller);
  }
  return controller.signal;
}

/** 登记需要被 invalidate 等待的 generation-sensitive 异步任务。 */
export function trackReplyGenerationTask(
  chatId: number,
  generation: number,
  task: Promise<void>
): void {
  const key: string = generationKey(chatId, generation);
  let tasks: Set<Promise<void>> | undefined = replyGenerationTasks.get(key);
  if (tasks === undefined) {
    tasks = new Set();
    replyGenerationTasks.set(key, tasks);
  }
  tasks.add(task);
  void task.finally((): void => {
    const current: Set<Promise<void>> | undefined = replyGenerationTasks.get(key);
    current?.delete(task);
    if (current?.size === 0) {
      replyGenerationTasks.delete(key);
      if (!isReplyGenerationCurrent(chatId, generation)) {
        replyAbortControllers.delete(key);
      }
    }
  }).catch((): void => {
    // 原 task 的 owner 负责记录错误；这里只维护任务集合。
  });
}

/**
 * 停机时同步使全部回复 epoch 失效并取消可取消请求，再等待回复、提示、媒体描述
 * 与记忆压缩任务全部 settle。调用方已先关闭新任务入口；循环快照仍防御在途任务
 * 结算过程中登记的子任务。只有本函数完成后，flush 才能覆盖最后一份 dirty 记忆。
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
 * 后完成——最多等 AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS，到点降级放行。调用栈内
 * 先删除旧 epoch，后续 trigger 会分配全新的唯一 epoch。
 *
 * 等待仍保留硬上限：媒体下载、摘要与供应商请求都传递本代 AbortSignal，但外部 SDK、
 * Worker 双工或代理端点仍可能没有及时结算。无上限地等会让主线程命令超时并重投；
 * 降级不影响正确性，因为任务同时按 generation 自检，失效后绝不再写状态（见
 * compaction.ts 的 rotateCompaction 与 mediaIngest.ts 的回填守卫）。
 */
export function invalidateChatReplies(chatId: number): Promise<void> {
  const generation: number = currentReplyGeneration(chatId);
  const key: string = generationKey(chatId, generation);
  replyAbortControllers.get(key)?.abort(
    new DOMException("AI chat generation invalidated.", "AbortError")
  );
  invalidateChatRuntimeCache(chatId);
  const tasks: Set<Promise<void>> | undefined = replyGenerationTasks.get(key);
  if (tasks === undefined || tasks.size === 0) {
    replyAbortControllers.delete(key);
    return Promise.resolve();
  }
  const pending: number = tasks.size;
  const drained: Promise<boolean> = Promise.allSettled([...tasks]).then((): boolean => true);
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const expired: Promise<boolean> = new Promise((resolve: (value: boolean) => void): void => {
    expiryTimer = setTimeout(
      (): void => resolve(false),
      AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS
    );
    expiryTimer.unref();
  });
  return Promise.race([drained, expired]).then((settled: boolean): void => {
    if (!settled) {
      logger.error(
        `AI chat invalidation for chat ${chatId} gave up waiting on ${pending} generation task(s) ` +
        `after ${AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS}ms; they stay generation-guarded and cannot write anymore.`
      );
    }
    replyGenerationTasks.delete(key);
    replyAbortControllers.delete(key);
  }).finally((): void => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  });
}
