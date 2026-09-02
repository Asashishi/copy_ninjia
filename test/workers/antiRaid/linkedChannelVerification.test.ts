import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerEvent, VerificationSnapshot } from "../../../packages/types";

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

mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/workers/antiRaid/verificationAttemptPermit", () => ({
  requestVerificationAttemptPermit: async () => ({ status: "granted", attempt: 1 }),
}));
mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: {
    getChat(): Promise<Record<string, unknown>> {
      const request = deferredChat();
      chatRequests.push(request);
      return request.promise;
    },
    getChatAdministrators: async (): Promise<never[]> => [],
  },
  sendMessage: async (): Promise<undefined> => undefined,
  deleteMessage: async (): Promise<boolean> => true,
  deleteMessageWithOutcome: async (): Promise<string> => "deleted",
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => true,
  kickChatMemberWithOutcome: async (): Promise<"kicked"> => "kicked",
  probeChatMembership: async (): Promise<boolean> => true,
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

const runtime = await import("../../../packages/workers/antiRaid/verificationRuntime");
const {
  threadCommentConfirmations,
  verificationEntries,
  verificationGeneration,
  verificationRevisions,
} = await import("../../../packages/cache/workers/antiRaid/verification");
const { linkedChannelFetches, resetLinkedChannelCache, linkedChannels } =
  await import("../../../packages/cache/workers/antiRaid/linkedChannels");
const { fetchChatHasLinkedChannel } = await import(
  "../../../packages/workers/antiRaid/linkedChannel"
);
const { recentChannelComments } = await import("../../../packages/cache/workers/antiRaid/recentComments");
const { THREAD_COMMENT_CONFIRMATION_MAX } = await import(
  "../../../packages/consts/antiRaid/cache"
);

function pendingRecord(userId: number, generation: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId,
    generation,
    revision: 1,
    phase: "pending",
    label: `User ${userId}`,
    isBot: false,
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
  threadCommentConfirmations.clear();
  verificationGeneration.current = 0;
  resetLinkedChannelCache();
  recentChannelComments.clear();
  chatRequests.length = 0;
  workerEvents.length = 0;
});

