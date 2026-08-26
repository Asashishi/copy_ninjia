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
  collectReplyChain,
  indexBufferedMessage,
  lookupBufferedMessage,
  replyReferenceForBufferedMessage,
  unindexBufferedMessage,
} = await import("../../../packages/workers/aiChat/replyChain");
const {
  chatReplyChainIndexes,
  clearChatMemoryCache,
  resetAiChatMemoryCache,
} = await import("../../../packages/cache/workers/aiChat/memory");
const { resetAiChatReplyCache } = await import("../../../packages/cache/workers/aiChat/replies");
const {
  COMPACT_BATCH_SIZE,
  REPLY_CHAIN_MAX_DEPTH,
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

describe("回复链索引维护", () => {
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
    expect(chatReplyChainIndexes.get(CHAT_ID)!.size).toBe(VERBATIM_CONTEXT_MAX - COMPACT_BATCH_SIZE);
    expect(lookupBufferedMessage(CHAT_ID, COMPACT_BATCH_SIZE)).toBeUndefined();
    expect(lookupBufferedMessage(CHAT_ID, COMPACT_BATCH_SIZE + 1)).toBeDefined();
  });

  test("clearChatMemoryCache 连整群索引一并删除", () => {
    pushBufferedMessage(CHAT_ID, message(1, "第一条"));
    clearChatMemoryCache(CHAT_ID);
    expect(chatReplyChainIndexes.has(CHAT_ID)).toBe(false);
  });

  test("同 message_id 的旧副本滑出热区时，不抹掉仍在热区的新副本", () => {
    // 重复条目是真实可达的：进程被 SIGKILL 之后快照 hydrate 出一份，Telegram
    // 又重投同一条 update 再记一份，全链路没有 message_id 去重。按 id 无条件
    // delete 的话，旧副本滑出时会把新副本的索引一并抹掉，回复链就在那一跳
    // 截断成 snapshotOnly——正文明明还在缓存里。
    const older: BufferedMessage = message(500, "旧副本");
    const newer: BufferedMessage = message(500, "新副本");
    indexBufferedMessage(CHAT_ID, older);
    indexBufferedMessage(CHAT_ID, newer);

    unindexBufferedMessage(CHAT_ID, older);
    expect(lookupBufferedMessage(CHAT_ID, 500)).toBe(newer);

    unindexBufferedMessage(CHAT_ID, newer);
    expect(lookupBufferedMessage(CHAT_ID, 500)).toBeUndefined();
    expect(chatReplyChainIndexes.has(CHAT_ID)).toBeFalse();
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
    expect(collectReplyChain(CHAT_ID, bufferedReplyReferenceFixture({ messageId: 2, id: 0, firstName: "", lastName: "", text: "" }))
      .map((link) => link.messageId)).toEqual([2, 1]);
  });
});

describe("回复链回溯", () => {
  test("沿单跳 replyTo 逐级回溯，正文取热区条目当前值", () => {
    pushBufferedMessage(CHAT_ID, message(1, "起点"));
    pushBufferedMessage(CHAT_ID, {
      ...message(2, "第二跳", 1),
      forwardedFrom: "频道 [id:-100666] 东京日报",
    });
    const trigger: BufferedMessage = message(3, "触发", 2);
    pushBufferedMessage(CHAT_ID, trigger);

    const chain = collectReplyChain(CHAT_ID, trigger.replyTo!);
    expect(chain.map((link) => link.messageId)).toEqual([2, 1]);
    // 正文来自热区条目本身（媒体描述回填后即为描述），不是入队时的回复快照。
    expect(chain[0]!.text).toBe("第二跳");
    expect(chain[1]!.text).toBe("起点");
    expect(chain[0]!.id).toBe(12);
    expect(chain[0]!.forwardedFrom).toBe("频道 [id:-100666] 东京日报");
    expect(chain.every((link) => !link.snapshotOnly)).toBe(true);
  });

  test("某跳滑出热区时以上一跳携带的快照收尾", () => {
    // message_id=1 从未入热区；2 的 replyTo 里带着它的快照。
    pushBufferedMessage(CHAT_ID, message(2, "第二跳", 1));
    const trigger: BufferedMessage = message(3, "触发", 2);
    pushBufferedMessage(CHAT_ID, trigger);

    const chain = collectReplyChain(CHAT_ID, trigger.replyTo!);
    expect(chain.map((link) => link.messageId)).toEqual([2, 1]);
    expect(chain[1]!.text).toBe("快照-1");
    expect(chain[0]!.snapshotOnly).toBe(false);
    expect(chain[1]!.snapshotOnly).toBe(true);
  });

  test("链长受 REPLY_CHAIN_MAX_DEPTH 截断", () => {
    pushBufferedMessage(CHAT_ID, message(1, "最早"));
    for (let messageId: number = 2; messageId <= REPLY_CHAIN_MAX_DEPTH + 3; messageId++) {
      pushBufferedMessage(CHAT_ID, message(messageId, `消息-${messageId}`, messageId - 1));
    }
    const firstHopId: number = REPLY_CHAIN_MAX_DEPTH + 3;
    const chain = collectReplyChain(CHAT_ID, bufferedReplyReferenceFixture({ messageId: firstHopId, id: 0, firstName: "", lastName: "", text: "" }));
    expect(chain).toHaveLength(REPLY_CHAIN_MAX_DEPTH);
    expect(chain[0]!.messageId).toBe(firstHopId);
  });

  test("异常数据成环时靠 visited 终止，不死循环", () => {
    // Telegram 只能回复更早的消息，正常拼不出环；直接向索引塞异常数据兜底验证。
    const first: BufferedMessage = message(10, "甲", 11);
    const second: BufferedMessage = message(11, "乙", 10);
    indexBufferedMessage(CHAT_ID, first);
    indexBufferedMessage(CHAT_ID, second);
    const chain = collectReplyChain(CHAT_ID, bufferedReplyReferenceFixture({ messageId: 10, id: 0, firstName: "", lastName: "", text: "" }));
    expect(chain.map((link) => link.messageId)).toEqual([10, 11]);
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
