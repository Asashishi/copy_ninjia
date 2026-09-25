import type { Message, PhotoSize } from "grammy/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../consts/aiChat/media";
import { RANDOM_IMAGE_DOCUMENT_MIME_TYPES } from "../consts/randomImage";
import { TELEGRAM_PHOTO_MAX_ASPECT_RATIO, TELEGRAM_PHOTO_MAX_DIMENSION_SUM } from "../consts/telegram";
import type { ImageDimensions, MessageImageCandidate } from "../types/hImage";
import type { TelegramVisionSource } from "../types/media";

/**
 * 取出一条消息里能收进随机图库的那张图：图片取最大尺寸；以文件发送的图片只收
 * RANDOM_IMAGE_DOCUMENT_MIME_TYPES 里的格式。其余消息返回 undefined。纯函数，不接触缓存。
 */
export function messageImageCandidate(message: Message): MessageImageCandidate | undefined {
  const photo: Message["photo"] = message.photo;
  if (photo !== undefined && photo.length > 0) {
    const largest: NonNullable<Message["photo"]>[number] = photo[photo.length - 1]!;
    return { fileId: largest.file_id, fileUniqueId: largest.file_unique_id, fileSize: largest.file_size };
  }
  const document: Message["document"] = message.document;
  if (document?.mime_type !== undefined && RANDOM_IMAGE_DOCUMENT_MIME_TYPES.has(document.mime_type)) {
    return { fileId: document.file_id, fileUniqueId: document.file_unique_id, fileSize: document.file_size };
  }
  return undefined;
}

/**
 * 这张图的尺寸是否过得了 `sendPhoto` 的两道硬性门槛：宽高之和 ≤ 10000，长宽比
 * ≤ 20（两个方向都算，取长边除以短边）。纯函数，只比较数字。
 *
 * 两道门槛与字节上限互不蕴含：一张 12000×40 的长条 PNG 只有几十 KB，字节闸放行，
 * `sendPhoto` 照样以 PHOTO_INVALID_DIMENSIONS 拒绝。零或负的边长按不合规处理
 * ——那种值只可能来自读错的元数据。
 * @param dimensions 已读出的像素宽高。
 */
export function isSendablePhotoDimensions({ width, height }: ImageDimensions): boolean {
  if (width <= 0 || height <= 0) return false;
  if (width + height > TELEGRAM_PHOTO_MAX_DIMENSION_SUM) return false;
  const ratio: number = width >= height ? width / height : height / width;
  return ratio <= TELEGRAM_PHOTO_MAX_ASPECT_RATIO;
}

/**
 * 从 Telegram 按分辨率升序返回的 photo 档位中挑最大且未声明超限的一档；
 * 全部超限时仍退回最小档，由下载侧的真实字节上限做最终防护。
 */
export function pickPhotoFile(sizes: PhotoSize[]): TelegramVisionSource {
  for (let i: number = sizes.length - 1; i >= 0; i--) {
    const size: PhotoSize = sizes[i]!;
    if (!size.file_size || size.file_size <= MEDIA_MAX_DOWNLOAD_BYTES) {
      return { fileId: size.file_id, fileUniqueId: size.file_unique_id, width: size.width, height: size.height };
    }
  }
  const smallest: PhotoSize = sizes[0]!;
  return { fileId: smallest.file_id, fileUniqueId: smallest.file_unique_id, width: smallest.width, height: smallest.height };
}
