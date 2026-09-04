import type { Message, MessageId } from "grammy/types";
import type {
  TelegramSendResult,
} from "../../../types/telegram";
import type { TelegramApi } from "../../../types/telegramWorker";
import { markSelfSent } from "../../selfSentTracker";
import { telegramApi } from "../client";
import {
  logUnlessAborted,
  replyParametersFor,
  runTelegramAction,
  signalArgs,
} from "./core";
import { toTelegramSendResult } from "./sendResult";

type SendStickerApi = Pick<TelegramApi, "sendSticker">;
type SendPhotoApi = Pick<TelegramApi, "sendPhoto">;
type SendAudioApi = Pick<TelegramApi, "sendAudio">;

export interface SendStickerParams {
  chatId: number;
  fileId: string;
  api?: SendStickerApi;
  signal?: AbortSignal;
  /** 论坛群的话题标识；不传时 Telegram 将消息发送到 General。 */
  messageThreadId?: number;
}

export async function sendSticker({
  chatId,
  fileId,
  api = telegramApi,
  signal,
  messageThreadId,
}: SendStickerParams): Promise<number | undefined> {
  return runTelegramAction({
    action: "send sticker",
    execute: (
      requestSignal?: AbortSignal
    ): Promise<Message.StickerMessage> =>
      api.sendSticker(
        chatId,
        fileId,
        { message_thread_id: messageThreadId },
        ...signalArgs(requestSignal)
      ),
    map: (sent: Message.StickerMessage): number | undefined => {
      markSelfSent(chatId, sent.message_id);
      return sent.message_id;
    },
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

export interface SendPhotoParams {
  chatId: number;
  /** Worker 调用会转移底层 ArrayBuffer；函数返回 Promise 后不得再读取。 */
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  replyToMessageId?: number;
  api?: SendPhotoApi;
  signal?: AbortSignal;
  /** 图注须由调用方限制在 Telegram caption 长度上限内。 */
  caption?: string;
  /** 论坛群的话题标识；挂回复时也必须显式传递。 */
  messageThreadId?: number;
}

/** 从内存上传图片，登记自发消息并返回实际回复关系。 */
export async function sendPhotoWithResult({
  chatId,
  bytes,
  mimeType,
  replyToMessageId,
  api = telegramApi,
  signal,
  caption,
  messageThreadId,
}: SendPhotoParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send photo",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<Message.PhotoMessage> => {
      const extension: string = mimeType === "image/jpeg" ? "jpg" : "png";
      // 定形一次初始化，理由同 actions/messages.ts 的 sendMessageWithResult。
      const other: Parameters<SendPhotoApi["sendPhoto"]>[2] = {
        message_thread_id: messageThreadId,
        caption: caption ? caption : undefined,
        reply_parameters: replyParametersFor(replyToMessageId),
      };
      return api.sendPhoto(
        chatId,
        { bytes, fileName: `generated.${extension}` },
        other,
        ...signalArgs(requestSignal)
      );
    },
    map: (sent: Message.PhotoMessage): TelegramSendResult | undefined =>
      toTelegramSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

export interface SendAudioParams {
  chatId: number;
  /** Worker 调用会转移底层 ArrayBuffer；函数返回 Promise 后不得再读取。 */
  bytes: Uint8Array;
  /** 带真实容器扩展名的上传文件名。 */
  fileName: string;
  replyToMessageId?: number;
  api?: SendAudioApi;
  signal?: AbortSignal;
  /** 说明须由调用方限制在 Telegram caption 长度上限内。 */
  caption?: string;
  title?: string;
  performer?: string;
  duration?: number;
  /** 已满足 Telegram 尺寸和体积约束的 JPEG 封面。 */
  thumbnailBytes?: Uint8Array;
  /** 论坛群的话题标识；挂回复时也必须显式传递。 */
  messageThreadId?: number;
}

/** 从内存上传音频，登记自发消息并返回实际回复关系。 */
export async function sendAudioWithResult({
  chatId,
  bytes,
  fileName,
  replyToMessageId,
  api = telegramApi,
  signal,
  caption,
  title,
  performer,
  duration,
  thumbnailBytes,
  messageThreadId,
}: SendAudioParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send audio",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<Message.AudioMessage> => {
      // 定形一次初始化，理由同 actions/messages.ts 的 sendMessageWithResult；
      // 这里七个可选字段，条件展开会长出 2^7 = 128 种 shape。
      const other: Parameters<SendAudioApi["sendAudio"]>[2] = {
        message_thread_id: messageThreadId,
        caption: caption ? caption : undefined,
        title: title ? title : undefined,
        performer: performer ? performer : undefined,
        duration,
        thumbnail: thumbnailBytes
          ? { bytes: thumbnailBytes, fileName: "cover.jpg" }
          : undefined,
        reply_parameters: replyParametersFor(replyToMessageId),
      };
      return api.sendAudio(
        chatId,
        { bytes, fileName },
        other,
        ...signalArgs(requestSignal)
      );
    },
    map: (sent: Message.AudioMessage): TelegramSendResult | undefined =>
      toTelegramSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
}

export interface CopyMessageParams {
  chatId: number;
  fromChatId: number;
  messageId: number;
  /** 论坛群的话题标识；挂回复时也必须显式传递。 */
  messageThreadId?: number;
}

/** 复制消息并登记其自发消息标识。 */
export async function copyMessage({
  chatId,
  fromChatId,
  messageId,
  messageThreadId,
}: CopyMessageParams): Promise<number | undefined> {
  return runTelegramAction({
    action: "copy message",
    execute: (signal?: AbortSignal): Promise<MessageId> =>
      telegramApi.copyMessage(
        chatId,
        fromChatId,
        messageId,
        { message_thread_id: messageThreadId },
        ...signalArgs(signal)
      ),
    map: (copied: MessageId): number | undefined => {
      markSelfSent(chatId, copied.message_id);
      return copied.message_id;
    },
    fallback: undefined,
  });
}
