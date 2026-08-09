import type {
  InlineKeyboardMarkup,
  Message,
  MessageEntity,
  MessageId,
} from "@grammyjs/types";
import { markSelfSent } from "../../selfSentTracker";
import { telegramApi } from "../client";
import {
  runBooleanTelegramAction,
  runTelegramAction,
  signalArgs,
} from "./core";
import type {
  TelegramChatAction,
  TelegramSendResult,
} from "../../../types/telegram";
import type { TelegramApi } from "../../../types/telegramWorker";

type SendMessageApi = Pick<TelegramApi, "sendMessage">;
type EphemeralSendMessageOptions = NonNullable<
  Parameters<TelegramApi["sendMessage"]>[2]
> & {
  readonly receiver_user_id: number;
  readonly callback_query_id?: string;
};
type EphemeralSendMessageApi = Pick<TelegramApi, "sendMessage">;
type SendChatActionApi = Pick<TelegramApi, "sendChatAction">;
type AnswerCallbackQueryApi = Pick<TelegramApi, "answerCallbackQuery">;
type SendStickerApi = Pick<TelegramApi, "sendSticker">;
type SendPhotoApi = Pick<TelegramApi, "sendPhoto">;
type SendAudioApi = Pick<TelegramApi, "sendAudio">;

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
  api?: SendMessageApi;
  keyboard?: InlineKeyboardMarkup;
  signal?: AbortSignal;
  /** 由调用方自行算好偏移的富文本实体，见 sendMessageWithResult 的说明。 */
  entities?: readonly MessageEntity[];
  /** 是否关闭 Telegram 为正文中第一个 URL 自动生成的预览卡片。 */
  disableLinkPreview?: boolean;
  /** 消息 id 的同步登记点，语义见 SendEphemeralMessageParams.onSent。 */
  onSent?: (messageId: number) => void;
}

/**
 * 发送纯文本消息并返回 Telegram 实际建立的回复关系；不设置 parse_mode，
 * 避免用户内容形成格式或链接注入。
 */
