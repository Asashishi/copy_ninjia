import type { Animation, Message, MessageEntity, MessageOrigin, PhotoSize, User, Chat } from "@grammyjs/types";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/media";
import { FALLBACK_CHANNEL_NAME, FALLBACK_SPEAKER_NAME } from "../../consts/auto";
import { visibleSenderChat } from "../../users/visibleSender";
import type { TelegramVisionSource } from "../../types/media";
import type { AiReplyReference } from "../../types/aiChat/protocol";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { MentionFacts } from "../../types/auto";

/**
 * 解析发言人的稳定身份字段。sender_chat 优先于 from，使频道马甲和匿名管理
 * 身份与群内实际展示一致；频道帖没有 sender_chat 时退回频道自身（判定见
 * users/visibleSender.ts，与 users/senderIdentity.ts 共用）。
 */
export function resolveSpeaker(message: Message): AiSpeakerSnapshot {
  const fromUser: User | undefined = message.from;
  const senderChat: Chat | undefined = visibleSenderChat(message);
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

/**
 * 一次遍历实体数组同时判定两个提及事实——createMessageTriggerContext 对每条
 * 消息都要两者，合并解析避免对同一条消息的 entities 重复扫两遍。
 */
export function resolveMentionFacts(message: Message, botId: number, botUsername: string | undefined): MentionFacts {
  const facts: MentionFacts = { isMentioned: false, hasOtherMention: false };
  const source: { text: string; entities: MessageEntity[]; } | null = messageEntitySource(message);
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

/** 把 forward_origin 的四种来源统一整理成转录可读的身份标注，标记词汇与
 * 转录行一致（[id:]/[username:@]，缺失时省略）；隐藏账号的来源只有显示名。 */
function forwardOriginLabel(origin: MessageOrigin): string {
  switch (origin.type) {
    case "user": {
      const user: User = origin.sender_user;
      const name: string = [user.first_name, user.last_name].filter((part: string | undefined): boolean => !!part).join(" ").trim() || FALLBACK_SPEAKER_NAME;
      return `[id:${user.id}]${user.username ? ` [username:@${user.username}]` : ""} ${name}`;
    }
    case "hidden_user":
      return origin.sender_user_name || FALLBACK_SPEAKER_NAME;
    case "chat": {
      const senderChat: Chat = origin.sender_chat;
      const title: string = ("title" in senderChat ? senderChat.title : undefined) ?? FALLBACK_CHANNEL_NAME;
      const username: string | undefined = "username" in senderChat ? senderChat.username : undefined;
      return `[id:${senderChat.id}]${username ? ` [username:@${username}]` : ""} ${title}`;
    }
    case "channel":
      return `频道 [id:${origin.chat.id}]${origin.chat.username ? ` [username:@${origin.chat.username}]` : ""} ${origin.chat.title}`;
  }
}

/** 提取当前消息的转发来源标注；非转发消息返回 undefined。关联频道帖自动
 * 转进讨论组的副本（is_automatic_forward）也不标：其转录发言人已解析为频道
 * 本身（见 users/visibleSender.ts），再标「转发自」同一频道只是逐条噪音。 */
export function resolveForwardOrigin(message: Message): string | undefined {
  const origin: MessageOrigin | undefined = message.forward_origin;
  if (origin === undefined || message.is_automatic_forward === true) return undefined;
  return forwardOriginLabel(origin);
}

/** 把被回复的 Telegram 消息转换成模型可读的单行正文；视觉内容会在原消息
 * 自己进入缓存时异步获得描述，这里的类型标签负责旧消息已滑出缓存时兜底。 */
function replyReferenceText(message: Message): string {
  if (typeof message.text === "string") return message.text;
  const caption: string = typeof message.caption === "string" ? ` ${message.caption}` : "";
  if (message.photo) return `[图片]${caption}`;
  if (message.sticker) return `[贴纸${message.sticker.emoji ? `：${message.sticker.emoji}` : ""}]`;
  if (message.animation) return `[GIF]${caption}`;
  if (message.video) return `[视频]${caption}`;
  if (message.video_note) return "[视频消息]";
  if (message.voice) return `[语音]${caption}`;
  if (message.audio) return `[音频]${caption}`;
  if (message.document) return `[文件${message.document.file_name ? `：${message.document.file_name}` : ""}]${caption}`;
  if (message.poll) return `[投票：${message.poll.question}]`;
  if (message.dice) return `[骰子：${message.dice.emoji} ${message.dice.value}]`;
  if (message.contact) return `[联系人：${message.contact.first_name}${message.contact.last_name ? ` ${message.contact.last_name}` : ""}]`;
  if (message.venue) return `[地点：${message.venue.title}]`;
  if (message.location) return "[位置]";
  return "[非文本消息]";
}

/** 提取当前消息的显式回复关系。Telegram 已在 reply_to_message 中附带原消息，
 * 因此无需额外 API 请求；quote 则保留用户选中的精确引用片段。 */
export function resolveReplyReference(message: Message): AiReplyReference | undefined {
  const repliedTo: Message | undefined = message.reply_to_message;
  if (!repliedTo) return undefined;
  const speaker: AiSpeakerSnapshot = resolveSpeaker(repliedTo);
  const forwardedFrom: string | undefined = resolveForwardOrigin(repliedTo);
  return {
    messageId: repliedTo.message_id,
    id: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    ...(speaker.username ? { username: speaker.username } : {}),
    text: replyReferenceText(repliedTo),
    ...(message.quote?.text ? { quote: message.quote.text } : {}),
    ...(forwardedFrom ? { forwardedFrom } : {}),
  };
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

/** GIF 只分析 Telegram 缩略图，缓存键仍使用 animation 自身的唯一 id。 */
export function pickAnimationVisionSource(animation: Animation): TelegramVisionSource | null {
  const thumbnail: PhotoSize | undefined = animation.thumbnail;
  if (!thumbnail) return null;
  return {
    fileId: thumbnail.file_id,
    fileUniqueId: animation.file_unique_id,
    width: thumbnail.width,
    height: thumbnail.height,
  };
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
