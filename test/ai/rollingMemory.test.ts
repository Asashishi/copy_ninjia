import { beforeEach, expect, mock, test } from "bun:test";
import { AI_MEMORY_MAX_CHATS } from "../../src/consts/aiChat";

const postMessageMock = mock((..._args: unknown[]): void => {});
(globalThis as unknown as { self: { postMessage: typeof postMessageMock } }).self = { postMessage: postMessageMock };

const memoryCache = await import("../../src/cache/aiChat/memory");
const moodCache = await import("../../src/cache/aiChat/mood");
const replyCache = await import("../../src/cache/aiChat/replies");
const { hydrateMemories, pushBufferedMessage } = await import("../../src/workers/aiChat/rollingMemory");

beforeEach(() => {
  memoryCache.resetAiChatMemoryCache();
  moodCache.resetAiChatMoodCache();
  replyCache.resetAiChatReplyCache();
  postMessageMock.mockClear();
});

test("AI 群记忆按 savedAt 恢复最新配置数量，并在新群到来时淘汰最旧群", () => {
  const memories = new Map<number, string>();
  for (let index: number = 1; index <= AI_MEMORY_MAX_CHATS + 1; index++) {
    memories.set(-index, JSON.stringify({
      version: 1,
      buffer: [{ id: index, firstName: "用户", lastName: "", text: `消息${index}`, at: "2026/07/18 00:00:00" }],
      summaries: [],
      pendingSummary: null,
      savedAt: index,
    }));
  }

  hydrateMemories(memories);
  expect(memoryCache.chatBuffers.size).toBe(AI_MEMORY_MAX_CHATS);
  expect(memoryCache.chatBuffers.has(-1)).toBe(false);
  expect(postMessageMock).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -1 });

  replyCache.replyGenerations.set(-2, 7);
  pushBufferedMessage(-999, {
    id: 999,
    firstName: "新用户",
    lastName: "",
    text: "新消息",
    at: "2026/07/18 00:00:01",
  });
  expect(memoryCache.chatBuffers.size).toBe(AI_MEMORY_MAX_CHATS);
  expect(memoryCache.chatBuffers.has(-2)).toBe(false);
  expect(memoryCache.chatBuffers.has(-999)).toBe(true);
  expect(replyCache.cachedReplyGeneration(-2)).toBe(8);
  expect(postMessageMock).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -2 });
});

test("回归：hydrate 恢复 chatLastActivityTimes 的同时也播种 chatMoods，不违反“有活动时间就有心情”的不变量", () => {
  const memories = new Map<number, string>([
    [-42, JSON.stringify({
      version: 1,
      buffer: [{ id: 1, firstName: "用户", lastName: "", text: "消息", at: "2026/07/18 00:00:00" }],
      summaries: [],
      pendingSummary: null,
      savedAt: 1752800000000,
    })],
  ]);

  hydrateMemories(memories);
  expect(moodCache.chatLastActivityTimes.has(-42)).toBe(true);
  expect(moodCache.chatMoods.has(-42)).toBe(true);
});
