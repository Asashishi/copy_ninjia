/** 主线程临时群提示组合能力：发送成功与统一延迟删除登记不可拆开确认。 */

import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";
import { deleteMessageAfter } from "./actions/messageLifecycle";
import { sendMessage } from "./actions/messages";
import type { TelegramWorkerTemporaryMessageSentResult } from "../../types/telegramWorker";

export interface SendTemporaryMessageOnMainParams {
  readonly chatId: number;
  readonly text: string;
  readonly messageThreadId?: number;
  readonly replyToMessageId?: number;
  /** Worker 请求的取消信号；主线程自己发出的播报不带。 */
  readonly signal?: AbortSignal;
}

/**
 * 复用统一发送与延迟删除边界，删除期限统一为 COMMAND_MESSAGE_AUTO_DELETE_MS；返回成功前，message_id 已被
 * 主线程删除 owner 认领。远端发送失败返回 undefined，删除登记失败则留在发送动作的统一错误边界。
 */
export async function sendTemporaryMessageOnMain({
  chatId,
  text,
  signal,
  messageThreadId,
  replyToMessageId,
}: SendTemporaryMessageOnMainParams): Promise<TelegramWorkerTemporaryMessageSentResult | undefined> {
  let result: TelegramWorkerTemporaryMessageSentResult | undefined;
  const messageId: number | undefined = await sendMessage({
    chatId,
    text,
    signal,
    messageThreadId,
    replyToMessageId,
    onSent: (sentMessageId: number): void => {
      const sentAt: number = Date.now();
      deleteMessageAfter({
        chatId,
        messageId: sentMessageId,
        delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
      });
      result = { messageId: sentMessageId, sentAt };
    },
  });
  return messageId === undefined ? undefined : result;
}
