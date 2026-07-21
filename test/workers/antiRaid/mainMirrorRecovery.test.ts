import { describe, expect, mock, test } from "bun:test";
import type {
  AntiRaidWorkerEvent,
  AntiRaidWorkerMessage,
  VerificationDeleteDiskMessage,
  VerificationPersistedReply,
  VerificationSnapshot,
  VerificationUpsertDiskMessage,
} from "../../../src/types";

const workerPosts: AntiRaidWorkerMessage[] = [];
const diskPosts: (VerificationUpsertDiskMessage | VerificationDeleteDiskMessage)[] = [];
let supervisorOptions: {
  onEvent: (event: AntiRaidWorkerEvent) => void;
  onRespawn: (post: (message: AntiRaidWorkerMessage) => void) => void;
} | undefined;
let diskRespawn: (() => void) | undefined;
let persistedAck: ((reply: VerificationPersistedReply) => void) | undefined;
const chatStates = new Map<number, { lockdown?: {
  phase?: "applying" | "active" | "restoring";
  intentId?: number;
  originalPermissions: Record<string, boolean | undefined>;
  expiresAt: number;
} }>();
const saveState = mock(async (): Promise<void> => {});
type FlushResult = "flushed" | "timedOut" | "failed";
const flushStateToDisk = mock(async (): Promise<FlushResult> => "flushed");
const flushDiskIO = mock(async (): Promise<FlushResult> => "flushed");

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

mock.module("../../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../src/infra/storage/stateStore", () => ({
  clearChatStateField: (chatId: number, field: "lockdown"): boolean => {
    const state = chatStates.get(chatId);
    if (!state || !(field in state)) return false;
    delete state[field];
    return true;
  },
  getAllChatStates: () => chatStates,
  getOrCreateChatState: (chatId: number) => {
    const current = chatStates.get(chatId) ?? {};
    chatStates.set(chatId, current);
    return current;
  },
  saveState,
  flushStateToDisk,
  saveStateInBackground(): void {},
}));
mock.module("../../../src/infra/telegram/actions", () => ({ answerCallbackQuery: async (): Promise<boolean> => true }));
mock.module("../../../src/infra/botAdmin", () => ({
  isBotAdminIn: async (): Promise<boolean> => true,
  markBotAdminObserved(): void {},
}));
mock.module("../../../src/libs/supervisedWorker", () => ({
  superviseWorker: (options: typeof supervisorOptions) => {
    supervisorOptions = options;
    return {
      init(): void {},
      post: (message: AntiRaidWorkerMessage): boolean => { workerPosts.push(message); return true; },
      terminate: async (): Promise<void> => {},
    };
  },
}));
mock.module("../../../src/workers/antiRaid/persistence", () => ({
  flushDiskIO,
  postDiskIO: (message: VerificationUpsertDiskMessage | VerificationDeleteDiskMessage): void => { diskPosts.push(message); },
  onDiskIORespawn: (callback: () => void): void => { diskRespawn = callback; },
  onVerificationPersisted: (callback: (reply: VerificationPersistedReply) => void): void => { persistedAck = callback; },
}));

const antiRaid = await import("../../../src/antiRaid");
const { activeVerificationSnapshots, pendingVerificationDeletes } = await import("../../../src/cache/antiRaid");

function record(generation: number, revision: number): VerificationSnapshot {
  return {
    chatId: -1001,
    userId: 42,
    generation,
    revision,
    label: "待验证成员",
    isBot: false,
    messageIds: [10],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 121_000,
  };
}

