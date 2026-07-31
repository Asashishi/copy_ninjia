import {
  deleteMessageAfter,
  sendMessage,
} from "./actions";
import type { SendMessageParams } from "./actions";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";

/**
 * 命令文本发送参数。群聊默认自动清理；`preserveInGroup` 只允许用于产品明确要求
 * 长期保留的命令说明，当前唯一例外是 `/permission help`。
 */
export interface SendCommandMessageParams extends SendMessageParams {
  preserveInGroup?: boolean;
}

/**
 * 发送命令相关文本。Telegram 群组、超级群和频道的 chat id 都是负数；在这些
 * 会话里发送成功后统一安排 30 秒清理，私聊消息保持原样。
 */
export async function sendCommandMessage({
  preserveInGroup = false,
  ...params
}: SendCommandMessageParams): Promise<number | undefined> {
  const messageId: number | undefined = await sendMessage(params);
  if (
    messageId !== undefined &&
    params.chatId < 0 &&
    !preserveInGroup
  ) {
    deleteMessageAfter({
      chatId: params.chatId,
      messageId,
      delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
      api: params.api,
    });
  }
  return messageId;
}
