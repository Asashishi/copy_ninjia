import {
  deleteMessageAfter,
  sendMessage,
} from "./actions";
import type { SendMessageParams } from "./actions";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";
import type { TelegramApi } from "../../types/telegramWorker";

/**
 * 命令文本发送参数。群聊默认自动清理；`preserveInGroup` 只允许用于用户明确授权
 * 长期保留的内容，当前是 `/permission help` 和成功的中文动作命令结果。
 * gag 开始提示属于会话状态，直接走 sendMessage，不进入此命令清理边界。
 */
export interface SendCommandMessageParams extends Omit<SendMessageParams, "api"> {
  api?: Pick<TelegramApi, "sendMessage" | "deleteMessage" | "deleteMessages">;
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
  if (params.chatId >= 0 || preserveInGroup) return sendMessage(params);
  const callerOnSent: SendMessageParams["onSent"] = params.onSent;
  return sendMessage({
    ...params,
    // 删除 owner 必须在拿到 id 的同步时点认领；远端成功后 update
    // 若立即 abort，runTelegramAction 会丢掉返回值，但不能丢掉已发消息的清理责任。
    onSent: (messageId: number): void => {
      deleteMessageAfter({
        chatId: params.chatId,
        messageId,
        delayMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
        api: params.api,
      });
      callerOnSent?.(messageId);
    },
  });
}
