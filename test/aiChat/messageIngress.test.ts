import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  aiRecordMediaMessageFixture,
  aiRecordMessageFixture,
} from "../helpers/aiMemoryFixtures";
import {
  AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER,
  AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER,
} from "../../packages/consts/aiChat/provider";
import type { AiChatWorkerMessage } from "../../packages/types/aiChat/protocol";

const workerPosts: AiChatWorkerMessage[] = [];
let messageActive: number = 0;
let messageRetryPending: number = 0;
const postAiChatOrThrow = mock((message: AiChatWorkerMessage): void => {
  workerPosts.push(message);
});

mock.module("../../packages/aiChat/workerBridge", () => ({ postAiChatOrThrow }));
mock.module("../../packages/infra/telegram/outboundGate", () => ({
  telegramOutboundStats: () => ({ messageActive, messageRetryPending }),
}));

const {
  generateAndSendReply,
  recordChatMedia,
  recordChatMessage,
} = await import("../../packages/aiChat/messageIngress");
const {
  aiMemoryRevisionCounters,
  latestAiMemories,
  postPurgeAiMemoryPersistRevisions,
  purgedAiMemoryChats,
} = await import("../../packages/cache/main/aiChat");

beforeEach((): void => {
  workerPosts.length = 0;
  messageActive = 0;
  messageRetryPending = 0;
  postAiChatOrThrow.mockClear();
  postAiChatOrThrow.mockImplementation((message: AiChatWorkerMessage): void => {
    workerPosts.push(message);
  });
  aiMemoryRevisionCounters.clear();
  latestAiMemories.clear();
  postPurgeAiMemoryPersistRevisions.clear();
  purgedAiMemoryChats.clear();
});

describe("AI 主线程消息入口", () => {
  test("文字与媒体记录都会清除 purge 标记并保持最终载荷对象", () => {
    purgedAiMemoryChats.add(-1001);
    const textMessage = aiRecordMessageFixture({ chatId: -1001 });
    recordChatMessage(textMessage);
    expect(purgedAiMemoryChats.has(-1001)).toBeFalse();
    expect(workerPosts[0]).toBe(textMessage);

    purgedAiMemoryChats.add(-1001);
    const mediaMessage = aiRecordMediaMessageFixture({ chatId: -1001 });
    recordChatMedia(mediaMessage);
    expect(purgedAiMemoryChats.has(-1001)).toBeFalse();
    expect(workerPosts[1]).toBe(mediaMessage);
  });

  test("purge 后首份新记忆武装即时持久化，投递失败时回滚新闩锁", () => {
    aiMemoryRevisionCounters.set(-1001, 7);
    const message = aiRecordMessageFixture({ chatId: -1001 });
    postAiChatOrThrow.mockImplementationOnce((): never => {
      throw new Error("AI Worker is unavailable");
    });

    expect(() => recordChatMessage(message)).toThrow("AI Worker is unavailable");
    expect(message.persistImmediately).toBeTrue();
    expect(postPurgeAiMemoryPersistRevisions.has(-1001)).toBeFalse();
  });

  test("已有待确认即时快照时，后续记录继续携带即时持久化要求", () => {
    postPurgeAiMemoryPersistRevisions.set(-1001, null);
    const message = aiRecordMediaMessageFixture({ chatId: -1001 });

    recordChatMedia(message);

    expect(message.persistImmediately).toBeTrue();
    expect(workerPosts).toEqual([message]);
  });

  test("触发载荷冻结发送背压快照，并显式写出所有缺省字段", () => {
    messageActive = AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER;
    generateAndSendReply({
      chatId: -1001,
      triggerSenderId: 7,
      replyToMessageId: 17,
      imageGenerationRequested: false,
      imageGenerationReference: undefined,
    });

    messageActive = 0;
    messageRetryPending = AI_TELEGRAM_MESSAGE_RETRY_HIGH_WATER;
    generateAndSendReply({
      chatId: -1002,
      triggerSenderId: 8,
      replyToMessageId: 18,
      imageGenerationRequested: true,
      imageGenerationReference: undefined,
      isRandomTrigger: true,
    });

    messageRetryPending = 0;
    generateAndSendReply({
      chatId: -1003,
      triggerSenderId: 9,
      replyToMessageId: 19,
      imageGenerationRequested: false,
      imageGenerationReference: undefined,
    });

    expect(workerPosts).toEqual([
      {
        type: "trigger",
        chatId: -1001,
        triggerSenderId: 7,
        replyToMessageId: 17,
        isRandomTrigger: false,
        telegramBackpressured: true,
        imageGenerationRequested: false,
        imageGenerationReference: undefined,
      },
      {
        type: "trigger",
        chatId: -1002,
        triggerSenderId: 8,
        replyToMessageId: 18,
        isRandomTrigger: true,
        telegramBackpressured: true,
        imageGenerationRequested: true,
        imageGenerationReference: undefined,
      },
      {
        type: "trigger",
        chatId: -1003,
        triggerSenderId: 9,
        replyToMessageId: 19,
        isRandomTrigger: false,
        telegramBackpressured: false,
        imageGenerationRequested: false,
        imageGenerationReference: undefined,
      },
    ]);
  });
});
