import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { LinkedQueue } from "../../../src/libs/linkedQueue";
import type { BufferedMessage } from "../../../src/types/aiChat/memory";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });

mock.module("../../../src/workers/aiChat/compaction", () => ({
  scheduleRotation: mock((..._args: unknown[]): void => {}),
}));

const { pushBufferedMessage } = await import("../../../src/workers/aiChat/rollingMemory");
const {
  chatBuffers,
  chatLastActivityTimes,
  resetAiChatMemoryCache,
} = await import("../../../src/cache/aiChat/memory");
const { activeReplyCounts, resetAiChatReplyCache } = await import("../../../src/cache/aiChat/replies");
const { AI_MEMORY_MAX_CHATS } = await import("../../../src/consts/aiChat/memory");

function entry(text: string): BufferedMessage {
  return { id: 1, firstName: "Alice", lastName: "", text, at: "00:00" };
}

beforeEach(() => {
  resetAiChatMemoryCache();
  resetAiChatReplyCache();
  postMessage.mockClear();
});

afterAll(() => {
  resetAiChatMemoryCache();
  resetAiChatReplyCache();
  if (originalSelfDescriptor) Object.defineProperty(globalThis, "self", originalSelfDescriptor);
  else delete (globalThis as { self?: unknown }).self;
});

describe("AI rolling-memory capacity", () => {
  test("LRU 淘汰优先跳过仍有回复轮次在途的最老群", () => {
    for (let index: number = 0; index < AI_MEMORY_MAX_CHATS; index++) {
      const chatId: number = -10_000 - index;
      chatBuffers.set(chatId, new LinkedQueue<BufferedMessage>());
      chatLastActivityTimes.set(chatId, index);
    }
    const activeOldestChatId: number = -10_000;
    const oldestIdleChatId: number = -10_001;
    activeReplyCounts.set(activeOldestChatId, 1);

    pushBufferedMessage(-20_000, entry("new chat"));

    expect(chatBuffers.has(activeOldestChatId)).toBe(true);
    expect(chatBuffers.has(oldestIdleChatId)).toBe(false);
    expect(chatBuffers.has(-20_000)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: oldestIdleChatId });
  });

  test("所有候选群都有在途回复时退化为淘汰最老群", () => {
    for (let index: number = 0; index < AI_MEMORY_MAX_CHATS; index++) {
      const chatId: number = -30_000 - index;
      chatBuffers.set(chatId, new LinkedQueue<BufferedMessage>());
      chatLastActivityTimes.set(chatId, index);
      activeReplyCounts.set(chatId, 1);
    }

    pushBufferedMessage(-40_000, entry("fallback"));

    expect(chatBuffers.has(-30_000)).toBe(false);
    expect(chatBuffers.has(-40_000)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -30_000 });
  });
});
