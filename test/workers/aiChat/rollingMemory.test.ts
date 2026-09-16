import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  aiReplyReferenceFixture,
  bufferedMessageFixture,
  bufferedReplyReferenceFixture,
} from "../../helpers/aiMemoryFixtures";
import { BoundedDeque } from "../../../packages/libs/boundedDeque";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });

mock.module("../../../packages/workers/aiChat/compaction", () => ({
  scheduleRotation: mock((..._args: unknown[]): void => {}),
}));

const {
  flushMemorySnapshot,
  pushBufferedMessage,
} = await import("../../../packages/workers/aiChat/rollingMemory");
const { buildBufferedMessage, sanitizeReplyReference } = await import("../../../packages/workers/aiChat/bufferedMessage");
const {
  chatBuffers,
  chatLastActivityTimes,
  dirtyMemoryChats,
  resetAiChatMemoryCache,
} = await import("../../../packages/cache/workers/aiChat/memory");
const {
  activeReplyCounts,
  cachedReplyGeneration,
  resetAiChatReplyCache,
} = await import("../../../packages/cache/workers/aiChat/replies");
const { trackReplyGenerationTask } = await import("../../../packages/workers/aiChat/replyGeneration");
const {
  AI_MEMORY_MAX_CHATS,
  REPLY_REFERENCE_MAX_CHARS,
  VERBATIM_CONTEXT_MAX,
} = await import("../../../packages/consts/aiChat/memory");
const { truncateInline } = await import("../../../packages/libs/text");
const { formatTokyoTime } = await import("../../../packages/libs/time");

