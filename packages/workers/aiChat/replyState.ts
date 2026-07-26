import {
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  RATE_LIMIT_NOTICE_TEXT,
} from "../../consts/aiChat/rateLimit";
import {
  rateLimitNoticeTimes,
  cachedReplyGeneration,
  replyAbortControllers,
  replyGenerationTasks,
} from "../../cache/aiChat/replies";
import { botInfoState } from "../../cache/aiChat/identity";
import { invalidateChatRuntimeCache } from "../../cache/aiChat/index";
import { buildSelfRecordContext } from "../../ai/utils/selfRecord";
import { sendMessage } from "../../infra/telegram";
import type { AiSentMessage } from "../../types/aiChat/protocol";
import { recordChatMessage } from "./rollingMemory";

declare const self: Worker;

export function currentReplyGeneration(chatId: number): number {
  return cachedReplyGeneration(chatId);
}

export function isReplyGenerationCurrent(chatId: number, generation: number): boolean {
  return currentReplyGeneration(chatId) === generation;
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

/** 登记需要被 invalidate 等待的用户可见副作用任务。 */
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
 * 同步使旧 generation 失效并 abort，返回的 Promise 在该代全部用户可见副作用
 * settle 后完成。调用栈内先递增 generation，后续 trigger 不会再加入旧任务集。
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
  return Promise.allSettled([...tasks]).then((): void => {
    replyGenerationTasks.delete(key);
    replyAbortControllers.delete(key);
  });
}

/**
 * 触发被限频或队列溢出时发送明确反馈。提示本身按群冷却，避免刷屏；发送
 * 成功后与普通 AI 回复一样登记自发消息并写入滚动记忆。
 */
export function notifyRateLimited(chatId: number, now: number, generation: number = currentReplyGeneration(chatId)): void {
  const lastNoticeTime: number = rateLimitNoticeTimes.get(chatId) ?? 0;
  if (now - lastNoticeTime < RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeTimes.set(chatId, now);
  const signal: AbortSignal = replyGenerationSignal(chatId, generation);
  const task: Promise<void> = sendMessage({
    chatId,
    text: RATE_LIMIT_NOTICE_TEXT,
    signal,
  }).then((sentMessageId: number | undefined): void => {
    if (sentMessageId === undefined) return;
    self.postMessage({ type: "sent", chatId, messageId: sentMessageId } satisfies AiSentMessage);
    if (botInfoState.current && isReplyGenerationCurrent(chatId, generation)) {
      recordChatMessage({
        ...buildSelfRecordContext({ chatId, self: botInfoState.current, messageId: sentMessageId }),
        text: RATE_LIMIT_NOTICE_TEXT,
      });
    }
  });
  trackReplyGenerationTask(chatId, generation, task);
}
