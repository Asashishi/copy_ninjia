/** owner: workers/aiChat。群聊记忆与同源消息索引。 */

import type { LinkedQueue } from "../../../libs/linkedQueue";
import type { BoundedDeque } from "../../../libs/boundedDeque";
import type { BufferedMessage } from "../../../types/aiChat/memory";

/**
 * AI 滚动记忆（packages/workers/aiChat/rollingMemory.ts）的权威内存状态：整体
 * hydrate/清空/容量淘汰由它编排；个别字段的产出方分散在回复流水线其它
 * 子模块（如中期压缩 compaction.ts 产出 pendingSummaries、消息索引由
 * bufferedMessageIndex.ts 维护），细节见各导出注释。
 */

/** 可持久化 AI 记忆的唯一内存 owner；快照恢复/刷盘由 rollingMemory.ts 编排。 */
export const chatBuffers: Map<number, BoundedDeque<BufferedMessage>> = new Map();
/** 每群已完成的冷历史摘要；轮换压缩填充，快照恢复，群淘汰时删除。 */
export const chatSummaries: Map<number, LinkedQueue<string>> = new Map();
/** 每群尚未合并进 summaries 的摘要文本；压缩 settle 或群淘汰时清除。 */
export const pendingSummaries: Map<number, string> = new Map();
/** 需要在下一次周期上报快照的群；成功上报或群清除时删除。 */
export const dirtyMemoryChats: Set<number> = new Set();

/** 各群最后一次记入滚动缓存的时刻，仅用于容量满时的 LRU 淘汰排序（见
 *  rollingMemory.ts 的 ensureMemoryCapacity）；不落盘，hydrate 时以快照的
 *  savedAt 近似播种。 */
export const chatLastActivityTimes: Map<number, number> = new Map();

/** 各群 message_id -> 滚动缓存条目 的消息索引（见 workers/aiChat/
 *  bufferedMessageIndex.ts）。chatBuffers 的纯派生索引：内层值与滚动缓存共享同一批
 *  对象引用，不复制内容，容量天然受 VERBATIM_CONTEXT_MAX × AI_MEMORY_MAX_CHATS
 *  约束，无独立淘汰策略。不落盘；push 入缓存时登记、轮换移出热区时删键、
 *  hydrate 时从恢复出的 buffer 重建（均见 rollingMemory.ts）——索引里永远
 *  只有仍在热区的消息。 */
export const chatMessageIndexes: Map<number, Map<number, BufferedMessage>> = new Map();

/** 判断某群是否存在任一可持久化记忆部分。 */
export function hasChatMemory(chatId: number): boolean {
  return chatBuffers.has(chatId) || chatSummaries.has(chatId) || pendingSummaries.has(chatId);
}

/** 返回当前可持久化记忆涉及的群 ID 快照；调用方可独立修改返回集合。 */
export function chatMemoryIds(): Set<number> {
  return new Set([...chatBuffers.keys(), ...chatSummaries.keys(), ...pendingSummaries.keys()]);
}

/** 删除一个群的全部可持久化记忆；调用方另行处理代际和非持久化衍生状态。
 *  消息索引严格派生自 chatBuffers，随之一并删除，不交给调用方。 */
export function clearChatMemoryCache(chatId: number): void {
  chatBuffers.delete(chatId);
  chatSummaries.delete(chatId);
  pendingSummaries.delete(chatId);
  dirtyMemoryChats.delete(chatId);
  chatLastActivityTimes.delete(chatId);
  chatMessageIndexes.delete(chatId);
}

/** Worker dispose/测试隔离时清空所有记忆。 */
export function resetAiChatMemoryCache(): void {
  chatBuffers.clear();
  chatSummaries.clear();
  pendingSummaries.clear();
  dirtyMemoryChats.clear();
  chatLastActivityTimes.clear();
  chatMessageIndexes.clear();
}
