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
const { buildBufferedMessage, sanitizeReplyReference } = await import("../../../src/workers/aiChat/bufferedMessage");
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
  test("统一构造器保留 message_id 并清洗发送者和回复引用", () => {
    expect(buildBufferedMessage({
      chatId: -1001,
      senderId: 1,
      firstName: "Alice\nA",
      lastName: "",
      username: "@alice",
      messageId: 10,
      replyTo: {
        messageId: 9,
        id: 2,
        firstName: "Bob",
        lastName: "",
        text: "原文\n第二行",
      },
      forwardedFrom: "[id:789]\nCarol",
    }, "当前\n消息", 0)).toEqual({
      messageId: 10,
      id: 1,
      firstName: "Alice A",
      lastName: "",
      username: "alice",
      text: "当前 消息",
      replyTo: {
        messageId: 9,
        id: 2,
        firstName: "Bob",
        lastName: "",
        text: "原文 第二行",
      },
      forwardedFrom: "[id:789] Carol",
      at: expect.any(String),
    });
  });

  test("回复引用按单行清洗并去掉 username 的多余 @", () => {
    expect(sanitizeReplyReference({
      messageId: 9,
      id: 2,
      firstName: "Bob\nBuilder",
      lastName: "",
      username: "@@bob_dev",
      text: "第一行\n第二行",
      quote: "第二行\n末尾",
      forwardedFrom: "频道 [id:-100666]\n东京日报",
    })).toEqual({
      messageId: 9,
      id: 2,
      firstName: "Bob Builder",
      lastName: "",
      username: "bob_dev",
      text: "第一行 第二行",
      quote: "第二行 末尾",
      forwardedFrom: "频道 [id:-100666] 东京日报",
    });
  });

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
