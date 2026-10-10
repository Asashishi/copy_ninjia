import { aiChatAtmosphere } from "./atmosphere";
import type { TelegramWorkerTemporaryMessageResult } from "../../types/telegramWorker";
import { sendTemporaryMessageFromMain } from "../../infra/telegram/workerClient";
import { RATE_LIMIT_NOTICE_COOLDOWN_MS } from "../../consts/aiChat/rateLimit";

import {
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
  rateLimitNoticeTimes,
} from "../../cache/workers/aiChat/replies";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { recordChatMessage } from "./rollingMemory";
import {
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyGeneration";

/** notifyRateLimited 的入参。 */
export interface NotifyRateLimitedParams {
  chatId: number;
  now: number;
  /** 缺省取当前代数（replyQueue.ts 的 flushOverflowNotice）；回复轮启动被限频时显式传入它捕获的代数。 */
  generation?: number;
  /** 提示要落进的论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
}

/**
 * 触发被限频或队列溢出时发送明确反馈。提示按群冷却（RATE_LIMIT_NOTICE_COOLDOWN_MS）；
 * 发送成功后与普通 AI 回复一样登记自发消息并写入滚动记忆。
 *
 * 提示经 messageThreadId 落在触发消息所在的话题。
 */
export function notifyRateLimited({
  chatId,
  now,
  generation = cachedReplyGeneration(chatId),
  messageThreadId,
}: NotifyRateLimitedParams): void {
  const lastNoticeTime: number = rateLimitNoticeTimes.get(chatId) ?? 0;
  if (now - lastNoticeTime < RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeTimes.set(chatId, now);
  const signal: AbortSignal = replyGenerationSignal(generation);
  const text: string = aiChatAtmosphere().RATE_LIMIT_NOTICE_TEXT;
  const task: Promise<void> = sendTemporaryMessageFromMain({
    purpose: "notice",
    chatId,
    text,
    signal,
    messageThreadId,
  }).then((result: TelegramWorkerTemporaryMessageResult | undefined): void => {
    if (result === undefined || !("messageId" in result)) return;
    const sentMessageId: number = result.messageId;
    if (botInfoState.current && isCachedReplyGenerationCurrent(chatId, generation)) {
      recordChatMessage(buildSelfRecordMessage({
        chatId,
        self: botInfoState.current,
        messageId: sentMessageId,
        text,
      }));
    }
  });
  trackReplyGenerationTask(chatId, generation, task);
}
