import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { sanitizeInline, stripLeadingAtSigns, truncateInline } from "../../libs/text";
import { formatLocalTime } from "../../libs/time";
import type { BufferedMessage, BufferedReplyReference, PendingBotImage } from "../../types/aiChat/memory";
import type { AiRecordContext, AiReplyReference } from "../../types/aiChat/protocol";

/**
 * 主线程的原始引用进入滚动记忆前统一清洗、限长。
 *
 * 可选字段全部写出、缺省显式 undefined，不用条件展开，对象形状恒定
 * （见 types/aiChat/memory.ts）。空串归一成 undefined；JSON.stringify 落盘时
 * 丢弃值为 undefined 的键。
 */
export function sanitizeReplyReference(reference: AiReplyReference): BufferedReplyReference {
  const sanitizedUsername: string = stripLeadingAtSigns(sanitizeInline(reference.username ?? ""));
  const sanitizedQuote: string = truncateInline(sanitizeInline(reference.quote ?? ""), REPLY_REFERENCE_MAX_CHARS);
  const sanitizedForwardedFrom: string = sanitizeInline(reference.forwardedFrom ?? "");
  return {
    messageId: reference.messageId,
    id: reference.id,
    firstName: sanitizeInline(reference.firstName),
    lastName: sanitizeInline(reference.lastName),
    username: sanitizedUsername ? sanitizedUsername : undefined,
    text: truncateInline(sanitizeInline(reference.text), REPLY_REFERENCE_MAX_CHARS) || "[非文本消息]",
    quote: sanitizedQuote ? sanitizedQuote : undefined,
    forwardedFrom: sanitizedForwardedFrom ? sanitizedForwardedFrom : undefined,
  };
}

/**
 * 文字与媒体共用的缓存条目构造边界；返回 null 表示清洗后没有正文。
 *
 * 字段顺序与 normalizeHydratedBufferedMessage 逐字一致，恢复出来的条目与新收到的
 * 消息形状相同。
 */
export function buildBufferedMessage(
  source: AiRecordContext,
  text: string,
  now: number
): BufferedMessage | null {
  const sanitizedText: string = sanitizeInline(text);
  if (!sanitizedText) return null;
  const sanitizedUsername: string = stripLeadingAtSigns(sanitizeInline(source.username ?? ""));
  const sanitizedForwardedFrom: string = sanitizeInline(source.forwardedFrom ?? "");
  return {
    messageId: source.messageId,
    id: source.senderId,
    firstName: sanitizeInline(source.firstName),
    lastName: sanitizeInline(source.lastName),
    username: sanitizedUsername ? sanitizedUsername : undefined,
    text: sanitizedText,
    replyTo: source.replyTo ? sanitizeReplyReference(source.replyTo) : undefined,
    forwardedFrom: sanitizedForwardedFrom ? sanitizedForwardedFrom : undefined,
    at: formatLocalTime(now),
    pendingImage: undefined,
  };
}

/**
 * 把 JSON.parse 出来的快照条目重建成与 buildBufferedMessage 同形的对象。
 *
 * 落盘 JSON 里缺省字段是**不存在**的键（stringify 丢 undefined），这里按固定顺序
 * 补齐 username/replyTo/forwardedFrom/pendingImage，只在启动恢复时按条执行。
 *
 * 只做形状归一，不做清洗：快照里的内容在写入时已经过 sanitizeInline，恢复后的正文
 * 与落盘内容逐字相等。
 */
export function normalizeHydratedBufferedMessage(message: BufferedMessage): BufferedMessage {
  const replyTo: BufferedReplyReference | undefined = message.replyTo;
  const pendingImage: PendingBotImage | undefined = message.pendingImage;
  return {
    messageId: message.messageId,
    id: message.id,
    firstName: message.firstName,
    lastName: message.lastName,
    username: message.username,
    text: message.text,
    replyTo: replyTo === undefined ? undefined : {
      messageId: replyTo.messageId,
      id: replyTo.id,
      firstName: replyTo.firstName,
      lastName: replyTo.lastName,
      username: replyTo.username,
      text: replyTo.text,
      quote: replyTo.quote,
      forwardedFrom: replyTo.forwardedFrom,
    },
    forwardedFrom: message.forwardedFrom,
    at: message.at,
    pendingImage: pendingImage === undefined ? undefined : {
      origin: pendingImage.origin,
      caption: pendingImage.caption,
    },
  };
}
