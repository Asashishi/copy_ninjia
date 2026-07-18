import { Api, InlineKeyboard } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import { markSelfSent } from "../selfSentTracker";
import { bot, logApiError } from "./client";

/** 发送纯文本消息；不设置 parse_mode，避免用户内容形成格式或链接注入。 */
export async function sendMessage(chatId: number, text: string, replyToMessageId?: number, api: Api = bot.api, keyboard?: InlineKeyboard): Promise<number | undefined> {
  try {
    const sent = await api.sendMessage(chatId, text, {
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    markSelfSent(chatId, sent.message_id);
    return sent.message_id;
  } catch (error: unknown) {
    logApiError("send message", error);
    return undefined;
  }
}

export async function sendTypingAction(chatId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.sendChatAction(chatId, "typing");
    return true;
  } catch (error: unknown) {
    logApiError("send typing action", error);
    return false;
  }
}

export async function sendChooseStickerAction(chatId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.sendChatAction(chatId, "choose_sticker");
    return true;
  } catch (error: unknown) {
    logApiError("send choose sticker action", error);
    return false;
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string, showAlert: boolean = false, api: Api = bot.api): Promise<void> {
  try {
    await api.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert });
  } catch (error: unknown) {
    logApiError("answer callback query", error);
  }
}

export async function sendSticker(chatId: number, fileId: string, api: Api = bot.api): Promise<number | undefined> {
  try {
    const sent = await api.sendSticker(chatId, fileId);
    markSelfSent(chatId, sent.message_id);
    return sent.message_id;
  } catch (error: unknown) {
    logApiError("send sticker", error);
    return undefined;
  }
}

/** 设置一个标准 emoji 反应，覆盖机器人在该消息上已有的反应。 */
export async function setMessageReaction(chatId: number, messageId: number, emoji: string, api: Api = bot.api): Promise<void> {
  try {
    await api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] }]);
  } catch (error: unknown) {
    logApiError("set message reaction", error);
  }
}

export async function deleteMessage(chatId: number, messageId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.deleteMessage(chatId, messageId);
    return true;
  } catch (error: unknown) {
    logApiError("delete message", error);
    return false;
  }
}

/** 延迟删除用于公告清理，不让这类美化任务阻止进程退出。 */
export function deleteMessageAfter(chatId: number, messageId: number, delayMs: number, api: Api = bot.api): void {
  setTimeout(() => {
    void deleteMessage(chatId, messageId, api);
  }, delayMs).unref();
}

/** 原子地将成员移出群聊但不加入封禁名单。 */
export async function kickChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.unbanChatMember(chatId, userId);
    return true;
  } catch (error: unknown) {
    logApiError(`kick chat member (chat ${chatId}, user ${userId})`, error);
    return false;
  }
}

export async function banChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.banChatMember(chatId, userId);
    return true;
  } catch (error: unknown) {
    logApiError(`ban chat member (chat ${chatId}, user ${userId})`, error);
    return false;
  }
}

/** 查询失败按非成员处理，避免在未确认时生成“已踢出”的错误战报。 */
export async function isChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId);
    if (member.status === "restricted") return member.is_member;
    return member.status === "creator" || member.status === "administrator" || member.status === "member";
  } catch (error: unknown) {
    logApiError(`check chat membership (chat ${chatId}, user ${userId})`, error);
    return false;
  }
}

export async function banChatSenderChat(chatId: number, senderChatId: number, api: Api = bot.api): Promise<boolean> {
  try {
    await api.banChatSenderChat(chatId, senderChatId);
    return true;
  } catch (error: unknown) {
    logApiError(`ban sender chat (chat ${chatId}, sender chat ${senderChatId})`, error);
    return false;
  }
}

export async function copyMessage(chatId: number, fromChatId: number, messageId: number): Promise<number | undefined> {
  try {
    const copied = await bot.api.copyMessage(chatId, fromChatId, messageId);
    markSelfSent(chatId, copied.message_id);
    return copied.message_id;
  } catch (error: unknown) {
    logApiError("copy message", error);
    return undefined;
  }
}
