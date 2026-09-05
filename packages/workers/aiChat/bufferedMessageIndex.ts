import { REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { chatMessageIndexes } from "../../cache/workers/aiChat/memory";
import { truncateInline } from "../../libs/text";
import type { BufferedMessage, BufferedReplyReference } from "../../types/aiChat/memory";

/**
 * 热区消息的 message_id 索引与单跳回复快照。索引本体在
 * cache/workers/aiChat/memory.ts 的 chatMessageIndexes，登记/删除只由
 * rollingMemory.ts 在消息进出热区的两个物理位置调用，保证索引内容与
 * chatBuffers 严格一致；本文件不持有任何状态。
 */

/** 消息进入热区时登记 message_id，供触发定位与单跳回复快照读取。 */
export function indexBufferedMessage(chatId: number, entry: BufferedMessage): void {
  let index: Map<number, BufferedMessage> | undefined = chatMessageIndexes.get(chatId);
  if (!index) {
    index = new Map<number, BufferedMessage>();
    chatMessageIndexes.set(chatId, index);
  }
  index.set(entry.messageId, entry);
}

/**
 * 消息被轮换移出热区时删键；整群索引空了就连外层键一并回收。
 * 仅删除仍指向当前条目的槽位，保留同 message_id 后登记的新副本。
 */
export function unindexBufferedMessage(chatId: number, entry: BufferedMessage): void {
  const index: Map<number, BufferedMessage> | undefined = chatMessageIndexes.get(chatId);
  if (!index) return;
  if (index.get(entry.messageId) !== entry) return;
  index.delete(entry.messageId);
  if (index.size === 0) chatMessageIndexes.delete(chatId);
}

/** 按 message_id 取仍在热区的消息；已滑出或从未记录过则为 undefined。 */
export function lookupBufferedMessage(chatId: number, messageId: number): BufferedMessage | undefined {
  return chatMessageIndexes.get(chatId)?.get(messageId);
}

/** 把一个缓存条目复制成可挂在新消息上的单跳回复快照；快照不共享可变正文
 * 引用，媒体回填完成后调用即可保存当时的最终描述。 */
export function replyReferenceForBufferedEntry(
  messageId: number,
  target: BufferedMessage
): BufferedReplyReference {
  return {
    messageId,
    id: target.id,
    firstName: target.firstName,
    lastName: target.lastName,
    username: target.username,
    text: truncateInline(target.text, REPLY_REFERENCE_MAX_CHARS),
    // 快照记的是「被回复的那条消息」，它自己被谁引用过与本快照无关。
    quote: undefined,
    forwardedFrom: target.forwardedFrom,
  };
}

/** 机器人自己发出回复前捕获目标快照用：把仍在热区的消息复制成单跳引用；
 * 已滑出或从未记录过则返回 undefined，由轮次携带的触发快照兜底。 */
export function replyReferenceForBufferedMessage(
  chatId: number,
  messageId: number
): BufferedReplyReference | undefined {
  const target: BufferedMessage | undefined = lookupBufferedMessage(chatId, messageId);
  return target ? replyReferenceForBufferedEntry(messageId, target) : undefined;
}
