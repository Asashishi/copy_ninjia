import type { Message } from "@grammyjs/types";
import { SUPER_ADMIN_USER_ID } from "../../config/telegram";
import {
  clearChatStateField,
  getActiveProxySendTarget,
  persistAuthoritativeState,
} from "../../infra/storage/stateStore";
import { copyMessage, sendMessage } from "../../infra/telegram";

/** 私聊只消费超级管理员当前活动的 /send 中转会话。 */
export async function handlePrivateProxySend(message: Message): Promise<void> {
  if (message.chat.type !== "private" || message.from?.id !== SUPER_ADMIN_USER_ID) return;
  const targetChatId: number | undefined = getActiveProxySendTarget();
  if (targetChatId === undefined) return;

  const copiedMessageId: number | undefined = await copyMessage(
    targetChatId,
    message.chat.id,
    message.message_id
  );
  if (copiedMessageId !== undefined) return;

  // 转发失败立即结束会话，避免后续私聊消息继续被静默吞掉。
  clearChatStateField(targetChatId, "isProxySendEnabled");
  await persistAuthoritativeState("proxy send failed");
  await sendMessage({
    chatId: message.chat.id,
    text: `转发到 ${targetChatId} 失败了，本天才先把这轮中转停掉了，检查一下再 /send 重新开吧♡`,
  });
}
