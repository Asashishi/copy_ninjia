import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { sanitizeInline, stripLeadingAtSigns, truncateInline } from "../../libs/text";
import { formatTokyoTime } from "../../libs/time";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";
import type { AiRecordContext, AiReplyReference } from "../../types/aiChat/protocol";

/**
 * 主线程的原始引用进入滚动记忆前统一清洗、限长。
 *
 * 可选字段全部写出来、缺省显式 undefined，不用条件展开：这一族对象要长期留在
 * 逐字缓存里，被 chatTranscript.ts 每次拼提示词读满一轮，形状必须恒定
 * （见 types/aiChat/memory.ts）。空串仍归一成 undefined，下游「有值才拼标记」
 * 的判断逐字不变；落盘也不变——JSON.stringify 本来就丢弃值为 undefined 的键。
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
 * 字段顺序即隐藏类顺序，且与 normalizeHydratedBufferedMessage 必须逐字一致
 * ——恢复出来的旧快照要和新收到的消息落在同一个隐藏类上，否则转录渲染在
 * 重启后的头几百条消息里会一直读两种形状。
 */
export function buildBufferedMessage(
  source: AiRecordContext,
  text: string,
  now: number = Date.now()
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
    at: formatTokyoTime(now),
  };
}

/**
 * 把 JSON.parse 出来的历史快照条目重建成与 buildBufferedMessage 完全同形的对象。
 *
 * 落盘 JSON 里缺省字段是**不存在**的键（stringify 丢 undefined），因此
 * `JSON.parse` 产出的隐藏类完全取决于那条记录当初有没有 username/replyTo/
 * forwardedFrom——恢复一个群就可能同时灌进四五种形状，而它们随后要和新消息
 * 混在同一个 deque 里被转录逐条读。这里按固定顺序重建一遍，代价只在启动恢复
 * 时按条付一次。
 *
 * 只做形状归一，不做清洗：快照里的内容在写入时已经过 sanitizeInline，重复清洗
 * 既无必要，也会让「恢复后的正文」与落盘内容不再逐字相等。
 */
export function normalizeHydratedBufferedMessage(message: BufferedMessage): BufferedMessage {
  const replyTo: BufferedReplyReference | undefined = message.replyTo;
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
  };
}
