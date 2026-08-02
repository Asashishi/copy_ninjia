import { REPLY_CHAIN_MAX_DEPTH, REPLY_REFERENCE_MAX_CHARS } from "../../consts/aiChat/memory";
import { chatReplyChainIndexes } from "../../cache/workers/aiChat/memory";
import { truncateInline } from "../../libs/text";
import type { BufferedMessage, BufferedReplyReference, ReplyChainLink } from "../../types/aiChat/memory";

/**
 * 热区消息的 message_id 索引与多层回复链回溯。索引本体在
 * cache/workers/aiChat/memory.ts 的 chatReplyChainIndexes，登记/删除只由
 * rollingMemory.ts 在消息进出热区的两个物理位置调用，保证索引内容与
 * chatBuffers 严格一致；本文件不持有任何状态。
 */

/** 消息进入热区时登记 message_id，供回复链回溯。 */
export function indexBufferedMessage(chatId: number, entry: BufferedMessage): void {
  let index: Map<number, BufferedMessage> | undefined = chatReplyChainIndexes.get(chatId);
  if (!index) {
    index = new Map<number, BufferedMessage>();
    chatReplyChainIndexes.set(chatId, index);
  }
  index.set(entry.messageId, entry);
}

/** 消息被轮换移出热区时删键；整群索引空了就连外层键一并回收。 */
export function unindexBufferedMessage(chatId: number, entry: BufferedMessage): void {
  const index: Map<number, BufferedMessage> | undefined = chatReplyChainIndexes.get(chatId);
  if (!index) return;
  index.delete(entry.messageId);
  if (index.size === 0) chatReplyChainIndexes.delete(chatId);
}

/** 按 message_id 取仍在热区的消息；已滑出或从未记录过则为 undefined。 */
export function lookupBufferedMessage(chatId: number, messageId: number): BufferedMessage | undefined {
  return chatReplyChainIndexes.get(chatId)?.get(messageId);
}

/** 把一条热区消息转成链节点：正文取条目当前值（媒体描述回填后即为描述）。
 *  字段一次写全、缺省显式 undefined，与下面的快照分支同形（见
 *  types/aiChat/memory.ts 的形状约束）；链节点会被 formatReplyChain 逐跳读。 */
function chainLinkFor(messageId: number, message: BufferedMessage): ReplyChainLink {
  return {
    messageId,
    id: message.id,
    firstName: message.firstName,
    lastName: message.lastName,
    username: message.username,
    text: message.text,
    // 热区条目自己的引用不是「这一跳的引用」，链节点不携带 quote。
    quote: undefined,
    forwardedFrom: message.forwardedFrom,
    snapshotOnly: false,
  };
}

/** 某跳已滑出热区时，用上一跳携带的快照收尾。字段顺序与 chainLinkFor 一致，
 *  不能写成 `{ ...hop, snapshotOnly: true }`——展开会按 hop 自己的键序产出另一个
 *  隐藏类，两条分支的节点又恰好会混在同一个链数组里被同一处代码读。 */
function chainLinkFromSnapshot(hop: BufferedReplyReference): ReplyChainLink {
  return {
    messageId: hop.messageId,
    id: hop.id,
    firstName: hop.firstName,
    lastName: hop.lastName,
    username: hop.username,
    text: hop.text,
    quote: hop.quote,
    forwardedFrom: hop.forwardedFrom,
    snapshotOnly: true,
  };
}

/**
 * 从触发消息的直接回复对象出发，沿各热区消息自带的单跳 replyTo 逐级回溯，
 * 拼出多层回复链。返回数组第 1 项是触发消息直接回复的消息，往后逐级更早。
 * 某跳已滑出热区时以上一跳携带的回复快照收尾（快照是热区消息自己的字段，
 * 不算越出热区），链到此为止；深度上限与 visited 双重防护，异常数据成环
 * 也不会死循环。
 */
export function collectReplyChain(chatId: number, firstHop: BufferedReplyReference): ReplyChainLink[] {
  const chain: ReplyChainLink[] = [];
  const visited: Set<number> = new Set();
  let hop: BufferedReplyReference | undefined = firstHop;
  while (hop && chain.length < REPLY_CHAIN_MAX_DEPTH && !visited.has(hop.messageId)) {
    visited.add(hop.messageId);
    const resolved: BufferedMessage | undefined = lookupBufferedMessage(chatId, hop.messageId);
    if (resolved) {
      chain.push(chainLinkFor(hop.messageId, resolved));
      hop = resolved.replyTo;
    } else {
      chain.push(chainLinkFromSnapshot(hop));
      hop = undefined;
    }
  }
  return chain;
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
