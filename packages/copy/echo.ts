import type { Message } from "grammy/types";
import { copyMessage } from "../infra/telegram";
import { containsRenderableCommand } from "../libs/renderableCommand";

/** 普通复制的共用发送参数；翻译同语种和非纯文本路径直接复用此出口。 */
export interface CopyEchoMessageParams {
  readonly chatId: number;
  readonly message: Message;
  readonly messageThreadId?: number;
}

/** 原样复制消息，保留实体和话题，并拒绝含可渲染命令的原文。 */
export async function copyEchoMessage({
  chatId,
  message,
  messageThreadId,
}: CopyEchoMessageParams): Promise<string | undefined> {
  if (containsRenderableCommand(message.text ?? message.caption ?? "")) return undefined;
  const copiedMessageId: number | undefined = await copyMessage({
    chatId,
    fromChatId: chatId,
    messageId: message.message_id,
    messageThreadId,
  });
  return copiedMessageId !== undefined && typeof message.text === "string" ? message.text : undefined;
}
