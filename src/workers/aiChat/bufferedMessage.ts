import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { sanitizeInline, truncateInline } from "../../libs/text";
import { formatTokyoTime } from "../../libs/time";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";
import type { AiRecordContext, AiReplyReference } from "../../types/aiChat/protocol";

/** 主线程的原始引用进入滚动记忆前统一清洗、限长。 */
export function sanitizeReplyReference(reference: AiReplyReference): BufferedReplyReference {
  const sanitizedUsername: string = sanitizeInline(reference.username ?? "").replace(/^@+/, "");
  const sanitizedQuote: string = truncateInline(sanitizeInline(reference.quote ?? ""), REPLY_REFERENCE_MAX_CHARS);
  const sanitizedForwardedFrom: string = sanitizeInline(reference.forwardedFrom ?? "");
  return {
    messageId: reference.messageId,
    id: reference.id,
    firstName: sanitizeInline(reference.firstName),
    lastName: sanitizeInline(reference.lastName),
    ...(sanitizedUsername ? { username: sanitizedUsername } : {}),
    text: truncateInline(sanitizeInline(reference.text), REPLY_REFERENCE_MAX_CHARS) || "[非文本消息]",
    ...(sanitizedQuote ? { quote: sanitizedQuote } : {}),
    ...(sanitizedForwardedFrom ? { forwardedFrom: sanitizedForwardedFrom } : {}),
  };
}

/** 文字与媒体共用的缓存条目构造边界；返回 null 表示清洗后没有正文。 */
export function buildBufferedMessage(
  source: AiRecordContext,
  text: string,
  now: number = Date.now()
): BufferedMessage | null {
  const sanitizedText: string = sanitizeInline(text);
  if (!sanitizedText) return null;
  const sanitizedUsername: string = sanitizeInline(source.username ?? "").replace(/^@+/, "");
  const sanitizedForwardedFrom: string = sanitizeInline(source.forwardedFrom ?? "");
  return {
    messageId: source.messageId,
    id: source.senderId,
    firstName: sanitizeInline(source.firstName),
    lastName: sanitizeInline(source.lastName),
    ...(sanitizedUsername ? { username: sanitizedUsername } : {}),
    text: sanitizedText,
    ...(source.replyTo ? { replyTo: sanitizeReplyReference(source.replyTo) } : {}),
    ...(sanitizedForwardedFrom ? { forwardedFrom: sanitizedForwardedFrom } : {}),
    at: formatTokyoTime(now),
  };
}
