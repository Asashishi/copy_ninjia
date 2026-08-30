/** 主线程临时群提示组合能力：发送成功与统一延迟删除登记不可拆开确认。 */

import { deleteMessageAfter } from "./actions/messageLifecycle";
import { sendMessage } from "./actions/messages";
import type { TelegramWorkerTemporaryMessageSentResult } from "../../types/telegramWorker";

export interface SendTemporaryMessageOnMainParams {
  readonly chatId: number;
  readonly text: string;
  readonly deleteAfterMs: number;
  readonly signal: AbortSignal;
}

/**
 * 复用统一发送与延迟删除边界；返回成功前，message_id 已被主线程删除 owner
 * 认领。远端发送失败返回 undefined，删除登记失败则留在发送动作的统一错误边界。
 */
export async function sendTemporaryMessageOnMain({
  chatId,
  text,
  deleteAfterMs,
  signal,
}: SendTemporaryMessageOnMainParams): Promise<TelegramWorkerTemporaryMessageSentResult | undefined> {
  let result: TelegramWorkerTemporaryMessageSentResult | undefined;
  const messageId: number | undefined = await sendMessage({
    chatId,
    text,
    signal,
    onSent: (sentMessageId: number): void => {
      const sentAt: number = Date.now();
      deleteMessageAfter({
        chatId,
        messageId: sentMessageId,
        delayMs: deleteAfterMs,
        batchOnFlush: true,
      });
      result = { messageId: sentMessageId, sentAt };
    },
  });
  return messageId === undefined ? undefined : result;
}