export async function sendMessageWithResult({
  chatId,
  text,
  replyToMessageId,
  api = telegramApi,
  keyboard,
  signal,
  entities,
  disableLinkPreview,
  onSent,
}: SendMessageParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send message",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<Message.TextMessage> => {
      const other: Parameters<SendMessageApi["sendMessage"]>[2] = {
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
    ): TelegramSendResult | undefined => {
      const result: TelegramSendResult = toSendResult(chatId, sent);
      onSent?.(result.messageId);
      return result;
    },
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

export interface SendEphemeralMessageParams {
  chatId: number;
  receiverUserId: number;
  callbackQueryId?: string;
  text: string;
  keyboard: InlineKeyboardMarkup;
  api?: EphemeralSendMessageApi;
  signal?: AbortSignal;
  /**
   * 消息 id 的**同步**登记点：拿到 id 的那一刻立即回调，早于 runTelegramAction
   * 在发送成功之后补做的 update 取消判定（见 actions/core.ts）。
   *
   * 存在的理由只有一个：停机时 `runner.abortActive()` 可能恰好落在「远端已经
   * 收下这条消息、handler 还没走到下一行」的窗口里，此时 await 会以 AbortError
   * 解开，返回值连同 message id 一起丢失——发出去的提示从此没有任何人知道它的
   * id，状态机再也删不掉它。用它把 id 落进自己的状态，再让取消照常向上抛。
   * 回调必须是同步且不抛的：它跑在错误边界内部，抛出会被折算成发送失败。
   */
  onSent?: (messageId: number) => void;
}

/**
 * 发送目标专属临时消息。群管理员机器人可直接指定 receiver_user_id；普通机器人
 * 回应 callback 时再携带 callback_query_id。grammY 1.44 的调用器会原样透传
 * payload，但其 3.28 类型尚未声明 Bot API 10.2 的字段，因此差异只收口在这个
 * 薄适配层。返回的 ephemeral_message_id 交给业务状态机做定向删除。
 */
export async function sendEphemeralMessage({
  chatId,
  receiverUserId,
  callbackQueryId,
  text,
  keyboard,
  api = telegramApi,
  signal,
  onSent,
}: SendEphemeralMessageParams): Promise<number | undefined> {
  const other: EphemeralSendMessageOptions = {
    receiver_user_id: receiverUserId,
    ...(callbackQueryId === undefined
      ? {}
      : { callback_query_id: callbackQueryId }),
    reply_markup: keyboard,
  };
  return runTelegramAction({
    action: "send ephemeral message",
    execute: (requestSignal?: AbortSignal): ReturnType<TelegramApi["sendMessage"]> =>
      api.sendMessage(
        chatId,
        text,
        other,
        ...signalArgs(requestSignal)
      ),
    map: (sent: Message.TextMessage): number => {
      const ephemeral: Message.TextMessage & Readonly<{
        receiver_user?: Readonly<{ id: number }>;
        ephemeral_message_id?: number;
      }> = sent;
      const ephemeralMessageId: number | undefined =
        ephemeral.ephemeral_message_id;
      if (
        sent.message_id !== 0 ||
        sent.chat.id !== chatId ||
        ephemeral.receiver_user?.id !== receiverUserId ||
        ephemeralMessageId === undefined ||
        !Number.isSafeInteger(ephemeralMessageId) ||
        ephemeralMessageId <= 0
      ) {
        throw new Error("Telegram returned an invalid ephemeral message identity.");
      }
      onSent?.(ephemeralMessageId);
      return ephemeralMessageId;
    },
    fallback: undefined,
    signal,
    shouldLogError: (
      _error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => actionSignal?.aborted !== true,
  });
}

export interface SendChatActionParams {
  chatId: number;
  /** 要显示的状态；取值由 TelegramChatAction 单点定义。 */
  action: TelegramChatAction;
  api?: SendChatActionApi;
  signal?: AbortSignal;
}

/** 发一次聊天状态（「正在输入…」这类）。 */
export async function sendChatAction({
  chatId,
  action,
  api = telegramApi,
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
  api?: AnswerCallbackQueryApi;
}

export async function answerCallbackQuery({
  callbackQueryId,
  text,
  showAlert = false,
  api = telegramApi,
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
  api?: SendStickerApi;
  signal?: AbortSignal;
}

export async function sendSticker({
  chatId,
  fileId,
  api = telegramApi,
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
  /** Worker 调用会转移底层 ArrayBuffer；sendPhoto 返回 Promise 后不得再读取。 */
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  replyToMessageId?: number;
  api?: SendPhotoApi;
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
  api = telegramApi,
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
      const other: Parameters<SendPhotoApi["sendPhoto"]>[2] = {
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
        { bytes, fileName: `generated.${extension}` },
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

export interface SendAudioParams {
  chatId: number;
  /** Worker 调用会转移底层 ArrayBuffer；sendAudio 返回 Promise 后不得再读取。 */
  bytes: Uint8Array;
  /** 上传文件名，必须带与真实容器一致的扩展名——Bot API 靠它判定容器。 */
  fileName: string;
  replyToMessageId?: number;
  api?: SendAudioApi;
  signal?: AbortSignal;
  /**
   * 随音频一起发出的说明，音频和文字合成同一条消息（同一个 message_id）。
   * 长度必须由调用方压到 TELEGRAM_CAPTION_MAX_CHARS 以内——Bot API 对超长
   * caption 是整条拒绝而不是截断，这里不做兜底截断，免得悄悄吞掉正文。
   */
  caption?: string;
  /** 音频标题；Telegram 播放器把它显示成曲名。 */
  title?: string;
  /** 演唱者/作者；Telegram 播放器显示在曲名下方。 */
  performer?: string;
  /** 音频时长（秒）；不传时 Telegram 自己探测，探不到播放条上就没有进度。 */
  duration?: number;
  /**
   * 封面缩略图字节。
   *
   * 必须是 JPEG、长边 ≤320、体积 <200 kB——Bot API 的三项硬性要求，任一项不满足
   * 是**整条发送被拒**而不是不显示封面，因此压缩必须由调用方在这之前做完
   * （见 libs/image.ts 的 prepareThumbnailJpeg）。这里不做兜底转换：在发送边界上
   * 悄悄改写调用方给的字节，会让「为什么封面变糊了」变成一个查不到的问题。
   */
  /** 与音频字节相同，Worker 调用会转移所有权。 */
  thumbnailBytes?: Uint8Array;
}

/**
 * 从内存上传一段音频并返回 Telegram 实际建立的回复关系；不落临时文件。
 *
 * 走 sendAudio 而不是 sendVoice：voice 在客户端里是「语音条」（波形、按住播放、
 * 没有曲名），而这条路上发出去的是一首完整歌曲，用 audio 才会得到带曲名/演唱者
 * 的播放条，也才能被转发进音乐列表。
 */
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
}: SendAudioParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send audio",
    execute: async (
      requestSignal?: AbortSignal
    ): Promise<Message.AudioMessage> => {
      // 与 sendPhotoWithResult 一致地不设置 parse_mode：说明文字同样是模型产出的
      // 自由文本，一旦按 HTML/Markdown 解析，正文里的 `<`、`_` 就会变成格式或
      // 链接注入，并让整条发送因实体不闭合而失败。
      const other: Parameters<SendAudioApi["sendAudio"]>[2] = {
        ...(caption ? { caption } : {}),
        ...(title ? { title } : {}),
        ...(performer ? { performer } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(thumbnailBytes
          ? { thumbnail: { bytes: thumbnailBytes, fileName: "cover.jpg" } }
          : {}),
        ...(replyToMessageId
          ? {
            reply_parameters: {
              message_id: replyToMessageId,
              allow_sending_without_reply: true,
            },
          }
          : {}),
      };
      return api.sendAudio(
        chatId,
        { bytes, fileName },
        other,
        ...signalArgs(requestSignal)
      );
    },
    map: (
      sent: Message.AudioMessage
    ): TelegramSendResult | undefined => toSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: (
      _error: unknown,
      actionSignal: AbortSignal | undefined
    ): boolean => actionSignal?.aborted !== true,
  });
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
      telegramApi.copyMessage(
        chatId,
        fromChatId,
        messageId,
        {},
        ...signalArgs(signal)
      ),
    map: (copied: MessageId): number | undefined => {
      markSelfSent(chatId, copied.message_id);
      return copied.message_id;
    },
    fallback: undefined,
  });
}
