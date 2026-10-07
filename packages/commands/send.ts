import { telegramSignal } from "../libs/telegramSignal";
import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import { disableChatStateSwitch, getActiveProxySendTarget, getChatStateCache, getOrCreateChatState, persistChatState } from "../infra/storage/stateStore";
import { logApiError, sendCommandMessage } from "../infra/telegram";
import { bot } from "../infra/telegram/mainClient";
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../infra/updateContext";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import { parseChatIdArgument } from "../libs/telegramId";
import type { ChatFullInfo } from "grammy/types";

/**
 * 隐藏的超管私聊中转命令；群聊和非超管调用静默返回。只接受可达、且已经在
 * chat_states 里被纳管的 group/supergroup（本命令不新建群状态，见下方判定），
 * 会话状态存于 ChatState.isProxySendEnabled；`finish` 关闭当前中转会话。
 */
export async function handleSendCommand(ctx: CommandContext<Context>): Promise<void> {
  if (ctx.chat.type !== "private") return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;

  // 以 `ctx.from` 判定超级管理员身份，sender_chat 不参与；非本人调用静默返回。
  if (ctx.from?.id !== SUPER_ADMIN_USER_ID) return;

  const arg: string = ctx.match.trim();
  const activeTargetChatId: number | undefined = getActiveProxySendTarget();

  if (arg.toLowerCase() === "finish") {
    if (activeTargetChatId === undefined) {
      await sendCommandMessage({ chatId, text: chatAtmosphere().NOTICE_TEXTS.proxyAlreadyStopped, replyToMessageId: messageId });
      return;
    }
    disableChatStateSwitch(activeTargetChatId, "isProxySendEnabled");
    await persistChatState(activeTargetChatId, "send finished");
    await sendCommandMessage({ chatId, text: chatAtmosphere().NOTICE_TEXTS.proxyStopped, replyToMessageId: messageId });
    return;
  }

  // 目标 chat id 经 parseChatIdArgument 解析（正则 + 安全整数）。
  const targetChatId: number | undefined = parseChatIdArgument(arg);
  if (targetChatId === undefined) {
    await sendCommandMessage({ chatId, text: chatAtmosphere().NOTICE_TEXTS.proxyUsage, replyToMessageId: messageId });
    return;
  }

  if (activeTargetChatId !== undefined) {
    await sendCommandMessage({ chatId, text: chatAtmosphere().NOTICE_TEXTS.proxyAlreadyStarted(activeTargetChatId), replyToMessageId: messageId });
    return;
  }

  // 目标群必须已经在 chat_states 里，否则只回一句提示。
  //
  // 这里只读现有状态，不创建 chat_states 记录，也不触发 /init enable 的容量闸。
  // 判定在 getChat 之前，未纳管的目标不探测可达性。
  if (!getChatStateCache().has(targetChatId)) {
    await sendCommandMessage({ chatId, text: chatAtmosphere().NOTICE_TEXTS.proxyNotInitialized(targetChatId), replyToMessageId: messageId });
    return;
  }

  try {
    const signal: AbortSignal | undefined = currentUpdateAbortSignal();
    const targetChat: ChatFullInfo =
      await bot.api.getChat(targetChatId, telegramSignal(signal));
    if (targetChat.type !== "group" && targetChat.type !== "supergroup") {
      await sendCommandMessage({ chatId, text: chatAtmosphere().NOTICE_TEXTS.proxyNotGroup(targetChatId), replyToMessageId: messageId });
      return;
    }
  } catch (error: unknown) {
    throwIfUpdateAborted();
    logApiError(`resolve /send target chat ${targetChatId}`, error);
    await sendCommandMessage({ chatId, text: chatAtmosphere().NOTICE_TEXTS.proxyUnavailable(targetChatId), replyToMessageId: messageId });
    return;
  }

  getOrCreateChatState(targetChatId).isProxySendEnabled = true;
  await persistChatState(targetChatId, "send started");
  await sendCommandMessage({ chatId, text: chatAtmosphere().NOTICE_TEXTS.proxyStarted(targetChatId), replyToMessageId: messageId });
}
