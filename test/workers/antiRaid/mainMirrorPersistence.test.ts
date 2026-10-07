/** Anti-Raid 镜像的落盘屏障、lockdown 持久化排队与放弃自愈后的恢复。 */

import { describe, expect, test } from "bun:test";
import { waitUntil } from "../../helpers/waitUntil";

import type { AntiRaidWorkerEvent } from "../../../packages/types/antiRaid/events";
import type { AntiRaidWorkerMessage } from "../../../packages/types/antiRaid/protocol";

const {
  activeVerificationSnapshots,
  antiRaidRuntimeState,
  chatStates,
  flushDiskIODomain,
  loggerError,
  pendingLockdownPersistence,
  persistedLockdownFingerprints,
  queuedLockdownPersistence,
  record,
  rejectedWorkerPostTypes,
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
const { LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS } = await import("../../../packages/consts/antiRaid/protocol");

/** 对账轮数用尽时 events.ts 记下的那一行错误。 */
function reconcileExhaustedLog(chatId: number): string {
  return `Anti-raid lockdown intent for chat ${chatId} kept changing across ` +
    `${LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS} durability rounds; yielding before retrying the latest intent.`;
}

/** Worker 发往主线程、针对 chatId 的全部消息。 */
function workerPostsFor(chatId: number): AntiRaidWorkerMessage[] {
  return workerPosts.filter((message: AntiRaidWorkerMessage): boolean =>
    "chatId" in message && message.chatId === chatId);
}

installAntiRaidMirrorHooks({
  initAntiRaid: antiRaid.initAntiRaid,
  terminateAntiRaid: antiRaid.terminateAntiRaid,
});

describe("Anti-Raid mirror persistence barriers", () => {
  test("倒计时刷新不再多花一轮整文件重写：持久化指纹刻意忽略 expiresAt", async () => {
    // 私密模式生效期间，每条越过阈值的入群都让 Worker 重发一次 lockdown 事件，事件里的 expiresAt 每次不同；
    // 持久化指纹忽略 expiresAt，对账循环据此判定「存下去的还是当前这份」。
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

  test("落盘自检过不了的 lockdown intent 绝不进内存，Worker 立刻 fail-safe 打开", async () => {
    // Telegram 给 getChat().permissions 新增一个字段就是这个形态：严格解码器不认识它。
    // 记录必须先通过落盘自检才能进入内存 ChatState。
    workerPosts.length = 0;
    saveState.mockClear();
    chatStates.delete(-2005);
    const unknownPermissionField = {
      type: "lockdown",
      chatId: -2005,
      phase: "applying",
      intentId: 91,
      originalPermissions: { can_invite_users: true, can_send_confetti: true },
      announced: true,
      expiresAt: 700_000,
    } as unknown as AntiRaidWorkerEvent;

    workerHooks.supervisorOptions!.onEvent(unknownPermissionField);
    await Bun.sleep(0);

    expect(chatStates.get(-2005)?.lockdown).toBeUndefined();
    expect(saveState).not.toHaveBeenCalled();
    expect(workerPosts.filter((message) => message.type === "lockdownPersistFailed")).toEqual([
      { type: "lockdownPersistFailed", chatId: -2005, phase: "applying", intentId: 91 },
    ]);
  });

  test("intent 落不了盘时保留恢复记录，Worker 确认解锁后才删除", async () => {
    workerPosts.length = 0;
    saveState.mockClear();
    saveStateInBackground.mockClear();
    saveState.mockImplementationOnce(async (): Promise<void> => {
      throw new Error("disk is full");
    });

    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2006,
      phase: "active",
      intentId: 92,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt: 800_000,
    });
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(chatStates.get(-2006)?.lockdown?.intentId).toBe(92);
    expect(saveStateInBackground).not.toHaveBeenCalled();
    expect(workerPosts.filter((message) => message.type === "lockdownPersistFailed")).toEqual([
      { type: "lockdownPersistFailed", chatId: -2006, phase: "active", intentId: 92 },
    ]);
    // 没落定的 intent 不发出「已落盘」回执。
    expect(workerPosts.some((message) =>
      message.type === "lockdownPersisted" && message.chatId === -2006
    )).toBeFalse();
    workerHooks.supervisorOptions!.onEvent({ type: "unlock", chatId: -2006 });
    expect(chatStates.get(-2006)?.lockdown).toBeUndefined();
    expect(saveStateInBackground).toHaveBeenCalledWith("anti-raid unlock");
  });

  test("落盘失败期间意图已经换代 → 不动更新的那份，只把作废通知发回 Worker", async () => {
    workerPosts.length = 0;
    saveState.mockClear();
    saveStateInBackground.mockClear();
    // 写盘在途时新一轮把记录换掉了：这条失败属于上一份意图，不清掉现在这份。
    saveState.mockImplementationOnce(async (): Promise<void> => {
      const state = chatStates.get(-2007);
      if (state?.lockdown !== undefined) state.lockdown.intentId = 93;
      throw new Error("disk is full");
    });

    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2007,
      phase: "active",
      intentId: 92,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt: 800_000,
    });
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(chatStates.get(-2007)?.lockdown?.intentId).toBe(93);
    expect(saveStateInBackground).not.toHaveBeenCalled();
    expect(workerPosts.filter((message) => message.type === "lockdownPersistFailed")).toEqual([
      { type: "lockdownPersistFailed", chatId: -2007, phase: "active", intentId: 92 },
    ]);
  });

  test("intent 已落盘但 Worker 拒收回执：循环外层接住投递异常并记日志，释放 pending，保留已落盘指纹", async () => {
    rejectedWorkerPostTypes.add("lockdownPersisted");

    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2008,
      phase: "active",
      intentId: 94,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt: 900_000,
    });
    await waitUntil((): boolean => !pendingLockdownPersistence.has(-2008));

    expect(saveState).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls).toEqual([[
      "Anti-raid lockdown durability loop for chat -2008 failed:",
      expect.objectContaining({ message: "Anti-Raid Worker is unavailable." }),
    ]]);
    expect(pendingLockdownPersistence.has(-2008)).toBeFalse();
    expect(queuedLockdownPersistence.has(-2008)).toBeFalse();
    expect(persistedLockdownFingerprints.get(-2008)).toEqual({
      phase: "active",
      intentId: 94,
      announced: true,
    });
    expect(chatStates.get(-2008)?.lockdown?.intentId).toBe(94);
    expect(workerPosts.some((message: AntiRaidWorkerMessage): boolean =>
      message.type === "lockdownPersisted" && message.chatId === -2008
    )).toBeFalse();
  });

  test("intent 落盘失败且 Worker 同时拒收作废通知：落盘失败与投递失败各记一行，恢复记录保留", async () => {
    const diskFull: Error = new Error("disk is full");
    saveState.mockImplementationOnce(async (): Promise<void> => {
      throw diskFull;
    });
    rejectedWorkerPostTypes.add("lockdownPersistFailed");

    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2009,
      phase: "applying",
      intentId: 95,
      originalPermissions: { can_invite_users: true },
      announced: false,
      expiresAt: 900_000,
    });
    await waitUntil((): boolean => !pendingLockdownPersistence.has(-2009));

    expect(loggerError.mock.calls).toEqual([
      ["Failed to persist anti-raid lockdown intent for chat -2009:", diskFull],
      [
        "Anti-raid lockdown durability loop for chat -2009 failed:",
        expect.objectContaining({ message: "Anti-Raid Worker is unavailable." }),
      ],
    ]);
    expect(chatStates.get(-2009)?.lockdown?.intentId).toBe(95);
    expect(persistedLockdownFingerprints.has(-2009)).toBeFalse();
    expect(workerPosts.some((message: AntiRaidWorkerMessage): boolean =>
      "chatId" in message && message.chatId === -2009
    )).toBeFalse();
  });

  test("落盘途中排队的续跑在 Anti-Raid 终止后不再发起", async () => {
    const release: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    saveState.mockImplementationOnce((): Promise<void> => release.promise);
    const publish = (expiresAt: number): void => workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2010,
      phase: "active",
      intentId: 96,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt,
    });

    publish(900_000);
    publish(900_500);
    expect(queuedLockdownPersistence.has(-2010)).toBeTrue();
    await antiRaid.terminateAntiRaid();
    expect(antiRaidRuntimeState.initialized).toBeFalse();

    release.resolve();
    await waitUntil((): boolean => !pendingLockdownPersistence.has(-2010));
    await Bun.sleep(0);

    expect(saveState).toHaveBeenCalledTimes(1);
    expect(pendingLockdownPersistence.has(-2010)).toBeFalse();
    expect(queuedLockdownPersistence.has(-2010)).toBeFalse();
  });

  test("解锁发生在 intent 落盘途中：不回执 lockdownPersisted，也不登记已落盘指纹", async () => {
    const release: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    saveState.mockImplementationOnce((): Promise<void> => release.promise);

    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2011,
      phase: "active",
      intentId: 97,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt: 900_000,
    });
    workerHooks.supervisorOptions!.onEvent({ type: "unlock", chatId: -2011 });
    expect(saveStateInBackground).toHaveBeenCalledWith("anti-raid unlock");

    release.resolve();
    await waitUntil((): boolean => !pendingLockdownPersistence.has(-2011));

    expect(saveState).toHaveBeenCalledTimes(1);
    expect(chatStates.get(-2011)?.lockdown).toBeUndefined();
    expect(persistedLockdownFingerprints.has(-2011)).toBeFalse();
    expect(workerPosts.some((message: AntiRaidWorkerMessage): boolean =>
      message.type === "lockdownPersisted" && message.chatId === -2011
    )).toBeFalse();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("每轮落盘途中意图都换代、用尽对账轮数：记一行错误，不回执也不登记已落盘指纹，finally 释放 pending", async () => {
    const chatId: number = -2013;
    const firstIntentId: number = 100;
    // 每次落盘途中把内存里的意图原地换一代，模拟恢复语义持续推进；不经事件入口，因此没有排队续跑。
    saveState.mockImplementation(async (): Promise<void> => {
      const state: { lockdown?: { intentId?: number } } | undefined = chatStates.get(chatId);
      if (state?.lockdown?.intentId !== undefined) state.lockdown.intentId += 1;
    });

    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId,
      phase: "active",
      intentId: firstIntentId,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt: 900_000,
    });
    expect(pendingLockdownPersistence.has(chatId)).toBeTrue();
    await waitUntil((): boolean => !pendingLockdownPersistence.has(chatId));
    await Bun.sleep(0);

    expect(saveState).toHaveBeenCalledTimes(LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS);
    expect(loggerError.mock.calls).toEqual([[reconcileExhaustedLog(chatId)]]);
    expect(workerPostsFor(chatId)).toEqual([]);
    expect(persistedLockdownFingerprints.has(chatId)).toBeFalse();
    expect(pendingLockdownPersistence.has(chatId)).toBeFalse();
    expect(queuedLockdownPersistence.has(chatId)).toBeFalse();
    // 最新意图仍留在内存里，等下一次事件再落盘。
    expect(chatStates.get(chatId)?.lockdown?.intentId).toBe(firstIntentId + LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS);
  });

  test("对账轮数用尽期间 Worker 又发来新意图：本任务记错误后让出，排队的续跑落定最新意图并只回执这一份", async () => {
    const chatId: number = -2014;
    const firstIntentId: number = 200;
    const lockdownEvent = (intentId: number): AntiRaidWorkerEvent => ({
      type: "lockdown",
      chatId,
      phase: "active",
      intentId,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt: 900_000 + intentId,
    });
    // 前 LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS 次落盘途中各到达一条换代的意图，之后不再换代。
    let saves: number = 0;
    saveState.mockImplementation(async (): Promise<void> => {
      saves += 1;
      if (saves <= LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS) {
        workerHooks.supervisorOptions!.onEvent(lockdownEvent(firstIntentId + saves));
      }
    });
    const latestIntentId: number = firstIntentId + LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS;

    workerHooks.supervisorOptions!.onEvent(lockdownEvent(firstIntentId));
    await waitUntil((): boolean => workerPostsFor(chatId).length > 0 && !pendingLockdownPersistence.has(chatId));
    await Bun.sleep(0);

    expect(saveState).toHaveBeenCalledTimes(LOCKDOWN_PERSIST_RECONCILE_MAX_ROUNDS + 1);
    expect(loggerError.mock.calls).toEqual([[reconcileExhaustedLog(chatId)]]);
    expect(workerPostsFor(chatId)).toEqual([
      { type: "lockdownPersisted", chatId, phase: "active", intentId: latestIntentId },
    ]);
    expect(persistedLockdownFingerprints.get(chatId)).toEqual({
      phase: "active",
      intentId: latestIntentId,
      announced: true,
    });
    expect(pendingLockdownPersistence.has(chatId)).toBeFalse();
    expect(queuedLockdownPersistence.has(chatId)).toBeFalse();
  });

  test("没有 lockdown 记录时收到 unlock：不排后台保存，也不推进持久化版本", () => {
    const version: number = antiRaidRuntimeState.lockdownVersion;

    workerHooks.supervisorOptions!.onEvent({ type: "unlock", chatId: -2012 });

    expect(saveStateInBackground).not.toHaveBeenCalled();
    expect(antiRaidRuntimeState.lockdownVersion).toBe(version);
  });

  test("chat_member update 必须依次跨过 Worker barrier 与变化镜像的领域屏障后才结算；只有验证变化时不刷 chatState", async () => {
    workerPosts.length = 0;
    flushDiskIODomain.mockClear();
    const verificationGate: PromiseWithResolvers<FlushResult> = Promise.withResolvers<FlushResult>();
    const chatStateGate: PromiseWithResolvers<FlushResult> = Promise.withResolvers<FlushResult>();
    flushDiskIODomain.mockImplementation((domain: string): Promise<FlushResult> =>
      domain === "verification" ? verificationGate.promise : chatStateGate.promise);
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
    expect(flushDiskIODomain).not.toHaveBeenCalled();

    if (barrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }
    await Bun.sleep(0);
    // 只刷变化过的验证镜像领域，不提交 chatState 屏障（它会提交整个共享 SQLite 事务）。
    expect(flushDiskIODomain.mock.calls.map((call: unknown[]): unknown => call[0]))
      .toEqual(["verification"]);
    expect(settled).toBe(false);

    verificationGate.resolve("flushed");
    await handled;
    expect(settled).toBe(true);
    chatStateGate.resolve("flushed");
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

  test("barrier 后任一领域屏障失败，安全 update 必须 reject", async () => {
    workerPosts.length = 0;
    flushDiskIODomain.mockImplementation(async (domain: string): Promise<FlushResult> =>
      domain === "verification" ? "failed" : "flushed");
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

    await expect(handled).rejects.toThrow("Anti-Raid persistence failed: verification=failed, chatState=flushed");
  });

  test("Worker 在 barrier 等待期间重建会立即失败，不把旧实例回执当成功", async () => {
    workerPosts.length = 0;
    flushDiskIODomain.mockClear();
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
    expect(flushDiskIODomain).not.toHaveBeenCalled();
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
      start: () => boolean | Promise<unknown>,
      expectedMessageType: AntiRaidWorkerMessage["type"]
    ): Promise<void> {
      workerPosts.length = 0;
      let settled: boolean = false;
      const started: boolean | Promise<unknown> = start();
      // 这几条入口把 durable barrier 纳入返回值：ingress 的常态是同步返回 false（不分配 Promise），
      // 服务消息这一路返回 Promise，update 等 barrier 落地。
      expect(started).toBeInstanceOf(Promise);
      const handled = (started as Promise<unknown>).finally(() => { settled = true; });
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

  test("入群事件晚到时仍转交直属评论与楼中楼线索；非待验证发送者只同步投递、不加投 barrier，普通消息不进入 Worker", async () => {
    workerPosts.length = 0;
    // 评论线索只进 Worker 内存，barrier 换不来持久性：同步返回 false，不分配 Promise。
    expect(antiRaid.handleAntiRaidMessageIngress({
      chat: { id: -4001 },
      from: { id: 88 },
      message_id: 55,
      reply_to_message: { is_automatic_forward: true },
    } as never, 99)).toBeFalse();
    expect(workerPosts).toEqual([expect.objectContaining({
      type: "message",
      chatId: -4001,
      userId: 88,
      repliesToChannelPost: true,
    })]);

    workerPosts.length = 0;
    expect(antiRaid.handleAntiRaidMessageIngress({
      chat: { id: -4001 },
      from: { id: 89 },
      message_id: 56,
      message_thread_id: 55,
    } as never, 99)).toBeFalse();
    expect(workerPosts).toEqual([expect.objectContaining({
      type: "message",
      chatId: -4001,
      userId: 89,
      isThreadReply: true,
    })]);

    workerPosts.length = 0;
    await antiRaid.handleAntiRaidMessageIngress({
      chat: { id: -4001 },
      from: { id: 90 },
      message_id: 57,
    } as never, 99);
    expect(workerPosts).toHaveLength(0);
  });

  test("待验证发送者的评论区消息仍走 durable 投递：先投消息再加投 barrier", async () => {
    activeVerificationSnapshots.set("-4001:93", { ...record(1, 1), chatId: -4001, userId: 93 });
    workerPosts.length = 0;
    const pending = antiRaid.handleAntiRaidMessageIngress({
      chat: { id: -4001 },
      from: { id: 93 },
      message_id: 60,
      message_thread_id: 55,
    } as never, 99);
    expect(pending).toBeInstanceOf(Promise);
    await Bun.sleep(0);
    expect(workerPosts[0]).toMatchObject({ type: "message", chatId: -4001, userId: 93, isThreadReply: true });
    const barrier = workerPosts.at(-1);
    expect(barrier?.type).toBe("barrier");
    if (barrier?.type === "barrier") {
      workerHooks.supervisorOptions!.onEvent({ type: "barrierComplete", barrierId: barrier.barrierId });
    }
    expect(await pending).toBeFalse();
    activeVerificationSnapshots.delete("-4001:93");
  });

  test("论坛话题消息不是评论区候选：不投递、不加投 barrier", async () => {
    workerPosts.length = 0;
    // 开了 topics 的超级群里每条普通消息都带 message_thread_id；只有关联频道讨论组的评论线程是候选，
    // 论坛话题走普通非待验证语义。
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
    const changedRestore: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const stoppedRestore: PromiseWithResolvers<void> = Promise.withResolvers<void>();
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
    await waitUntil((): boolean =>
      chatStates.get(successfulChatId)?.lockdown === undefined &&
      chatStates.get(retryChatId)?.lockdown === undefined &&
      saveStateInBackground.mock.calls.length >= 2);

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
      Bun.sleep(1_000).then(() => "timedOut" as const),
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
