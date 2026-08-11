/** Anti-Raid 镜像的落盘屏障、lockdown 持久化排队与放弃自愈后的恢复。 */

import { describe, expect, test } from "bun:test";

import type {
  AntiRaidWorkerMessage,
} from "../../../packages/types";

const {
  activeVerificationSnapshots,
  chatStates,
  deferred,
  flushDiskIO,
  flushStateToDisk,
  record,
  restoreLockdownInvitePermission,
  saveState,
  saveStateInBackground,
  settleAntiRaidDrain,
  workerHooks,
  workerPosts,
  installAntiRaidMirrorHooks,
} = await import("../../helpers/antiRaidMirrorHarness");

type FlushResult = "flushed" | "timedOut" | "failed";

const antiRaid = await import("../../../packages/antiRaid");

installAntiRaidMirrorHooks({
  initAntiRaid: antiRaid.initAntiRaid,
  terminateAntiRaid: antiRaid.terminateAntiRaid,
});

describe("Anti-Raid mirror persistence barriers", () => {
  test("倒计时刷新不再多花一轮整文件重写：持久化指纹刻意忽略 expiresAt", async () => {
    // 私密模式生效期间，每条越过阈值的入群都会让 Worker 重发一次 lockdown 事件，
    // 而事件里的 expiresAt 是当场 Date.now() + LOCKDOWN_MS 算出来的，每次都不一样。
    // 把它算进指纹的话，对账循环永远等不到「存下去的还是当前这份」，每轮一次带
    // fsync 的 state.json + .bak 整文件重写；入群比这两次写更快时循环不终止，
    // 既写不下指纹也发不出 lockdownPersisted，紧急封锁的握手就此卡死。
    workerPosts.length = 0;
    saveState.mockClear();

    for (const expiresAt of [400_000, 500_000, 600_000]) {
      workerHooks.supervisorOptions!.onEvent({
        type: "lockdown",
        chatId: -2004,
        phase: "active",
        intentId: 90,
        originalPermissions: { can_invite_users: true },
        announced: true,
        expiresAt,
      });
      await Bun.sleep(0);
      await Bun.sleep(0);
    }

    // 每条事件各自一次落盘，但没有任何一条因为倒计时变了而重来一轮。
    expect(saveState).toHaveBeenCalledTimes(3);
    expect(workerPosts.filter((message) => message.type === "lockdownPersisted" && message.chatId === -2004)).toEqual([
      { type: "lockdownPersisted", chatId: -2004, phase: "active", intentId: 90 },
      { type: "lockdownPersisted", chatId: -2004, phase: "active", intentId: 90 },
      { type: "lockdownPersisted", chatId: -2004, phase: "active", intentId: 90 },
    ]);
  });

  test("chat_member update 必须依次跨过 Worker barrier 与两类落盘后才结算", async () => {
    workerPosts.length = 0;
    flushDiskIO.mockClear();
    flushStateToDisk.mockClear();
    const diskGate = deferred<FlushResult>();
    const stateGate = deferred<FlushResult>();
    flushDiskIO.mockImplementationOnce(() => diskGate.promise);
    flushStateToDisk.mockImplementationOnce(() => stateGate.promise);
    const { antiRaidRuntimeState } = await import("../../../packages/cache/main/antiRaid/proxy");
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

    await Bun.sleep(0);
    const barrier = workerPosts.at(-1);
    expect(barrier?.type).toBe("barrier");
    workerHooks.supervisorOptions!.onEvent({
      type: "verificationUpsert",
      record: { ...record(antiRaidRuntimeState.generation, 1), chatId: -3001, userId: 77 },
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(flushDiskIO).not.toHaveBeenCalled();
    expect(flushStateToDisk).not.toHaveBeenCalled();

    if (barrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
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

  test("匿名模式切换会更新邀请者豁免，但匿名管理员本人仍按管理员身份免验证", async () => {
    workerPosts.length = 0;
    const anonymityChanged = antiRaid.handleChatMemberUpdate({
      me: { id: 99 },
      chatMember: {
        chat: { id: -3010 },
        from: { id: 7 },
        old_chat_member: {
          status: "administrator",
          is_anonymous: false,
          user: { id: 80, first_name: "Admin" },
        },
        new_chat_member: {
          status: "administrator",
          is_anonymous: true,
          user: { id: 80, first_name: "Admin" },
        },
      },
    } as never);
    await Bun.sleep(0);
    expect(workerPosts[0]).toEqual({
      type: "adminsChanged",
      chatId: -3010,
      userId: 80,
      isInviterExempt: false,
    });
    let barrier = workerPosts.at(-1);
    if (barrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }
    await anonymityChanged;

    workerPosts.length = 0;
    const anonymousAdminJoined = antiRaid.handleChatMemberUpdate({
      me: { id: 99 },
      chatMember: {
        chat: { id: -3011 },
        from: { id: 8 },
        old_chat_member: { status: "left", user: { id: 81, first_name: "Owner" } },
        new_chat_member: {
          status: "administrator",
          is_anonymous: true,
          user: { id: 81, first_name: "Owner" },
        },
      },
    } as never);
    await Bun.sleep(0);
    expect(workerPosts[0]).toMatchObject({
      type: "join",
      chatId: -3011,
      member: { id: 81, first_name: "Owner" },
      exempt: true,
      actorId: 8,
    });
    barrier = workerPosts.at(-1);
    if (barrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }
    await anonymousAdminJoined;
  });

  test("barrier 后任一持久化 owner 失败，安全 update 必须 reject", async () => {
    workerPosts.length = 0;
    flushDiskIO.mockResolvedValueOnce("failed");
    const { antiRaidRuntimeState } = await import("../../../packages/cache/main/antiRaid/proxy");
    const handled = antiRaid.handleChatMemberUpdate({
      me: { id: 99 },
      chatMember: {
        chat: { id: -3002 },
        from: { id: 8 },
        old_chat_member: { status: "left", user: { id: 78 } },
        new_chat_member: { status: "member", user: { id: 78, first_name: "Newer" } },
      },
    } as never);
    await Bun.sleep(0);
    const barrier = workerPosts.at(-1);
    workerHooks.supervisorOptions!.onEvent({
      type: "verificationUpsert",
      record: { ...record(antiRaidRuntimeState.generation, 1), chatId: -3002, userId: 78 },
    });
    if (barrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
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
    await Bun.sleep(0);
    expect(workerPosts.at(-1)?.type).toBe("barrier");

    workerHooks.supervisorOptions!.onRespawn((): boolean => true);

    await expect(handled).rejects.toThrow("Anti-Raid Worker barrier failed");
    expect(flushDiskIO).not.toHaveBeenCalled();
    expect(flushStateToDisk).not.toHaveBeenCalled();
  });

  test("drain 超时会清理 waiter，迟到回执不能改变失败结果", async () => {
    workerPosts.length = 0;
    const result = antiRaid.drainAntiRaid(1);
    const firstBarrier = workerPosts.at(-1);

    await expect(result).resolves.toBe("timedOut");
    const nextBoundaryIndex: number = workerPosts.length;
    const nextResult = antiRaid.drainAntiRaid(1_000);
    let nextSettled: boolean = false;
    void nextResult.finally(() => { nextSettled = true; });
    if (firstBarrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({
        type: "barrierComplete",
        barrierId: firstBarrier.barrierId,
      });
    }
    await Bun.sleep(0);
    expect(nextSettled).toBeFalse();
    await expect(
      settleAntiRaidDrain(nextResult, nextBoundaryIndex)
    ).resolves.toBe("flushed");
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
        workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
      }
      await handled;
      expect(settled).toBe(true);
    }

    await expectOwnBarrier(
      () => antiRaid.handleAntiRaidMessageIngress({
        chat: { id: -5001 },
        from: { id: 20 },
        message_id: 60,
        new_chat_members: [{ id: 201, first_name: "Join" }],
      } as never, 99),
      "join"
    );
    await expectOwnBarrier(
      () => antiRaid.handleAntiRaidMessageIngress({
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

  test("入群事件晚到时仍转交直属评论与楼中楼线索，普通非待验证消息不进入 Worker", async () => {
    workerPosts.length = 0;
    const comment = antiRaid.handleAntiRaidMessageIngress({
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
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }
    await comment;

    workerPosts.length = 0;
    const threadReply = antiRaid.handleAntiRaidMessageIngress({
      chat: { id: -4001 },
      from: { id: 89 },
      message_id: 56,
      message_thread_id: 55,
    } as never, 99);
    await Bun.sleep(0);
    const threadBarrier = workerPosts.at(-1);
    expect(workerPosts[0]).toMatchObject({
      type: "message",
      chatId: -4001,
      userId: 89,
      isThreadReply: true,
    });
    if (threadBarrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: threadBarrier.barrierId });
    }
    await threadReply;

    workerPosts.length = 0;
    await antiRaid.handleAntiRaidMessageIngress({
      chat: { id: -4001 },
      from: { id: 90 },
      message_id: 57,
    } as never, 99);
    expect(workerPosts).toHaveLength(0);
  });

  test("论坛话题消息不是评论区候选：不投递、不加投 barrier", async () => {
    workerPosts.length = 0;
    // 开了 topics 的超级群里每条普通消息都带 message_thread_id；只有关联频道
    // 讨论组的评论线程才算候选，论坛话题必须走普通非待验证语义。
    await antiRaid.handleAntiRaidMessageIngress({
      chat: { id: -4001 },
      from: { id: 91 },
      message_id: 58,
      message_thread_id: 77,
      is_topic_message: true,
    } as never, 99);

    expect(workerPosts).toHaveLength(0);
  });

  test("待验证用户在论坛话题里发言仍被追踪，但不标记为评论线索", async () => {
    activeVerificationSnapshots.set("-4001:92", { ...record(1, 1), chatId: -4001, userId: 92 });
    workerPosts.length = 0;

    const topicMessage = antiRaid.handleAntiRaidMessageIngress({
      chat: { id: -4001 },
      from: { id: 92 },
      message_id: 59,
      message_thread_id: 77,
      is_topic_message: true,
    } as never, 99);
    await Bun.sleep(0);
    const topicBarrier = workerPosts.at(-1);

    expect(workerPosts[0]).toMatchObject({
      type: "message",
      chatId: -4001,
      userId: 92,
      isThreadReply: false,
      repliesToChannelPost: false,
    });
    if (topicBarrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: topicBarrier.barrierId });
    }
    await topicMessage;
    activeVerificationSnapshots.delete("-4001:92");
  });

  test("Worker 放弃自愈后主线程恢复权限、重试失败群且不清除更新后的 intent", async () => {
    chatStates.clear();
    restoreLockdownInvitePermission.mockClear();
    saveStateInBackground.mockClear();
    antiRaid.initAntiRaid();

    const successfulChatId = -6001;
    const retryChatId = -6002;
    const changedChatId = -6003;
    const stoppedChatId = -6004;
    for (const [chatId, intentId, phase] of [
      [successfulChatId, 101, "applying"],
      [retryChatId, 102, "active"],
      [changedChatId, 103, "active"],
    ] as const) {
      chatStates.set(chatId, {
        lockdown: {
          phase,
          intentId,
          originalPermissions: { can_invite_users: true, can_send_messages: true },
          announced: phase !== "applying",
          expiresAt: 10_000 + intentId,
        },
      });
    }

    let retryAttempts: number = 0;
    const changedRestore = deferred<void>();
    const stoppedRestore = deferred<void>();
    restoreLockdownInvitePermission.mockImplementation(async (input: unknown): Promise<void> => {
      const chatId: number = (input as { chatId: number }).chatId;
      if (chatId === retryChatId && retryAttempts++ === 0) throw new Error("temporary Telegram failure");
      if (chatId === changedChatId) await changedRestore.promise;
      if (chatId === stoppedChatId) await stoppedRestore.promise;
    });

    workerHooks.supervisorOptions!.onGiveUp();
    chatStates.get(changedChatId)!.lockdown = {
      phase: "active",
      intentId: 999,
      originalPermissions: { can_invite_users: false },
      announced: true,
      expiresAt: 99_999,
    };
    changedRestore.resolve(undefined);
    await Bun.sleep(20);

    expect(chatStates.get(successfulChatId)?.lockdown).toBeUndefined();
    expect(chatStates.get(retryChatId)?.lockdown).toBeUndefined();
    expect(chatStates.get(changedChatId)?.lockdown?.intentId).toBe(999);
    expect(restoreLockdownInvitePermission.mock.calls.filter(([input]) =>
      (input as { chatId: number }).chatId === retryChatId
    )).toHaveLength(2);
    expect(restoreLockdownInvitePermission.mock.calls.filter(([input]) =>
      (input as { chatId: number }).chatId === changedChatId
    )).toHaveLength(1);
    expect(saveStateInBackground).toHaveBeenCalledTimes(2);

    chatStates.clear();
    chatStates.set(stoppedChatId, {
      lockdown: {
        phase: "restoring",
        intentId: 104,
        originalPermissions: { can_invite_users: true },
        announced: true,
        expiresAt: 10_104,
      },
    });
    workerHooks.supervisorOptions!.onGiveUp();
    await Bun.sleep(0);
    const terminationResult = await Promise.race([
      antiRaid.terminateAntiRaid().then(() => "terminated" as const),
      Bun.sleep(50).then(() => "timedOut" as const),
    ]);

    expect(terminationResult).toBe("terminated");
    expect(restoreLockdownInvitePermission.mock.calls.filter(([input]) =>
      (input as { chatId: number }).chatId === stoppedChatId
    )).toHaveLength(1);
    const { emergencyLockdownRecoveries, emergencyLockdownRecoveryRuntime } = await import("../../../packages/cache/main/antiRaid/lockdownMirror");
    expect(emergencyLockdownRecoveries.size).toBe(0);
    expect(emergencyLockdownRecoveryRuntime.stopped).toBeTrue();
    expect(chatStates.get(stoppedChatId)?.lockdown?.intentId).toBe(104);

    stoppedRestore.resolve(undefined);
    await Bun.sleep(0);
    expect(chatStates.get(stoppedChatId)?.lockdown?.intentId).toBe(104);
    expect(saveStateInBackground).toHaveBeenCalledTimes(2);
  });
});
