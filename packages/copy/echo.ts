import type { Message } from "grammy/types";
import { copyMessage, sendMessage } from "../infra/telegram";

/** sendEchoPayload 的入参。 */
export interface SendEchoPayloadParams {
  readonly chatId: number;
  /** 原消息；决定按哪种载荷发送，并提供复制源与原样沿用的展示参数。 */
  readonly message: Message;
  /**
   * 处理后要发出的文字：纯文字消息的正文，或媒体的新图注；undefined 表示原消息没有文字。
   * 可渲染命令守卫与长度上限都由调用方在交来之前判定。
   */
  readonly text: string | undefined;
  /** 论坛话题；复读与翻译不挂回复，必须显式带上。 */
  readonly messageThreadId?: number;
}

/**
 * 复读、随机复读与翻译的唯一出口；本机不下载任何文件。
 * - 纯文字消息：按字符串 `sendMessage`，不带实体、不设 parse_mode（链接与 @username 由
 *   Telegram 重新识别），原消息的 link_preview_options 原样沿用。
 * - 付费媒体：Telegram 不允许复制，只发文字；没有文字就不发。
 * - 其余消息一律 `copyMessage`：有文字时用 `caption` 换成处理后的文字，并照原消息传
 *   show_caption_above_media 与视频起播时间；文件、缩略图、剧透与封面由 Telegram 在服务端
 *   原样复制。没有文字的媒体与投票、骰子这类消息原样复制。
 * @returns 是否发送成功。
 */
export async function sendEchoPayload({ chatId, message, text, messageThreadId }: SendEchoPayloadParams): Promise<boolean> {
  if (typeof message.text === "string") {
    if (text === undefined) return false;
    return await sendMessage({ chatId, text, messageThreadId, linkPreviewOptions: message.link_preview_options }) !== undefined;
  }
  if (message.paid_media !== undefined) {
    return text === undefined ? false : await sendMessage({ chatId, text, messageThreadId }) !== undefined;
  }
  return await copyMessage({
    chatId,
    fromChatId: chatId,
    messageId: message.message_id,
    messageThreadId,
    caption: text,
    showCaptionAboveMedia: text === undefined ? undefined : message.show_caption_above_media,
    videoStartTimestamp: message.video?.start_timestamp,
  }) !== undefined;
}
