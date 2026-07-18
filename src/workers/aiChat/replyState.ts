import {
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  RATE_LIMIT_NOTICE_TEXT,
} from "../../consts/aiChat/rateLimit";
import {
  rateLimitNoticeTimes,
  cachedReplyGeneration,
} from "../../cache/aiChat/replies";
import { botInfoState } from "../../cache/aiChat/identity";
import { invalidateChatRuntimeCache } from "../../cache/aiChat/index";
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

/** 使在途回复失效，并丢弃该群尚未开始的排队触发和溢出提示。 */
export function invalidateChatReplies(chatId: number): void {
  invalidateChatRuntimeCache(chatId);
}

/**
 * 触发被限频或队列溢出时发送明确反馈。提示本身按群冷却，避免刷屏；发送
 * 成功后与普通 AI 回复一样登记自发消息并写入滚动记忆。
 */
export function notifyRateLimited(chatId: number, now: number, generation: number = currentReplyGeneration(chatId)): void {
  const lastNoticeTime: number = rateLimitNoticeTimes.get(chatId) ?? 0;
  if (now - lastNoticeTime < RATE_LIMIT_NOTICE_COOLDOWN_MS) return;
  rateLimitNoticeTimes.set(chatId, now);
  void sendMessage(chatId, RATE_LIMIT_NOTICE_TEXT).then((sentMessageId: number | undefined) => {
    if (sentMessageId === undefined) return;
    self.postMessage({ type: "sent", chatId, messageId: sentMessageId } satisfies AiSentMessage);
    if (botInfoState.current && isReplyGenerationCurrent(chatId, generation)) {
      recordChatMessage(chatId, botInfoState.current.id, botInfoState.current.first_name, "", botInfoState.current.username, RATE_LIMIT_NOTICE_TEXT);
    }
  });
}
