import { beforeEach, expect, mock, test } from "bun:test";
import { AI_MEMORY_MAX_CHATS } from "../../packages/consts/aiChat";

const postMessageMock = mock((..._args: unknown[]): void => {});
(globalThis as unknown as { self: { postMessage: typeof postMessageMock } }).self = { postMessage: postMessageMock };

const memoryCache = await import("../../packages/cache/workers/aiChat/memory");
const moodCache = await import("../../packages/cache/workers/aiChat/mood");
const replyCache = await import("../../packages/cache/workers/aiChat/replies");
const { hydrateMemories, pushBufferedMessage } = await import("../../packages/workers/aiChat/rollingMemory");

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
      buffer: [{ messageId: index, id: index, firstName: "用户", lastName: "", text: `消息${index}`, at: "2026/07/18 00:00:00" }],
      summaries: [],
      pendingSummary: null,
      savedAt: index,
    }));
  }

  hydrateMemories(memories);
  expect(memoryCache.chatBuffers.size).toBe(AI_MEMORY_MAX_CHATS);
  expect(memoryCache.chatBuffers.has(-1)).toBe(false);
  expect(postMessageMock).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -1 });

  const evictedGeneration: number = replyCache.cachedReplyGeneration(-2);
  pushBufferedMessage(-999, {
    messageId: 999,
    id: 999,
    firstName: "新用户",
    lastName: "",
    text: "新消息",
    at: "2026/07/18 00:00:01",
  });
  expect(memoryCache.chatBuffers.size).toBe(AI_MEMORY_MAX_CHATS);
  expect(memoryCache.chatBuffers.has(-2)).toBe(false);
  expect(memoryCache.chatBuffers.has(-999)).toBe(true);
  expect(replyCache.replyGenerations.has(-2)).toBe(false);
  expect(replyCache.cachedReplyGeneration(-2)).not.toBe(evictedGeneration);
  expect(postMessageMock).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -2 });
});

test("语法坏掉或形状不符的持久化快照都按防御性丢弃，不拦下其余群的恢复", () => {
  const memories = new Map<number, string>([
    [-1, "not valid json"],
    [-2, JSON.stringify({ version: 1, buffer: [], summaries: [], pendingSummary: null, savedAt: "昨天" })],
    [-3, JSON.stringify({ version: 1, buffer: "oops", summaries: [], pendingSummary: null, savedAt: 3 })],
    [-4, JSON.stringify(null)],
    [-5, JSON.stringify({
      version: 1,
      buffer: [{ messageId: 5, id: 5, firstName: "用户", lastName: "", text: "消息", at: "2026/07/18 00:00:00" }],
      summaries: [],
      pendingSummary: null,
      savedAt: 5,
    })],
  ]);

  hydrateMemories(memories);
  expect(memoryCache.chatBuffers.has(-5)).toBe(true);
  expect(memoryCache.chatBuffers.size).toBe(1);
});

test("hydrate 以快照 savedAt 播种 chatLastActivityTimes 供 LRU 淘汰排序；心情不在 hydrate 播种", () => {
  const memories = new Map<number, string>([
    [-42, JSON.stringify({
      version: 1,
      buffer: [{ messageId: 1, id: 1, firstName: "用户", lastName: "", text: "消息", at: "2026/07/18 00:00:00" }],
      summaries: [],
      pendingSummary: null,
      savedAt: 1752800000000,
    })],
  ]);

  hydrateMemories(memories);
  expect(memoryCache.chatLastActivityTimes.get(-42)).toBe(1752800000000);
  expect(moodCache.chatMoods.size).toBe(0);
});
