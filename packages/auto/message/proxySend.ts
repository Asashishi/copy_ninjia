import { chatAtmosphere } from "../../infra/atmosphere";
import type { Message } from "grammy/types";
import { SUPER_ADMIN_USER_ID } from "../../config/bot";
import {
  disableChatStateSwitch,
  getActiveProxySendTarget,
  persistChatState,
} from "../../infra/storage/stateStore";
import { copyMessage, sendMessage } from "../../infra/telegram";
import { handleProxyTtsRequest, parseProxyTtsRequest } from "./proxyTts";
import type { ProxyTtsRequest } from "../../types/proxySend";

/**
 * 私聊只消费超级管理员当前活动的 /send 中转会话。整条代码块形式的 TTS 请求交给
 * ./proxyTts.ts 合成语音代发，其余消息原样复制到目标群。
 */
export async function handlePrivateProxySend(message: Message): Promise<void> {
  if (message.chat.type !== "private" || message.from?.id !== SUPER_ADMIN_USER_ID) return;
  const targetChatId: number | undefined = getActiveProxySendTarget();
  if (targetChatId === undefined) return;

  const ttsRequest: ProxyTtsRequest = parseProxyTtsRequest(message);
  if (ttsRequest.kind !== "none") {
    await handleProxyTtsRequest(message, targetChatId, ttsRequest);
    return;
  }

  // 中转的目标是整个群，不是群里某个话题：`/send <群id>` 从来没有话题这个入参，
  // 落进 General 正是它本来的语义。
  const copiedMessageId: number | undefined = await copyMessage({
    chatId: targetChatId,
    fromChatId: message.chat.id,
    messageId: message.message_id,
  });
  if (copiedMessageId !== undefined) return;

  // 转发失败立即结束会话，避免后续私聊消息继续被静默吞掉。
  disableChatStateSwitch(targetChatId, "isProxySendEnabled");
  await persistChatState(targetChatId, "proxy send failed");
  await sendMessage({
    chatId: message.chat.id,
    text: chatAtmosphere(targetChatId).NOTICE_TEXTS.proxyFailed(targetChatId),
  });
}
