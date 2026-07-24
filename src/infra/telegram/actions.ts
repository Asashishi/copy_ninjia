import { InputFile } from "grammy";
import type { Api, InlineKeyboard } from "grammy";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import { markSelfSent } from "../selfSentTracker";
import { bot, logApiError } from "./client";
import type { TelegramSendResult } from "../../types/telegram";

interface RunTelegramActionParams<T, R> {
  action: string;
  execute: () => Promise<T>;
  map: (result: T) => R;
  fallback: R;
  shouldLogError?: (error: unknown) => boolean;
}

/**
 * 把 Telegram 动作失败归一化成调用方约定的业务结果。map 也留在同一个错误
 * 边界内，保持既有语义：成功后的结果转换或本机自发消息登记失败时同样记录
 * 对应动作并返回 fallback。这里不用 grammY 的 bot.catch：它处理的是
 * update/middleware 逃逸异常，且本项目会让该错误触发 update 重投；这些主动
 * API 调用失败属于可预期的业务结果，调用方还需要得到 false/undefined。
 */
async function runTelegramAction<T, R>({
  action,
  execute,
  map,
  fallback,
  shouldLogError,
}: RunTelegramActionParams<T, R>): Promise<R> {
  try {
    return map(await execute());
  } catch (error: unknown) {
    if (shouldLogError?.(error) !== false) logApiError(action, error);
    return fallback;
  }
}

/** 执行只关心是否成功的 Telegram 动作。 */
async function runBooleanTelegramAction(action: string, execute: () => Promise<unknown>): Promise<boolean> {
  return runTelegramAction({
    action,
    execute,
    map: (): boolean => true,
    fallback: false,
  });
}

export interface SendMessageParams {
  chatId: number;
  text: string;
  replyToMessageId?: number;
  api?: Api;
  keyboard?: InlineKeyboard;
  signal?: AbortSignal;
}

/** 发送纯文本消息并返回 Telegram 实际建立的回复关系；不设置 parse_mode，
 * 避免用户内容形成格式或链接注入。 */
export async function sendMessageWithResult({
  chatId,
  text,
  replyToMessageId,
  api = bot.api,
  keyboard,
  signal,
}: SendMessageParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send message",
    execute: async () => {
      const other: Parameters<Api["sendMessage"]>[2] = {
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
      };
      return signal === undefined
        ? api.sendMessage(chatId, text, other)
        : api.sendMessage(chatId, text, other, signal as unknown as Parameters<Api["sendMessage"]>[3]);
    },
    map: (sent): TelegramSendResult | undefined => {
      markSelfSent(chatId, sent.message_id);
      return {
        messageId: sent.message_id,
        ...(sent.reply_to_message ? { repliedToMessageId: sent.reply_to_message.message_id } : {}),
      };
    },
    fallback: undefined,
    shouldLogError: (): boolean => signal?.aborted !== true,
  });
}

/** 发送纯文本消息的兼容入口；只需要 message_id 的调用方继续使用此函数。 */
export async function sendMessage(params: SendMessageParams): Promise<number | undefined> {
  return (await sendMessageWithResult(params))?.messageId;
}

export async function sendTypingAction(chatId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction("send typing action", () => api.sendChatAction(chatId, "typing"));
}

export async function sendUploadPhotoAction(chatId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction("send upload photo action", () => api.sendChatAction(chatId, "upload_photo"));
}

export async function sendChooseStickerAction(chatId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction("send choose sticker action", () => api.sendChatAction(chatId, "choose_sticker"));
}

export interface AnswerCallbackQueryParams {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
  api?: Api;
}

export async function answerCallbackQuery({
  callbackQueryId,
  text,
  showAlert = false,
  api = bot.api,
}: AnswerCallbackQueryParams): Promise<void> {
  return runTelegramAction({
    action: "answer callback query",
    execute: () => api.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert }),
    map: (): undefined => undefined,
    fallback: undefined,
  });
}

