import {
  RATE_LIMIT_NOTICE_COOLDOWN_MS,
  RATE_LIMIT_NOTICE_TEXT,
} from "../../consts/aiChat/rateLimit";
import {
  rateLimitNoticeTimes,
} from "../../cache/workers/aiChat/replies";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { buildSelfRecordContext } from "../../aiChat/ai/utils/selfRecord";
import { sendMessage } from "../../infra/telegram";
import type { AiSentMessage } from "../../types/aiChat/protocol";
import { recordChatMessage } from "./rollingMemory";
import {
  currentReplyGeneration,
  isReplyGenerationCurrent,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyGeneration";

declare const self: Worker;

export {
  currentReplyGeneration,
  invalidateChatReplies,
  isReplyGenerationCurrent,
  replyGenerationSignal,
  trackReplyGenerationTask,
} from "./replyGeneration";

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
