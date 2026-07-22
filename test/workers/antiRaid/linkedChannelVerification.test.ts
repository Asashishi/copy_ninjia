import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerEvent, VerificationSnapshot } from "../../../src/types";

interface DeferredChat {
  promise: Promise<Record<string, unknown>>;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
}

function deferredChat(): DeferredChat {
  let resolve!: (value: Record<string, unknown>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Record<string, unknown>>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const chatRequests: DeferredChat[] = [];
const workerEvents: AntiRaidWorkerEvent[] = [];
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(event: AntiRaidWorkerEvent): void { workerEvents.push(event); } },
});

mock.module("../../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../src/infra/config", () => ({ PRIVILEGED_USERS_ID: [] }));
mock.module("../../../src/infra/telegram", () => ({
  joinVerificationApi: {
    getChat(): Promise<Record<string, unknown>> {
      const request = deferredChat();
      chatRequests.push(request);
      return request.promise;
    },
    getChatAdministrators: async (): Promise<never[]> => [],
  },
  sendMessage: async (): Promise<undefined> => undefined,
  deleteMessage: async (): Promise<boolean> => true,
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => true,
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

const runtime = await import("../../../src/workers/antiRaid/verificationRuntime");
const { verificationEntries, verificationGeneration, verificationRevisions } =
  await import("../../../src/cache/antiRaid/verification");
const { resetLinkedChannelCache, linkedChannels } =
  await import("../../../src/cache/antiRaid/linkedChannels");
const { recentChannelComments } = await import("../../../src/cache/antiRaid/recentComments");

function pendingRecord(userId: number, generation: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId,
    generation,
    revision: 1,
    label: `User ${userId}`,
    isBot: false,
    messageIds: [],
    trackedMessageTimes: [],
    reminderMessageId: 500,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

async function settleAsyncWork(): Promise<void> {
  await Bun.sleep(0);
  await Bun.sleep(0);
}

beforeEach(() => {
  for (const entry of verificationEntries.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
  }
  verificationEntries.clear();
  verificationRevisions.clear();
  verificationGeneration.current = 0;
  resetLinkedChannelCache();
  recentChannelComments.clear();
  chatRequests.length = 0;
  workerEvents.length = 0;
});

describe("cold linked-channel verification", () => {
  test("冷缓存普通 forum topic 先按待验证消息追踪，确认无关联频道后不豁免", async () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [pendingRecord(42, 1)],
    });

    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 42,
      messageId: 700,
      isThreadReply: true,
    });

    expect(verificationEntries.get("-1001:42")?.state).toMatchObject({
      kind: "pending",
      messageIds: [700],
      trackedMessageTimes: [expect.any(Number)],
    });
    expect(chatRequests).toHaveLength(1);

    chatRequests[0]!.resolve({ id: -1001, type: "supergroup" });
    await settleAsyncWork();
    expect(verificationEntries.get("-1001:42")?.state.kind).toBe("pending");
    expect(linkedChannels.get(-1001)?.hasLinked).toBe(false);
  });

  test("冷缓存确认有关联频道后只撤销仍为同一代的 pending", async () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 2,
      verifications: [pendingRecord(43, 2)],
    });
    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 43,
      messageId: 701,
      isThreadReply: true,
    });
    expect(verificationEntries.get("-1001:43")?.state.kind).toBe("pending");

    chatRequests[0]!.resolve({ id: -1001, type: "supergroup", linked_chat_id: -2001 });
    await settleAsyncWork();
    expect(verificationEntries.get("-1001:43")?.state.kind).toBe("exempt");

    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 3,
      verifications: [pendingRecord(44, 3)],
    });
    resetLinkedChannelCache();
    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 44,
      messageId: 702,
      isThreadReply: true,
    });
    runtime.dispatchVerification(-1001, 44, {
      type: "callback",
      callbackQueryId: "verified",
      isSelf: true,
      fromIsPrivileged: false,
      fromLabel: "User 44",
    });

    chatRequests[1]!.resolve({ id: -1001, type: "supergroup", linked_chat_id: -2001 });
    await settleAsyncWork();
    expect(verificationEntries.has("-1001:44")).toBe(false);
    expect(recentChannelComments.has("-1001:44")).toBe(false);
  });

  test("消息先于 join 时把确认绑定到新状态；查询失败保持 fail-closed 且下次可重试", async () => {
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 4, verifications: [] });
    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 45,
      messageId: 703,
      isThreadReply: true,
    });
    runtime.handleJoin({
      type: "join",
      chatId: -1001,
      member: { id: 45, first_name: "User 45" },
    });
    expect(verificationEntries.get("-1001:45")?.state.kind).toBe("pending");

    chatRequests[0]!.resolve({ id: -1001, type: "supergroup", linked_chat_id: -2001 });
    await settleAsyncWork();
    expect(verificationEntries.get("-1001:45")?.state.kind).toBe("exempt");

    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 5,
      verifications: [pendingRecord(46, 5)],
    });
    resetLinkedChannelCache();
    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 46,
      messageId: 704,
      isThreadReply: true,
    });
    chatRequests[1]!.reject(new Error("getChat unavailable"));
    await settleAsyncWork();
    expect(verificationEntries.get("-1001:46")?.state.kind).toBe("pending");
    expect(linkedChannels.has(-1001)).toBe(false);

    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 46,
      messageId: 705,
      isThreadReply: true,
    });
    expect(chatRequests).toHaveLength(3);
    chatRequests[2]!.resolve({ id: -1001, type: "supergroup", linked_chat_id: -2001 });
    await settleAsyncWork();
    expect(verificationEntries.get("-1001:46")?.state.kind).toBe("exempt");
  });
});