export async function sendSticker(chatId: number, fileId: string, api: Api = bot.api): Promise<number | undefined> {
  return runTelegramAction({
    action: "send sticker",
    execute: () => api.sendSticker(chatId, fileId),
    map: (sent): number | undefined => {
      markSelfSent(chatId, sent.message_id);
      return sent.message_id;
    },
    fallback: undefined,
  });
}

export interface SendPhotoParams {
  chatId: number;
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  replyToMessageId?: number;
  api?: Api;
}

/** 从内存上传一张图片并返回 Telegram 实际建立的回复关系；不落临时文件。 */
export async function sendPhotoWithResult({
  chatId,
  bytes,
  mimeType,
  replyToMessageId,
  api = bot.api,
}: SendPhotoParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send photo",
    execute: async () => {
      const extension: string = mimeType === "image/jpeg" ? "jpg" : "png";
      return api.sendPhoto(chatId, new InputFile(bytes, `generated.${extension}`), {
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
      });
    },
    map: (sent): TelegramSendResult | undefined => {
      markSelfSent(chatId, sent.message_id);
      return {
        messageId: sent.message_id,
        ...(sent.reply_to_message ? { repliedToMessageId: sent.reply_to_message.message_id } : {}),
      };
    },
    fallback: undefined,
  });
}

/** 上传图片的兼容入口；只需要 message_id 的调用方继续使用此函数。 */
export async function sendPhoto(params: SendPhotoParams): Promise<number | undefined> {
  return (await sendPhotoWithResult(params))?.messageId;
}

export interface SetMessageReactionParams {
  chatId: number;
  messageId: number;
  emoji: string;
  api?: Api;
}

/** 设置一个标准 emoji 反应，覆盖机器人在该消息上已有的反应；仅 API 落地成功时返回 true。 */
export async function setMessageReaction({ chatId, messageId, emoji, api = bot.api }: SetMessageReactionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    "set message reaction",
    () => api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] }])
  );
}

export async function deleteMessage(chatId: number, messageId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction("delete message", () => api.deleteMessage(chatId, messageId));
}

export interface DeleteMessageAfterParams {
  chatId: number;
  messageId: number;
  delayMs: number;
  api?: Api;
}

/** 延迟删除用于公告清理，不让这类美化任务阻止进程退出。 */
export function deleteMessageAfter({ chatId, messageId, delayMs, api = bot.api }: DeleteMessageAfterParams): void {
  setTimeout(() => {
    void deleteMessage(chatId, messageId, api);
  }, delayMs).unref();
}

/** 原子地将成员移出群聊但不加入封禁名单。 */
export async function kickChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `kick chat member (chat ${chatId}, user ${userId})`,
    () => api.unbanChatMember(chatId, userId)
  );
}

export async function banChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `ban chat member (chat ${chatId}, user ${userId})`,
    () => api.banChatMember(chatId, userId)
  );
}

/** 查询失败按非成员处理，避免在未确认时生成“已踢出”的错误战报。 */
export async function isChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runTelegramAction({
    action: `check chat membership (chat ${chatId}, user ${userId})`,
    execute: () => api.getChatMember(chatId, userId),
    map: (member): boolean => {
      if (member.status === "restricted") return member.is_member;
      return member.status === "creator" || member.status === "administrator" || member.status === "member";
    },
    fallback: false,
  });
}

export async function banChatSenderChat(chatId: number, senderChatId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `ban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    () => api.banChatSenderChat(chatId, senderChatId)
  );
}

export async function copyMessage(chatId: number, fromChatId: number, messageId: number): Promise<number | undefined> {
  return runTelegramAction({
    action: "copy message",
    execute: () => bot.api.copyMessage(chatId, fromChatId, messageId),
    map: (copied): number | undefined => {
      markSelfSent(chatId, copied.message_id);
      return copied.message_id;
    },
    fallback: undefined,
  });
}
