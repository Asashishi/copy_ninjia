import {
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
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
 * 同步使旧 generation 失效并 abort，返回的 Promise 在该代相关异步任务 settle
 * 后完成——最多等 AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS，到点降级放行。调用栈内
 * 先删除旧 epoch，后续 trigger 会分配全新的唯一 epoch。
 *
 * 等待有上限，因为登记进来的任务并非都收得住 abort：记忆压缩与媒体描述那两条
 * 链拿不到 AbortSignal（requestGeminiResponse 不接受），重试间隔加请求超时最坏
 * 能跑几分钟，而调用方的预算只有 10 秒。无上限地等，一次「/ai_chat disable 撞上
 * 镜像块轮转」就会让主线程超时 reject，异常逃进 grammY 中间件、offset 被扣住、
 * 重启后重投同一条指令。降级不影响正确性：这些任务全部按 generation 自检，
 * 失效之后跑完也不会再写任何东西（见 compaction.ts 的 rotateCompaction）。
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
  const expired: Promise<boolean> = new Promise((resolve: (value: boolean) => void): void => {
    setTimeout((): void => resolve(false), AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS).unref?.();
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
  });
}
