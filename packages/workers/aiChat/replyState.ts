import type { TelegramWorkerTemporaryMessageResult } from "../../types/telegramWorker";
import { sendTemporaryMessageFromMain } from "../../infra/telegram/workerClient";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";
import {
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  RATE_LIMIT_NOTICE_TEXT,
} from "../../consts/aiChat/rateLimit";
import {
  rateLimitNoticeTimes,
} from "../../cache/workers/aiChat/replies";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { recordChatMessage } from "./rollingMemory";
import {
  currentReplyGeneration,
  isReplyGenerationCurrent,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyGeneration";

export {
  currentReplyGeneration,
  invalidateChatReplies,
  isReplyGenerationCurrent,
  quiesceAiChatReplies,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyGeneration";

/** notifyRateLimited 的入参；话题落点是第四项，因此收成 options。 */
export interface NotifyRateLimitedParams {
  chatId: number;
  now: number;
  /** 缺省取当前代数；排队补跑那一路会显式传入捕获时的代数。 */
  generation?: number;
  /** 提示要落进的论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
}

/**
 * 触发被限频或队列溢出时发送明确反馈。提示本身按群冷却，避免刷屏；发送
 * 成功后与普通 AI 回复一样登记自发消息并写入滚动记忆。
 *
 * 提示与它所回应的那条触发在同一个话题里发出——话题群里不带 message_thread_id
 * 的发送一律掉进 General，那样被限频的人在自己的话题里只会看到沉默。
 */
export function notifyRateLimited({
  chatId,
  now,
  generation = currentReplyGeneration(chatId),
  messageThreadId,
}: NotifyRateLimitedParams): void {
  const lastNoticeTime: number = rateLimitNoticeTimes.get(chatId) ?? 0;
  if (now - lastNoticeTime < RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeTimes.set(chatId, now);
  const signal: AbortSignal = replyGenerationSignal(chatId, generation);
  const task: Promise<void> = sendTemporaryMessageFromMain({
    purpose: "notice",
    deleteAfterMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
    chatId,
    text: RATE_LIMIT_NOTICE_TEXT,
    signal,
    messageThreadId,
  }).then((result: TelegramWorkerTemporaryMessageResult | undefined): void => {
    if (result === undefined || !("messageId" in result)) return;
    const sentMessageId: number = result.messageId;
    if (botInfoState.current && isReplyGenerationCurrent(chatId, generation)) {
      recordChatMessage(buildSelfRecordMessage({
        chatId,
        self: botInfoState.current,
        messageId: sentMessageId,
        text: RATE_LIMIT_NOTICE_TEXT,
      }));
    }
  });
  trackReplyGenerationTask(chatId, generation, task);
}
