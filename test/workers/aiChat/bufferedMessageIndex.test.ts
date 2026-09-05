import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  bufferedMessageFixture,
  bufferedReplyReferenceFixture,
} from "../../helpers/aiMemoryFixtures";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";
import type { AiMemorySnapshot } from "../../../packages/types/aiChat/memory";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });

mock.module("../../../packages/workers/aiChat/compaction", () => ({
  scheduleRotation: mock((..._args: unknown[]): void => {}),
}));

const { pushBufferedMessage, hydrateMemories } = await import("../../../packages/workers/aiChat/rollingMemory");
const {
  indexBufferedMessage,
  lookupBufferedMessage,
  replyReferenceForBufferedMessage,
  unindexBufferedMessage,
} = await import("../../../packages/workers/aiChat/bufferedMessageIndex");
const {
  chatMessageIndexes,
  clearChatMemoryCache,
  resetAiChatMemoryCache,
} = await import("../../../packages/cache/workers/aiChat/memory");
const { resetAiChatReplyCache } = await import("../../../packages/cache/workers/aiChat/replies");
const {
  COMPACT_BATCH_SIZE,
  VERBATIM_CONTEXT_MAX,
} = await import("../../../packages/consts/aiChat/memory");

const CHAT_ID = -1001;

/** 发送者 id 固定为 messageId + 10，规避 max-params 又保持各条目发送者可区分。 */
function message(messageId: number, text: string, replyToId?: number): BufferedMessage {
  const senderId: number = messageId + 10;
  return bufferedMessageFixture({
    messageId,
    id: senderId,
    firstName: `User${senderId}`,
    lastName: "",
    text,
    replyTo: replyToId === undefined
      ? undefined
      : bufferedReplyReferenceFixture({
        messageId: replyToId,
        id: replyToId + 10,
        firstName: "快照",
        lastName: "",
        text: `快照-${replyToId}`,
      }),
    at: "2026/07/23 00:00:00",
  });
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

describe("热区消息索引维护", () => {
  test("push 登记索引，可按 message_id 反查同一个条目引用", () => {
    const entry: BufferedMessage = message(1, "第一条");
    pushBufferedMessage(CHAT_ID, entry);
    expect(lookupBufferedMessage(CHAT_ID, 1)).toBe(entry);
    expect(lookupBufferedMessage(CHAT_ID, 999)).toBeUndefined();
  });

  test("轮换把移出热区的键删掉，仍热的保留", () => {
    for (let messageId: number = 1; messageId <= VERBATIM_CONTEXT_MAX; messageId++) {
      pushBufferedMessage(CHAT_ID, message(messageId, `消息-${messageId}`));
    }
    expect(chatMessageIndexes.get(CHAT_ID)!.size).toBe(VERBATIM_CONTEXT_MAX - COMPACT_BATCH_SIZE);
    expect(lookupBufferedMessage(CHAT_ID, COMPACT_BATCH_SIZE)).toBeUndefined();
    expect(lookupBufferedMessage(CHAT_ID, COMPACT_BATCH_SIZE + 1)).toBeDefined();
  });

  test("clearChatMemoryCache 连整群索引一并删除", () => {
    pushBufferedMessage(CHAT_ID, message(1, "第一条"));
    clearChatMemoryCache(CHAT_ID);
    expect(chatMessageIndexes.has(CHAT_ID)).toBe(false);
  });

  test("同 message_id 的旧副本滑出热区时，不抹掉仍在热区的新副本", () => {
    const older: BufferedMessage = message(500, "旧副本");
    const newer: BufferedMessage = message(500, "新副本");
    indexBufferedMessage(CHAT_ID, older);
    indexBufferedMessage(CHAT_ID, newer);

    unindexBufferedMessage(CHAT_ID, older);
    expect(lookupBufferedMessage(CHAT_ID, 500)).toBe(newer);

    unindexBufferedMessage(CHAT_ID, newer);
    expect(lookupBufferedMessage(CHAT_ID, 500)).toBeUndefined();
    expect(chatMessageIndexes.has(CHAT_ID)).toBeFalse();
  });

  test("hydrate 从恢复出的 buffer 同源重建索引", () => {
    const snapshot: AiMemorySnapshot = {
      version: 1,
      buffer: [message(1, "第一条"), message(2, "第二条", 1)],
      summaries: [],
      pendingSummary: null,
      savedAt: Date.now(),
    };
    hydrateMemories(new Map([[CHAT_ID, JSON.stringify(snapshot)]]));
    expect(lookupBufferedMessage(CHAT_ID, 1)?.text).toBe("第一条");
    expect(lookupBufferedMessage(CHAT_ID, 2)?.replyTo?.messageId).toBe(1);
  });
});

describe("机器人自发消息的回复引用还原", () => {
  test("目标仍在热区时还原完整引用", () => {
    pushBufferedMessage(CHAT_ID, {
      ...message(5, "被回复的话"),
      username: "alice_dev",
      forwardedFrom: "[id:99] 频道",
    });
    expect(replyReferenceForBufferedMessage(CHAT_ID, 5)).toEqual(bufferedReplyReferenceFixture({
      messageId: 5,
      id: 15,
      firstName: "User15",
      lastName: "",
      username: "alice_dev",
      text: "被回复的话",
      forwardedFrom: "[id:99] 频道",
    }));
  });

  test("单纯热区查询在目标已滑出时返回 undefined，由轮次快照负责兜底", () => {
    expect(replyReferenceForBufferedMessage(CHAT_ID, 404)).toBeUndefined();
  });
});
