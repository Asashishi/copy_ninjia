import type { Animation, Message, MessageEntity, PhotoSize } from "@grammyjs/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/media";
import { FALLBACK_CHANNEL_NAME, FALLBACK_SPEAKER_NAME } from "../../consts/auto";
import { visibleSenderChat } from "../../users/visibleSender";

/** 一条消息在 AI 转录中使用的发送者身份。 */
export interface MessageSpeaker {
  id: number;
  firstName: string;
  lastName: string;
  username?: string;
}

/**
 * 解析发言人的稳定身份字段。sender_chat 优先于 from，使频道马甲和匿名管理
 * 身份与群内实际展示一致；频道帖没有 sender_chat 时退回频道自身（判定见
 * users/visibleSender.ts，与 users/senderIdentity.ts 共用）。
 */
export function resolveSpeaker(message: Message): MessageSpeaker {
  const fromUser = message.from;
  const senderChat = visibleSenderChat(message);
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

/** 提及相关的两个触发事实，见 resolveMentionFacts。 */
export interface MentionFacts {
  /** 消息里 @ 到了机器人自己（只按 Telegram entity 精确识别，不做子串匹配）。 */
  isMentioned: boolean;
  /** 消息提及了机器人以外的用户：显式 `@username` 和 Telegram 的隐藏用户名
   *  提及 `text_mention` 都算，会阻止随机 AI 插话；同时提及机器人时仍由
   *  调用方的直接触发分支优先处理。 */
  hasOtherMention: boolean;
}

/**
 * 一次遍历实体数组同时判定两个提及事实——createMessageTriggerContext 对每条
 * 消息都要两者，合并解析避免对同一条消息的 entities 重复扫两遍。
 */
export function resolveMentionFacts(message: Message, botId: number, botUsername: string | undefined): MentionFacts {
  const facts: MentionFacts = { isMentioned: false, hasOtherMention: false };
  const source = messageEntitySource(message);
  if (!source) return facts;
  const botTarget: string | undefined = botUsername ? `@${botUsername}`.toLowerCase() : undefined;
  for (const entity of source.entities) {
    if (entity.type === "mention") {
      const mentionText: string = source.text.substring(entity.offset, entity.offset + entity.length).toLowerCase();
      if (botTarget !== undefined && mentionText === botTarget) facts.isMentioned = true;
      else facts.hasOtherMention = true;
    } else if (entity.type === "text_mention" && entity.user.id !== botId) {
      facts.hasOtherMention = true;
    }
  }
  return facts;
}

/** 只判定「@ 到机器人」单个事实的便捷形态，语义见 MentionFacts.isMentioned。 */
export function isBotMentioned(message: Message, botUsername: string | undefined): boolean {
  if (!botUsername) return false;
  // botId 只影响 hasOtherMention，这里用不到，传 0 即可。
  return resolveMentionFacts(message, 0, botUsername).isMentioned;
}

/** 只判定「提及了别人」单个事实的便捷形态，语义见 MentionFacts.hasOtherMention。 */
export function mentionsOtherUser(message: Message, botId: number, botUsername: string | undefined): boolean {
  return resolveMentionFacts(message, botId, botUsername).hasOtherMention;
}

/** 消息在群里显示的发送者 id；拿不到时返回 undefined，不伪造相等关系。 */
function visibleSenderId(message: Message): number | undefined {
  return visibleSenderChat(message)?.id ?? message.from?.id;
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
