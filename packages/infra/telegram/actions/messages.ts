import { InputFile } from "grammy";
import type { Api, InlineKeyboard } from "grammy";
import type {
  Message,
  MessageEntity,
  MessageId,
} from "@grammyjs/types";
import { markSelfSent } from "../../selfSentTracker";
import { bot } from "../client";
import {
  runBooleanTelegramAction,
  runTelegramAction,
  signalArgs,
} from "./core";
import type {
  TelegramChatAction,
  TelegramSendResult,
} from "../../../types/telegram";

/**
 * 把一条已发出的消息收敛成 TelegramSendResult：登记进自发消息表（供自动流水线
 * 识别频道自回环，见 infra/selfSentTracker.ts），并带回 Telegram 实际建立的回复
 * 关系。发消息与发图片共用，两者不得各写一份。
 */
function toSendResult(
  chatId: number,
  sent: Message
): TelegramSendResult {
  markSelfSent(chatId, sent.message_id);
  return {
    messageId: sent.message_id,
    ...(sent.reply_to_message
      ? { repliedToMessageId: sent.reply_to_message.message_id }
      : {}),
  };
}

export interface SendMessageParams {
  chatId: number;
  text: string;
  replyToMessageId?: number;
  api?: Api;
  keyboard?: InlineKeyboard;
  signal?: AbortSignal;
  /** 由调用方自行算好偏移的富文本实体，见 sendMessageWithResult 的说明。 */
  entities?: readonly MessageEntity[];
  /** 是否关闭 Telegram 为正文中第一个 URL 自动生成的预览卡片。 */
  disableLinkPreview?: boolean;
}

/**
 * 发送纯文本消息并返回 Telegram 实际建立的回复关系；不设置 parse_mode，
 * 避免用户内容形成格式或链接注入。
 */
export async function sendMessageWithResult({
  chatId,
  text,
  replyToMessageId,
  api = bot.api,
  keyboard,
  signal,
  entities,
  disableLinkPreview,
}: SendMessageParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send message",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<Message.TextMessage> => {
      const other: Parameters<Api["sendMessage"]>[2] = {
        ...(replyToMessageId
          ? {
            reply_parameters: {
              message_id: replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
          : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(entities && entities.length > 0
          ? { entities: [...entities] }
          : {}),
        ...(disableLinkPreview
          ? { link_preview_options: { is_disabled: true } }
          : {}),
      };
      return api.sendMessage(
        chatId,
        text,
        other,
        ...signalArgs(requestSignal)
      );
    },
    map: (
      sent: Message.TextMessage
    ): TelegramSendResult | undefined => toSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: (
      _error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => actionSignal?.aborted !== true,
  });
}

/** 发送纯文本消息的兼容入口；只需要 message_id 的调用方继续使用此函数。 */
export async function sendMessage(
  params: SendMessageParams
): Promise<number | undefined> {
  return (await sendMessageWithResult(params))?.messageId;
}

export interface SendChatActionParams {
  chatId: number;
  /** 要显示的状态；取值由 TelegramChatAction 单点定义。 */
  action: TelegramChatAction;
  api?: Api;
  signal?: AbortSignal;
}

/** 发一次聊天状态（「正在输入…」这类）。 */
export async function sendChatAction({
  chatId,
  action,
  api = bot.api,
  signal,
}: SendChatActionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    `send ${action} action`,
    (requestSignal?: AbortSignal): Promise<true> =>
      api.sendChatAction(
        chatId,
        action,
        {},
        ...signalArgs(requestSignal)
      ),
    signal
  );
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
    execute: (signal?: AbortSignal): Promise<true> =>
      api.answerCallbackQuery(
        callbackQueryId,
        { text, show_alert: showAlert },
        ...signalArgs(signal)
      ),
    map: (): undefined => undefined,
    fallback: undefined,
  });
}

export interface SendStickerParams {
  chatId: number;
  fileId: string;
  api?: Api;
  signal?: AbortSignal;
}

export async function sendSticker({
  chatId,
  fileId,
  api = bot.api,
  signal,
}: SendStickerParams): Promise<number | undefined> {
  return runTelegramAction({
    action: "send sticker",
    execute: (
      requestSignal?: AbortSignal
    ): Promise<Message.StickerMessage> =>
      api.sendSticker(
        chatId,
        fileId,
        {},
        ...signalArgs(requestSignal)
      ),
    map: (sent: Message.StickerMessage): number | undefined => {
      markSelfSent(chatId, sent.message_id);
      return sent.message_id;
    },
    fallback: undefined,
    signal,
    shouldLogError: (
      _error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => actionSignal?.aborted !== true,
  });
}

export interface SendPhotoParams {
  chatId: number;
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  replyToMessageId?: number;
  api?: Api;
  signal?: AbortSignal;
  /**
   * 随图一起发出的图注，图和文字合成同一条消息（同一个 message_id）。
   * 长度必须由调用方压到 TELEGRAM_CAPTION_MAX_CHARS 以内——Bot API 对超长
   * caption 是整条拒绝而不是截断，这里不做兜底截断，免得悄悄吞掉正文。
   */
  caption?: string;
}

/** 从内存上传一张图片并返回 Telegram 实际建立的回复关系；不落临时文件。 */
export async function sendPhotoWithResult({
  chatId,
  bytes,
  mimeType,
  replyToMessageId,
  api = bot.api,
  signal,
  caption,
}: SendPhotoParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send photo",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<Message.PhotoMessage> => {
      const extension: string =
        mimeType === "image/jpeg" ? "jpg" : "png";
      // 与 sendMessageWithResult 一致地不设置 parse_mode：图注同样是模型或
      // 用户产出的自由文本，一旦按 HTML/Markdown 解析，正文里的 `<`、`_`
      // 就会变成格式或链接注入，并让整条发送因实体不闭合而失败。
      const other: Parameters<Api["sendPhoto"]>[2] = {
        ...(caption ? { caption } : {}),
        ...(replyToMessageId
          ? {
            reply_parameters: {
              message_id: replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
          : {}),
      };
      return api.sendPhoto(
        chatId,
        new InputFile(bytes, `generated.${extension}`),
        other,
        ...signalArgs(requestSignal)
      );
    },
    map: (
      sent: Message.PhotoMessage
    ): TelegramSendResult | undefined => toSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: (
      _error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => actionSignal?.aborted !== true,
  });
}

/** 上传图片的兼容入口；只需要 message_id 的调用方继续使用此函数。 */
export async function sendPhoto(
  params: SendPhotoParams
): Promise<number | undefined> {
  return (await sendPhotoWithResult(params))?.messageId;
}

/** 复制一条消息并登记自发消息 ID。 */
export async function copyMessage(
  chatId: number,
  fromChatId: number,
  messageId: number
): Promise<number | undefined> {
  return runTelegramAction({
    action: "copy message",
    execute: (signal?: AbortSignal): Promise<MessageId> =>
      signal === undefined
        ? bot.api.copyMessage(chatId, fromChatId, messageId)
        : bot.api.copyMessage(
          chatId,
          fromChatId,
          messageId,
          {},
          signal as unknown as Parameters<Api["copyMessage"]>[4]
        ),
    map: (copied: MessageId): number | undefined => {
      markSelfSent(chatId, copied.message_id);
      return copied.message_id;
    },
    fallback: undefined,
  });
}