describe("Anti-Raid main-thread persistence mirror", () => {
  test("replays active and unconfirmed deletes while rejecting old generations", async () => {
    antiRaid.hydratePendingVerifications(new Map([["-1001:42", record(9, 1)]]));
    antiRaid.initAntiRaid();
    const barrier = antiRaid.drainAntiRaid(1_000);
    const barrierMessage = workerPosts.at(-1);
    expect(barrierMessage?.type).toBe("barrier");
    if (barrierMessage?.type === "barrier") {
      supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrierMessage.barrierId });
    }
    await expect(barrier).resolves.toBe("flushed");
    supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(1, 2) });
    supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(0, 99) });
    supervisorOptions!.onEvent({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 3 });
    diskRespawn!();
    expect(pendingVerificationDeletes.size).toBe(1);
    persistedAck!({ type: "verificationPersisted", key: "-1001:42", generation: 1, revision: 3, deleted: true });
    expect(pendingVerificationDeletes.size).toBe(0);

    supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(1, 4) });
    const respawnPosts: AntiRaidWorkerMessage[] = [];
    supervisorOptions!.onRespawn((message) => { respawnPosts.push(message); });
    supervisorOptions!.onEvent({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 5 });

    expect(workerPosts[0]).toMatchObject({ type: "adoptVerifications", generation: 1, verifications: [{ revision: 1 }] });
    expect(diskPosts.map((message) => ({
      type: message.type,
      revision: message.type === "verificationUpsert" ? message.record.revision : message.revision,
      critical: message.type === "verificationUpsert" ? message.critical : undefined,
    }))).toEqual([
      { type: "verificationUpsert", revision: 2, critical: false },
      { type: "verificationDelete", revision: 3, critical: undefined },
      { type: "verificationDelete", revision: 3, critical: undefined },
      { type: "verificationUpsert", revision: 4, critical: true },
    ]);
    expect(respawnPosts).toEqual([expect.objectContaining({
      type: "adoptVerifications",
      generation: 2,
      verifications: [expect.objectContaining({ revision: 4 })],
    })]);
    expect(activeVerificationSnapshots.get("-1001:42")?.revision).toBe(4);
  });

  test("Worker 重建不会把尚未完成 saveState 的 lockdown 镜像当成已持久化", async () => {
    let releaseSave: (() => void) | undefined;
    saveState.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSave = resolve; }));
    supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2002,
      phase: "applying",
      intentId: 77,
      originalPermissions: { can_invite_users: true },
      expiresAt: 123_456,
    });

    const respawnPosts: AntiRaidWorkerMessage[] = [];
    supervisorOptions!.onRespawn((message) => { respawnPosts.push(message); });
    const adopt = respawnPosts.find((message) => message.type === "adopt");
    expect(adopt).toEqual({
      type: "adopt",
      lockdowns: [expect.objectContaining({ chatId: -2002, phase: "applying", intentId: 77, persisted: false })],
    });
    expect(workerPosts.some((message) => message.type === "lockdownPersisted" && message.chatId === -2002)).toBe(false);

    releaseSave?.();
    await Bun.sleep(0);
    expect(workerPosts).toContainEqual({
      type: "lockdownPersisted",
      chatId: -2002,
      phase: "applying",
      intentId: 77,
    });
  });

  test("同群连续 lockdown 快照共用一个在途 waiter，并在完成后补写最新阶段", async () => {
    workerPosts.length = 0;
    saveState.mockClear();
    let releaseSave: (() => void) | undefined;
    saveState.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSave = resolve; }));

    supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2003,
      phase: "active",
      intentId: 88,
      originalPermissions: { can_invite_users: true },
      expiresAt: 200_000,
    });
    supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2003,
      phase: "active",
      intentId: 88,
      originalPermissions: { can_invite_users: true },
      expiresAt: 300_000,
    });
    expect(saveState).toHaveBeenCalledTimes(1);

    releaseSave?.();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(saveState).toHaveBeenCalledTimes(2);
    expect(workerPosts.filter((message) => message.type === "lockdownPersisted" && message.chatId === -2003)).toEqual([{
      type: "lockdownPersisted",
      chatId: -2003,
      phase: "active",
      intentId: 88,
    }]);
  });

  test("chat_member update 必须依次跨过 Worker barrier 与两类落盘后才结算", async () => {
    workerPosts.length = 0;
    flushDiskIO.mockClear();
    flushStateToDisk.mockClear();
    const diskGate = deferred<FlushResult>();
    const stateGate = deferred<FlushResult>();
    flushDiskIO.mockImplementationOnce(() => diskGate.promise);
    flushStateToDisk.mockImplementationOnce(() => stateGate.promise);
    const { antiRaidRuntimeState } = await import("../../../src/cache/antiRaid");
    let settled: boolean = false;
    const handled = antiRaid.handleChatMemberUpdate({
      me: { id: 99 },
      chatMember: {
        chat: { id: -3001 },
        from: { id: 7 },
        old_chat_member: { status: "left", user: { id: 77 } },
        new_chat_member: { status: "member", user: { id: 77, first_name: "New" } },
      },
    } as never).finally(() => { settled = true; });

    const barrier = workerPosts.at(-1);
    expect(barrier?.type).toBe("barrier");
    supervisorOptions!.onEvent({
      type: "verificationUpsert",
      record: { ...record(antiRaidRuntimeState.generation, 1), chatId: -3001, userId: 77 },
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(flushDiskIO).not.toHaveBeenCalled();
    expect(flushStateToDisk).not.toHaveBeenCalled();

    if (barrier?.type === "barrier") {
      supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }
    await Bun.sleep(0);
    expect(flushDiskIO).toHaveBeenCalledTimes(1);
    expect(flushStateToDisk).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    diskGate.resolve("flushed");
    await Bun.sleep(0);
    expect(settled).toBe(false);
    stateGate.resolve("flushed");
    await handled;
    expect(settled).toBe(true);
  });

  test("barrier 后任一持久化 owner 失败，安全 update 必须 reject", async () => {
    workerPosts.length = 0;
    flushDiskIO.mockResolvedValueOnce("failed");
    const { antiRaidRuntimeState } = await import("../../../src/cache/antiRaid");
    const handled = antiRaid.handleChatMemberUpdate({
      me: { id: 99 },
      chatMember: {
        chat: { id: -3002 },
        from: { id: 8 },
        old_chat_member: { status: "left", user: { id: 78 } },
        new_chat_member: { status: "member", user: { id: 78, first_name: "Newer" } },
      },
    } as never);
    const barrier = workerPosts.at(-1);
    supervisorOptions!.onEvent({
      type: "verificationUpsert",
      record: { ...record(antiRaidRuntimeState.generation, 1), chatId: -3002, userId: 78 },
    });
    if (barrier?.type === "barrier") {
      supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }

    await expect(handled).rejects.toThrow("Anti-Raid persistence failed: disk=failed, state=flushed");
  });

  test("Worker 在 barrier 等待期间重建会立即失败，不把旧实例回执当成功", async () => {
    workerPosts.length = 0;
    flushDiskIO.mockClear();
    flushStateToDisk.mockClear();
    const handled = antiRaid.handleChatMemberUpdate({
      me: { id: 99 },
      chatMember: {
        chat: { id: -3003 },
        from: { id: 9 },
        old_chat_member: { status: "left", user: { id: 79 } },
        new_chat_member: { status: "member", user: { id: 79, first_name: "Newest" } },
      },
    } as never);
    expect(workerPosts.at(-1)?.type).toBe("barrier");

    supervisorOptions!.onRespawn((): void => {});

    await expect(handled).rejects.toThrow("Anti-Raid Worker barrier failed");
    expect(flushDiskIO).not.toHaveBeenCalled();
    expect(flushStateToDisk).not.toHaveBeenCalled();
  });

  test("barrier 超时会清理 waiter，迟到回执不能改变失败结果", async () => {
    workerPosts.length = 0;
    const result = antiRaid.drainAntiRaid(1);
    const barrier = workerPosts.at(-1);

    await expect(result).resolves.toBe("timedOut");
    const nextResult = antiRaid.drainAntiRaid(1_000);
    const nextBarrier = workerPosts.at(-1);
    let nextSettled: boolean = false;
    void nextResult.finally(() => { nextSettled = true; });
    if (barrier?.type === "barrier") {
      supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }
    await Bun.sleep(0);
    expect(nextSettled).toBeFalse();
    if (nextBarrier?.type === "barrier") {
      supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: nextBarrier.barrierId });
    }
    await expect(nextResult).resolves.toBe("flushed");
  });

  test("服务消息与验证按钮入口都把各自 barrier 纳入返回 Promise", async () => {
    async function expectOwnBarrier(
      start: () => Promise<unknown>,
      expectedMessageType: AntiRaidWorkerMessage["type"]
    ): Promise<void> {
      workerPosts.length = 0;
      let settled: boolean = false;
      const handled = start().finally(() => { settled = true; });
      await Bun.sleep(0);
      expect(workerPosts[0]?.type).toBe(expectedMessageType);
      const barrier = workerPosts.at(-1);
      expect(barrier?.type).toBe("barrier");
      await Bun.sleep(0);
      expect(settled).toBe(false);
      if (barrier?.type === "barrier") {
        supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
      }
      await handled;
      expect(settled).toBe(true);
    }

    await expectOwnBarrier(
      () => antiRaid.handleGroupJoinVerification({
        chat: { id: -5001 },
        from: { id: 20 },
        message_id: 60,
        new_chat_members: [{ id: 201, first_name: "Join" }],
      } as never, 99),
      "join"
    );
    await expectOwnBarrier(
      () => antiRaid.handleGroupJoinVerification({
        chat: { id: -5002 },
        from: { id: 21 },
        message_id: 61,
        left_chat_member: { id: 202, first_name: "Left" },
      } as never, 99),
      "left"
    );
    await expectOwnBarrier(
      () => antiRaid.handleVerificationCallback({
        callbackQuery: {
          id: "callback-1",
          data: "verify:203",
          message: { chat: { id: -5003 } },
          from: { id: 203, first_name: "Verify" },
        },
      } as never),
      "callback"
    );
  });

  test("入群事件晚到时仍转交评论区线索，普通非待验证消息不进入 Worker", async () => {
    workerPosts.length = 0;
    const comment = antiRaid.handleGroupJoinVerification({
      chat: { id: -4001 },
      from: { id: 88 },
      message_id: 55,
      reply_to_message: { is_automatic_forward: true },
    } as never, 99);
    await Bun.sleep(0);
    const barrier = workerPosts.at(-1);
    expect(workerPosts[0]).toMatchObject({
      type: "message",
      chatId: -4001,
      userId: 88,
      repliesToChannelPost: true,
    });
    if (barrier?.type === "barrier") {
      supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }
    await comment;

    workerPosts.length = 0;
    await antiRaid.handleGroupJoinVerification({
      chat: { id: -4001 },
      from: { id: 89 },
      message_id: 56,
    } as never, 99);
    expect(workerPosts).toHaveLength(0);
  });
});