function entry(text: string): BufferedMessage {
  return bufferedMessageFixture({ messageId: 1, id: 1, firstName: "Alice", lastName: "", text, at: "00:00" });
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
      replyTo: aiReplyReferenceFixture({
        messageId: 9,
        id: 2,
        firstName: "Bob",
        lastName: "",
        text: "原文\n第二行",
      }),
      forwardedFrom: "[id:789]\nCarol",
      persistImmediately: false,
    }, "当前\n消息", 0)).toEqual({
      messageId: 10,
      id: 1,
      firstName: "Alice A",
      lastName: "",
      username: "alice",
      text: "当前 消息",
      replyTo: bufferedReplyReferenceFixture({
        messageId: 9,
        id: 2,
        firstName: "Bob",
        lastName: "",
        text: "原文 第二行",
      }),
      forwardedFrom: "[id:789] Carol",
      at: expect.any(String),
    });
  });

  test.each([1_024, 4_096])("长正文 %i 码元：各空白排版下的完整缓存条目与参考清洗逐字一致", (length) => {
    const reference = (raw: string): string => raw.replace(/[\s\u0085]+/g, " ").trim();
    const fixedNow: number = 1_789_596_000_000;
    const unit: string = "今天讨论消息处理 and runtime costs🙂 群聊👨‍👩‍👧‍👦混排 ";
    const base: string = `${unit.repeat(Math.ceil(length / unit.length)).slice(0, length - 1)}x`;
    const layouts: Readonly<Record<string, (text: string) => string>> = {
      canonical: (text: string): string => text,
      head: (text: string): string => `\n${text.slice(1)}`,
      middle: (text: string): string => `${text.slice(0, length / 2)}\n${text.slice(length / 2 + 1)}`,
      tail: (text: string): string => `${text.slice(0, -2)}\n${text.slice(-1)}`,
      dense: (text: string): string => [...text].map((character: string, index: number): string =>
        index % 40 === 0 ? "\n" : index % 17 === 0 ? "\t" : index % 23 === 0 ? "  " : character
      ).join(""),
    };
    for (const [layout, shape] of Object.entries(layouts)) {
      const text: string = shape(base);
      const replyText: string = shape(`${base.slice(1)}y`);
      const quote: string = shape(base).slice(0, 128);
      const built: BufferedMessage | null = buildBufferedMessage({
        chatId: -1001,
        senderId: 7,
        firstName: layout === "canonical" ? "群聊成员" : " 群聊\n成员 ",
        lastName: "Chen",
        username: "@alice_007",
        messageId: 40_000,
        replyTo: aiReplyReferenceFixture({
          messageId: 30_000,
          id: 20_000,
          firstName: "引用用户",
          username: "reply_user",
          text: replyText,
          quote,
        }),
        forwardedFrom: layout === "canonical" ? undefined : "转发\n来源",
        persistImmediately: false,
      }, text, fixedNow);
      const expected: BufferedMessage = bufferedMessageFixture({
        messageId: 40_000,
        id: 7,
        firstName: "群聊 成员",
        lastName: "Chen",
        username: "alice_007",
        text: reference(text),
        replyTo: bufferedReplyReferenceFixture({
          messageId: 30_000,
          id: 20_000,
          firstName: "引用用户",
          username: "reply_user",
          text: truncateInline(reference(replyText), REPLY_REFERENCE_MAX_CHARS),
          quote: truncateInline(reference(quote), REPLY_REFERENCE_MAX_CHARS),
        }),
        forwardedFrom: layout === "canonical" ? undefined : "转发 来源",
        at: formatTokyoTime(fixedNow),
      });
      if (layout === "canonical") expected.firstName = "群聊成员";
      expect(built).toEqual(expected);
      expect(Object.keys(built!)).toEqual(Object.keys(expected));
      expect(Object.keys(built!.replyTo!)).toEqual(Object.keys(expected.replyTo!));
    }
  });

  test("清洗后为空的正文丢弃，空白回复原文与 quote 归一为占位与 undefined", () => {
    const source = {
      chatId: -1001,
      senderId: 1,
      firstName: "Alice",
      lastName: "",
      username: undefined,
      messageId: 10,
      replyTo: aiReplyReferenceFixture({ text: " \n\u0085\t", quote: "\u3000 " }),
      forwardedFrom: undefined,
      persistImmediately: false,
    };
    for (const empty of ["", " ", "\n\u0085\u00a0", "\ufeff\u2028"]) {
      expect(buildBufferedMessage(source, empty, 0)).toBeNull();
    }
    const built: BufferedMessage | null = buildBufferedMessage(source, "正文", 0);
    expect(built?.replyTo?.text).toBe("[非文本消息]");
    expect(built?.replyTo?.quote).toBeUndefined();
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

  test("purge 后首份新记忆可按群立即上报，并从普通 dirty 批次移除", () => {
    pushBufferedMessage(-1001, entry("post-purge"));

    flushMemorySnapshot(-1001, true);

    expect(postMessage).toHaveBeenCalledWith({
      type: "memory",
      chatId: -1001,
      snapshot: expect.any(String),
      persistImmediately: true,
      // 主线程展示 `/bot_status` 的上下文容量只认这两个计数，快照 JSON 不在
      // 主线程解析（见 cache/main/aiChat.ts 的 aiMemoryUsages）。
      usage: { bufferedCount: 1, summaryCount: 0 },
    });
    expect(chatBuffers.get(-1001)?.size).toBe(1);
    expect(dirtyMemoryChats.has(-1001)).toBeFalse();
  });

  test("LRU 淘汰优先跳过仍有回复轮次在途的最老群", () => {
    for (let index: number = 0; index < AI_MEMORY_MAX_CHATS; index++) {
      const chatId: number = -10_000 - index;
      chatBuffers.set(
        chatId,
        new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX)
      );
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

  test("模型已结束但发送链未完成时保留记忆，链结束后恢复 LRU 淘汰", async () => {
    for (let index: number = 0; index < AI_MEMORY_MAX_CHATS; index++) {
      const chatId: number = -10_000 - index;
      chatBuffers.set(chatId, new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX));
      chatLastActivityTimes.set(chatId, index);
    }
    const pending = Promise.withResolvers<void>();
    trackReplyGenerationTask(-10_000, cachedReplyGeneration(-10_000), pending.promise);
    try {
      expect(activeReplyCounts.has(-10_000)).toBe(false);
      pushBufferedMessage(-20_000, entry("new chat"));
      expect(chatBuffers.has(-10_000)).toBe(true);
      expect(chatBuffers.has(-10_001)).toBe(false);
      pending.resolve();
      await pending.promise;
      pushBufferedMessage(-20_001, entry("another chat"));
      expect(chatBuffers.has(-10_000)).toBe(false);
    } finally {
      pending.resolve();
      await pending.promise;
    }
  });

  test("所有候选群都有在途回复时退化为淘汰最老群", () => {
    for (let index: number = 0; index < AI_MEMORY_MAX_CHATS; index++) {
      const chatId: number = -30_000 - index;
      chatBuffers.set(
        chatId,
        new BoundedDeque<BufferedMessage>(VERBATIM_CONTEXT_MAX)
      );
      chatLastActivityTimes.set(chatId, index);
      activeReplyCounts.set(chatId, 1);
    }

    pushBufferedMessage(-40_000, entry("fallback"));

    expect(chatBuffers.has(-30_000)).toBe(false);
    expect(chatBuffers.has(-40_000)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: "memoryDeleted", chatId: -30_000 });
  });
});
