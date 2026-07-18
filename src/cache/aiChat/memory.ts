import type { LinkedQueue } from "../../libs/linkedQueue";
import type { BufferedMessage } from "../../types";

/** 可持久化 AI 记忆的唯一内存 owner；快照恢复/刷盘由 rollingMemory.ts 编排。 */
export const chatBuffers: Map<number, LinkedQueue<BufferedMessage>> = new Map();
export const chatSummaries: Map<number, LinkedQueue<string>> = new Map();
export const pendingSummaries: Map<number, string> = new Map();
export const dirtyMemoryChats: Set<number> = new Set();

export function hasChatMemory(chatId: number): boolean {
  return chatBuffers.has(chatId) || chatSummaries.has(chatId) || pendingSummaries.has(chatId);
}

export function chatMemoryIds(): Set<number> {
  return new Set([...chatBuffers.keys(), ...chatSummaries.keys(), ...pendingSummaries.keys()]);
}

/** 删除一个群的全部可持久化记忆；调用方另行处理代际和非持久化衍生状态。 */
export function clearChatMemoryCache(chatId: number): void {
  chatBuffers.delete(chatId);
  chatSummaries.delete(chatId);
  pendingSummaries.delete(chatId);
  dirtyMemoryChats.delete(chatId);
}

/** Worker dispose/测试隔离时清空所有记忆。 */
export function resetAiChatMemoryCache(): void {
  chatBuffers.clear();
  chatSummaries.clear();
  pendingSummaries.clear();
  dirtyMemoryChats.clear();
}