describe("cold linked-channel verification", () => {
  test("reset 后陈旧查询不删除新槽位，也不把旧快照写回新一代", async () => {
    const stale: Promise<boolean | undefined> =
      fetchChatHasLinkedChannel(-1001);
    expect(chatRequests).toHaveLength(1);

    resetLinkedChannelCache();
    const fresh: Promise<boolean | undefined> =
      fetchChatHasLinkedChannel(-1001);
    const freshSlot: Promise<void> | undefined = linkedChannelFetches.get(-1001);
    expect(freshSlot).toBeDefined();
    expect(chatRequests).toHaveLength(2);

    chatRequests[0]!.resolve({
      id: -1001,
      type: "supergroup",
      linked_chat_id: -2001,
    });
    await expect(stale).resolves.toBeUndefined();
    expect(linkedChannelFetches.get(-1001)).toBe(freshSlot!);
    expect(linkedChannels.has(-1001)).toBeFalse();

    chatRequests[1]!.resolve({ id: -1001, type: "supergroup" });
    await expect(fresh).resolves.toBeFalse();
    expect(linkedChannels.get(-1001)?.hasLinked).toBeFalse();
    expect(linkedChannelFetches.has(-1001)).toBeFalse();
  });

  test("明确回复频道转发帖在 join 前记为最近评论并直接豁免", () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [],
    });

    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 40,
      messageId: 698,
      repliesToChannelPost: true,
    });

    expect(recentChannelComments.get("-1001:40")?.messageId).toBe(698);
    expect(chatRequests).toHaveLength(0);

    runtime.handleJoin({
      type: "join",
      chatId: -1001,
      member: { id: 40, first_name: "User 40" },
    });

    expect(verificationEntries.get("-1001:40")?.state.kind).toBe("exempt");
    expect(recentChannelComments.has("-1001:40")).toBeFalse();
  });

  test("热缓存已确认关联频道时楼中楼回复直接豁免且不重复查询", () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [pendingRecord(41, 1)],
    });
    linkedChannels.set(-1001, { hasLinked: true, fetchedAt: Date.now() });

    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 41,
      messageId: 699,
      isThreadReply: true,
    });

    expect(verificationEntries.get("-1001:41")?.state.kind).toBe("exempt");
    expect(chatRequests).toHaveLength(0);
  });

  test("普通群消息只进入成员滑动窗口，不触发关联频道查询", () => {
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
    });

    expect(verificationEntries.get("-1001:42")?.state).toMatchObject({
      kind: "pending",
      trackedMessageTimes: [expect.any(Number)],
    });
    expect(chatRequests).toHaveLength(0);
  });

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
      action: "self",
      isSelf: true,
      fromCanApprove: false,
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

  test("第 46 条冷缓存楼中楼回复确认后撤回尚未执行的 flood 终态", async () => {
    const record: VerificationSnapshot = pendingRecord(47, 6);
    const observedAt: number = Date.now();
    record.trackedMessageTimes = Array(45).fill(observedAt);
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 6,
      verifications: [record],
    });

    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 47,
      messageId: 46,
      isThreadReply: true,
    });

    expect(verificationEntries.get("-1001:47")?.state).toMatchObject({
      kind: "expelling",
      reason: "flood",
    });
    expect(
      threadCommentConfirmations.get("-1001:47")
        ?.allowFloodTerminalExemption
    ).toBeTrue();

    chatRequests[0]!.resolve({
      id: -1001,
      type: "supergroup",
      linked_chat_id: -2001,
    });
    await settleAsyncWork();

    expect(verificationEntries.get("-1001:47")?.state.kind).toBe("exempt");
    expect(
      workerEvents.some((event) =>
        event.type === "verificationDelete" &&
        event.userId === 47
      )
    ).toBeTrue();
  });

  test("同一成员高频楼中楼消息只保留一个可更新确认 owner", async () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 7,
      verifications: [pendingRecord(48, 7)],
    });

    for (let messageId: number = 800; messageId < 820; messageId++) {
      runtime.handleTrackedMessage({
        type: "message",
        chatId: -1001,
        userId: 48,
        messageId,
        isThreadReply: true,
      });
    }

    expect(chatRequests).toHaveLength(1);
    expect(threadCommentConfirmations.size).toBe(1);
    expect(
      threadCommentConfirmations.get("-1001:48")?.messageId
    ).toBe(819);

    chatRequests[0]!.resolve({ id: -1001, type: "supergroup" });
    await settleAsyncWork();
    expect(threadCommentConfirmations.size).toBe(0);
  });

  test("群停管后 getChat 迟到成功也不能再写 recent comment", async () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 8,
      verifications: [],
    });
    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 49,
      messageId: 900,
      isThreadReply: true,
    });
    expect(threadCommentConfirmations.has("-1001:49")).toBeTrue();

    runtime.deactivateVerificationChat(-1001);
    chatRequests[0]!.resolve({
      id: -1001,
      type: "supergroup",
      linked_chat_id: -2001,
    });
    await settleAsyncWork();

    expect(threadCommentConfirmations.has("-1001:49")).toBeFalse();
    expect(recentChannelComments.has("-1001:49")).toBeFalse();
  });

  test("同 key 新 owner 不接受停管前旧回调的消息", async () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 9,
      verifications: [],
    });
    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 50,
      messageId: 901,
      isThreadReply: true,
    });
    runtime.deactivateVerificationChat(-1001);
    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 50,
      messageId: 902,
      isThreadReply: true,
    });
    expect(chatRequests).toHaveLength(1);

    chatRequests[0]!.resolve({
      id: -1001,
      type: "supergroup",
      linked_chat_id: -2001,
    });
    await settleAsyncWork();

    expect(recentChannelComments.get("-1001:50")?.messageId).toBe(902);
  });

  test("确认 owner 达到全局硬顶后拒绝新增并保持 fail-closed", () => {
    for (
      let index: number = 0;
      index < THREAD_COMMENT_CONFIRMATION_MAX;
      index++
    ) {
      threadCommentConfirmations.set(`full:${index}`, {
        messageId: index,
        observedAt: 0,
        expectedState: undefined,
        boundToJoin: false,
        allowFloodTerminalExemption: false,
      });
    }

    runtime.handleTrackedMessage({
      type: "message",
      chatId: -1001,
      userId: 51,
      messageId: 903,
      isThreadReply: true,
    });

    expect(threadCommentConfirmations.size).toBe(
      THREAD_COMMENT_CONFIRMATION_MAX
    );
    expect(threadCommentConfirmations.has("-1001:51")).toBeFalse();
    expect(chatRequests).toHaveLength(0);
    expect(recentChannelComments.has("-1001:51")).toBeFalse();
  });
});
