import type { LinkedQueue } from "../../libs/linkedQueue";
import type { BufferedMessage } from "../../types/aiChat/memory";

/** 可持久化 AI 记忆的唯一内存 owner；快照恢复/刷盘由 rollingMemory.ts 编排。 */
export const chatBuffers: Map<number, LinkedQueue<BufferedMessage>> = new Map();
export const chatSummaries: Map<number, LinkedQueue<string>> = new Map();
export const pendingSummaries: Map<number, string> = new Map();
export const dirtyMemoryChats: Set<number> = new Set();

/** 各群最后一次记入滚动缓存的时刻，仅用于容量满时的 LRU 淘汰排序（见
 *  rollingMemory.ts 的 ensureMemoryCapacity）；不落盘，hydrate 时以快照的
 *  savedAt 近似播种。 */
export const chatLastActivityTimes: Map<number, number> = new Map();

/** 各群 message_id -> 滚动缓存条目 的回复链索引（见 workers/aiChat/
 *  replyChain.ts）。chatBuffers 的纯派生索引：内层值与滚动缓存共享同一批
 *  对象引用，不复制内容，容量天然受 VERBATIM_CONTEXT_MAX × AI_MEMORY_MAX_CHATS
 *  约束，无独立淘汰策略。不落盘；push 入缓存时登记、轮换移出热区时删键、
 *  hydrate 时从恢复出的 buffer 重建（均见 rollingMemory.ts）——索引里永远
 *  只有仍在热区的消息。 */
export const chatReplyChainIndexes: Map<number, Map<number, BufferedMessage>> = new Map();

export function hasChatMemory(chatId: number): boolean {
  return chatBuffers.has(chatId) || chatSummaries.has(chatId) || pendingSummaries.has(chatId);
}

export function chatMemoryIds(): Set<number> {
  return new Set([...chatBuffers.keys(), ...chatSummaries.keys(), ...pendingSummaries.keys()]);
}

/** 删除一个群的全部可持久化记忆；调用方另行处理代际和非持久化衍生状态。
 *  回复链索引严格派生自 chatBuffers，随之一并删除，不交给调用方。 */
export function clearChatMemoryCache(chatId: number): void {
  chatBuffers.delete(chatId);
  chatSummaries.delete(chatId);
  pendingSummaries.delete(chatId);
  dirtyMemoryChats.delete(chatId);
  chatLastActivityTimes.delete(chatId);
  chatReplyChainIndexes.delete(chatId);
}

/** Worker dispose/测试隔离时清空所有记忆。 */
export function resetAiChatMemoryCache(): void {
  chatBuffers.clear();
  chatSummaries.clear();
  pendingSummaries.clear();
  dirtyMemoryChats.clear();
  chatLastActivityTimes.clear();
  chatReplyChainIndexes.clear();
}
