import type { Message } from "grammy/types";
import { RANDOM_IMAGE_DOCUMENT_MIME_TYPES } from "../consts/randomImage";
import type { MessageImageCandidate } from "../types/hImage";

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
