import type { Animation, Message, MessageEntity, PhotoSize } from "@grammyjs/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/media";
import { FALLBACK_CHANNEL_NAME, FALLBACK_SPEAKER_NAME } from "../../consts/auto";

/** 一条消息在 AI 转录中使用的发送者身份。 */
export interface MessageSpeaker {
  id: number;
  firstName: string;
  lastName: string;
  username?: string;
}

/**
 * 解析发言人的稳定身份字段。sender_chat 优先于 from，使频道马甲和匿名管理
 * 身份与群内实际展示一致；频道帖没有 sender_chat 时退回频道自身。
 */
export function resolveSpeaker(message: Message): MessageSpeaker {
  const fromUser = message.from;
  const senderChat = message.sender_chat ?? (message.chat.type === "channel" ? message.chat : undefined);
  if (senderChat) {
    return {
      id: senderChat.id,
      firstName: ("title" in senderChat ? senderChat.title : undefined) ?? FALLBACK_CHANNEL_NAME,
      lastName: "",
      username: senderChat.username,
    };
  }
  if (fromUser) {
    return { id: fromUser.id, firstName: fromUser.first_name ?? "", lastName: fromUser.last_name ?? "", username: fromUser.username };
  }
  return { id: 0, firstName: FALLBACK_SPEAKER_NAME, lastName: "" };
}

/** 文本与媒体 caption 共用的 entity 来源。 */
function messageEntitySource(message: Message): { text: string; entities: MessageEntity[] } | null {
  if (typeof message.text === "string" && message.entities) {
    return { text: message.text, entities: message.entities };
  }
  if (typeof message.caption === "string" && message.caption_entities) {
    return { text: message.caption, entities: message.caption_entities };
  }
  return null;
}

/** 只按 Telegram entity 精确识别 `@机器人用户名`，不做字符串子串匹配。 */
export function isBotMentioned(message: Message, botUsername: string | undefined): boolean {
  if (!botUsername) return false;
  const source = messageEntitySource(message);
  if (!source) return false;
  const target: string = `@${botUsername}`.toLowerCase();
  for (const entity of source.entities) {
    if (entity.type !== "mention") continue;
    const mentionText: string = source.text.substring(entity.offset, entity.offset + entity.length);
    if (mentionText.toLowerCase() === target) return true;
  }
  return false;
}

/**
 * 判断消息是否提及机器人以外的用户。显式 `@username` 和 Telegram 的隐藏
 * 用户名提及 `text_mention` 都会阻止随机 AI 插话；同时提及机器人时仍由
 * 调用方的直接触发分支优先处理。
 */
export function mentionsOtherUser(message: Message, botId: number, botUsername: string | undefined): boolean {
  const source = messageEntitySource(message);
  if (!source) return false;
  const botTarget: string | undefined = botUsername ? `@${botUsername}`.toLowerCase() : undefined;
  for (const entity of source.entities) {
    if (entity.type === "mention") {
      const mentionText: string = source.text.substring(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mentionText !== botTarget) return true;
    }
    if (entity.type === "text_mention" && entity.user.id !== botId) return true;
  }
  return false;
}

/** 消息在群里显示的发送者 id；拿不到时返回 undefined，不伪造相等关系。 */
function visibleSenderId(message: Message): number | undefined {
  return message.sender_chat?.id ??
    (message.chat.type === "channel" ? message.chat.id : message.from?.id);
}

/** 判断当前消息是否回复同一个可见发送者先前的消息。 */
export function isReplyToSelf(message: Message): boolean {
  const repliedTo: Message | undefined = message.reply_to_message;
  if (!repliedTo) return false;
  const senderId: number | undefined = visibleSenderId(message);
  return senderId !== undefined && senderId === visibleSenderId(repliedTo);
}

/**
 * 从 Telegram 按分辨率升序返回的 photo 档位中挑最大且未声明超限的一档；
 * 全部超限时仍退回最小档，由下载侧的真实字节上限做最终防护。
 */
export function pickPhotoFile(sizes: PhotoSize[]): { fileId: string; fileUniqueId: string } {
  for (let i = sizes.length - 1; i >= 0; i--) {
    const size: PhotoSize = sizes[i]!;
    if (!size.file_size || size.file_size <= MEDIA_MAX_DOWNLOAD_BYTES) {
      return { fileId: size.file_id, fileUniqueId: size.file_unique_id };
    }
  }
  return { fileId: sizes[0]!.file_id, fileUniqueId: sizes[0]!.file_unique_id };
}

/** GIF 只分析 Telegram 缩略图，缓存键仍使用 animation 自身的唯一 id。 */
export function pickAnimationVisionSource(animation: Animation): { fileId: string; fileUniqueId: string } | null {
  const thumbnailFileId: string | undefined = animation.thumbnail?.file_id;
  if (!thumbnailFileId) return null;
  return { fileId: thumbnailFileId, fileUniqueId: animation.file_unique_id };
}

/** 随机复读前过滤没有可复制载荷的服务消息。 */
export function hasCopyableContent(message: Message): boolean {
  return !!(
    message.text || message.caption || message.photo || message.sticker ||
    message.animation || message.video || message.video_note || message.audio ||
    message.voice || message.document || message.dice || message.contact ||
    message.location || message.venue || message.poll || message.story
  );
}
