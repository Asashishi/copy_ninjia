/** Anti-Raid 主线程镜像的启动恢复、adopt 与 Worker 重建重放。 */

import { describe, expect, test } from "bun:test";

import { adDetectAgentConfigSnapshot } from "../../../packages/config/agent";

import type {
  AntiRaidWorkerMessage,
  DiskBusinessMessage,
  DiskIORecoveryTransport,
  VerificationDeleteDiskMessage,
  VerificationUpsertDiskMessage,
} from "../../../packages/types";

const {
  activeVerificationSnapshots,
  chatIsSupergroupById,
  chatStates,
  deferred,
  deferredVerificationRecords,
  diskPosts,
  inFlightAdDisposals,
  pendingLockdownPersistence,
  pendingVerificationDeferrals,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
  queuedLockdownPersistence,
  record,
  resetAntiRaidTestState,
  saveState,
  settleAntiRaidDrain,
  terminalRecord,
  workerHooks,
  workerPosts,
  installAntiRaidMirrorHooks,
} = await import("../../helpers/antiRaidMirrorHarness");

type FlushResult = "flushed" | "timedOut" | "failed";

const antiRaid = await import("../../../packages/antiRaid");

const { grantVerificationAttempt } = await import("../../../packages/antiRaid/verificationAttempts");

installAntiRaidMirrorHooks({
  initAntiRaid: antiRaid.initAntiRaid,
  terminateAntiRaid: antiRaid.terminateAntiRaid,
});

describe("Anti-Raid main-thread persistence mirror", () => {
  test("完整进程冷启动把磁盘终态提升到新代际，恢复后的第一轮许可不会被判 stale", async () => {
    await resetAntiRaidTestState();
    antiRaid.hydratePendingVerifications(new Map([
      ["-1001:42", terminalRecord(9, 3)],
    ]));
    antiRaid.initAntiRaid();

    expect(workerPosts.find(
      (message: AntiRaidWorkerMessage): boolean =>
        message.type === "adoptVerifications"
    )).toMatchObject({
      type: "adoptVerifications",
      generation: 1,
      verifications: [{ generation: 1, revision: 3 }],
      resumePersistedTerminals: true,
    });
    expect(grantVerificationAttempt({
      operation: "verificationAttemptPermit",
      key: "-1001:42",
      generation: 1,
      revision: 3,
    })).toEqual({ status: "granted", attempt: 1 });
  });

  test("延后前最后 revision 未落盘时只向 Anti-Raid 重放闩锁，仍向 DiskIO 重放完整快照", async () => {
    workerHooks.supervisorOptions!.onEvent({
      type: "verificationUpsert",
      record: terminalRecord(1, 3),
    });
    workerHooks.supervisorOptions!.onEvent({
      type: "verificationDeferred",
      record: { chatId: -1001, userId: 42, generation: 1, revision: 3 },
    });

    expect(activeVerificationSnapshots.get("-1001:42")?.revision).toBe(3);
    expect(pendingVerificationDeferrals.get("-1001:42")?.revision).toBe(3);
    expect(deferredVerificationRecords.has("-1001:42")).toBeFalse();

    const recoveryPosts: DiskBusinessMessage[] = [];
    expect(await workerHooks.diskRespawn!({
      post(message: DiskBusinessMessage): boolean {
        recoveryPosts.push(message);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("Unexpected luck secret request.");
      },
    })).toBeTrue();
    expect(recoveryPosts).toEqual([{
      type: "verificationUpsert",
      record: terminalRecord(1, 3),
      critical: true,
    }]);

    const respawnPosts: AntiRaidWorkerMessage[] = [];
    workerHooks.supervisorOptions!.onRespawn((message: AntiRaidWorkerMessage): boolean => {
      respawnPosts.push(message);
      return true;
    });
    const adopt: AntiRaidWorkerMessage | undefined = respawnPosts.find(
      (message: AntiRaidWorkerMessage): boolean =>
        message.type === "adoptVerifications"
    );
    expect(adopt).toMatchObject({
      type: "adoptVerifications",
      generation: 2,
      verifications: [],
      deferredVerifications: [{
        chatId: -1001,
        userId: 42,
        generation: 2,
        revision: 3,
      }],
    });
    expect(activeVerificationSnapshots.get("-1001:42")?.generation).toBe(2);

    workerHooks.persistedAck!({
      type: "verificationPersisted",
      key: "-1001:42",
      generation: 2,
      revision: 3,
      deleted: false,
    });
    expect(activeVerificationSnapshots.has("-1001:42")).toBeFalse();
    expect(pendingVerificationDeferrals.has("-1001:42")).toBeFalse();
    expect(deferredVerificationRecords.get("-1001:42")).toMatchObject({
      generation: 2,
      revision: 3,
    });
  });

  test("首次 init 在终态 adopt 前重放已观测群类型", async () => {
    await resetAntiRaidTestState();
    chatIsSupergroupById.set(-9001, false);
    antiRaid.initAntiRaid();

    const chatKindIndex: number = workerPosts.findIndex(
      (message: AntiRaidWorkerMessage): boolean => message.type === "chatKind"
    );
    const adoptIndex: number = workerPosts.findIndex(
      (message: AntiRaidWorkerMessage): boolean => message.type === "adoptVerifications"
    );
    expect(workerPosts[chatKindIndex]).toEqual({
      type: "chatKind",
      chatId: -9001,
      isSupergroup: false,
    });
    expect(chatKindIndex).toBeGreaterThanOrEqual(0);
    expect(chatKindIndex).toBeLessThan(adoptIndex);
  });

  test("replays active and unconfirmed deletes while rejecting old generations", async () => {
    await resetAntiRaidTestState();
    antiRaid.hydratePendingVerifications(new Map([["-1001:42", record(9, 1)]]));
    antiRaid.initAntiRaid();
    expect(activeVerificationSnapshots.get("-1001:42")?.generation).toBe(1);
    expect(persistedVerificationRevisions.get("-1001:42")).toEqual({
      generation: 1,
      revision: 1,
    });
    const firstBoundaryIndex: number = workerPosts.length;
    const drain = antiRaid.drainAntiRaid(1_000);
    await expect(settleAntiRaidDrain(drain, firstBoundaryIndex)).resolves.toBe("flushed");
    expect(workerPosts.slice(firstBoundaryIndex).map(
      (message: AntiRaidWorkerMessage): string => message.type
    )).toEqual(["drain", "barrier", "barrier", "drain"]);
    workerHooks.supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(1, 2) });
    workerHooks.supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(0, 99) });
    workerHooks.supervisorOptions!.onEvent({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 3 });
    const recoveryTransport: DiskIORecoveryTransport = {
      post: (message: DiskBusinessMessage): boolean => {
        diskPosts.push(message as VerificationUpsertDiskMessage | VerificationDeleteDiskMessage);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("Unexpected luck secret request.");
      },
    };
    expect(await workerHooks.diskRespawn!(recoveryTransport)).toBeTrue();
    expect(await workerHooks.diskRespawn!({
      ...recoveryTransport,
      post: (): boolean => false,
    })).toBeFalse();
    expect(pendingVerificationDeletes.size).toBe(1);
    workerHooks.persistedAck!({ type: "verificationPersisted", key: "-1001:42", generation: 1, revision: 3, deleted: true });
    expect(pendingVerificationDeletes.size).toBe(0);

    workerHooks.supervisorOptions!.onEvent({ type: "verificationUpsert", record: record(1, 4) });
    const respawnPosts: AntiRaidWorkerMessage[] = [];
    workerHooks.supervisorOptions!.onRespawn((message) => {
      respawnPosts.push(message);
      return true;
    });
    workerHooks.supervisorOptions!.onEvent({ type: "verificationDelete", chatId: -1001, userId: 42, generation: 1, revision: 5 });

    // 配置快照永远排在第一条：广告判定逐条候选取模型名与凭据（见
    // types/antiRaid.ts 的 AntiRaidAgentConfigMessage）。
    expect(workerPosts[0]).toEqual({ type: "agentConfig", adDetect: adDetectAgentConfigSnapshot() });
    expect(workerPosts[1]).toMatchObject({
      type: "adoptVerifications",
      generation: 1,
      verifications: [{ generation: 1, revision: 1 }],
      resumePersistedTerminals: true,
    });
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
    expect(respawnPosts).toEqual([
      // 重生同样先投配置快照，且投的是主线程那份唯一快照，不重新读盘。
      { type: "agentConfig", adDetect: adDetectAgentConfigSnapshot() },
      expect.objectContaining({
        type: "adoptVerifications",
        generation: 2,
        verifications: [expect.objectContaining({ revision: 4 })],
      }),
    ]);
    expect(activeVerificationSnapshots.get("-1001:42")?.revision).toBe(4);
  });

  test("开关已关的群：adopt 之后立刻收掉残留的验证窗口与私密模式", async () => {
    // 残留的成因是 `/antiraid disable` 那一刻 Worker 恰好不可用：开关落了盘，
    // 运行态却留在镜像和 state.json 里。不收的话，重建/重启后的 Worker 会照着
    // 旧窗口继续踢人——开关显示关着，人却还在被踢。
    await resetAntiRaidTestState();
    chatStates.set(-1001, { isAntiRaidEnabled: false });
    chatStates.set(-1002, {
      isAntiRaidEnabled: false,
      lockdown: {
        phase: "active",
        intentId: 5,
        originalPermissions: { can_invite_users: true },
        announced: true,
        expiresAt: Date.now() + 60_000,
      },
    });
    antiRaid.hydratePendingVerifications(new Map([["-1001:42", record(0, 1)]]));

    antiRaid.initAntiRaid();

    const types: string[] = workerPosts.map((message: AntiRaidWorkerMessage): string => message.type);
    // 顺序是硬要求：先让新 isolate 接管，再拆。反过来就是对着空状态发拆除，
    // -1002 的邀请权限从此没人恢复。
    expect(types.indexOf("adoptVerifications")).toBeLessThan(types.indexOf("deactivateJoinGuard"));
    expect(types.indexOf("adopt")).toBeLessThan(types.indexOf("deactivateJoinGuard"));
    expect(workerPosts.filter(
      (message: AntiRaidWorkerMessage): boolean => message.type === "deactivateJoinGuard"
    )).toEqual([
      { type: "deactivateJoinGuard", chatId: -1001 },
      { type: "deactivateJoinGuard", chatId: -1002 },
    ]);
    // 只拆入群这条链路：广告检测与防刷屏各有各的开关。
    expect(types).not.toContain("deactivateChat");
  });

  test("开关开着的群不会被 adopt 后的清理误伤", async () => {
    await resetAntiRaidTestState();
    chatStates.set(-1001, { isAntiRaidEnabled: true });
    antiRaid.hydratePendingVerifications(new Map([["-1001:42", record(0, 1)]]));

    antiRaid.initAntiRaid();

    expect(workerPosts.map((message: AntiRaidWorkerMessage): string => message.type))
      .not.toContain("deactivateJoinGuard");
  });

  test("真实 drain 期间产生新持久化镜像时会再跑一轮固定点对账", async () => {
    antiRaid.initAntiRaid();
    const firstBoundaryIndex: number = workerPosts.length;
    let drainCount: number = 0;
    const result: Promise<FlushResult> = antiRaid.drainAntiRaid(1_000);
    await expect(settleAntiRaidDrain(result, firstBoundaryIndex, (): void => {
      drainCount++;
      // 第一次是广告流水线 quiesce；第二次才是本轮持久化回执放行后的任务 drain。
      if (drainCount !== 2) return;
      workerHooks.supervisorOptions!.onEvent({
        type: "lockdown",
        chatId: -9090,
        phase: "applying",
        intentId: 9090,
        originalPermissions: { can_invite_users: true },
        announced: false,
        expiresAt: 123_456,
      });
    })).resolves.toBe("flushed");

    expect(workerPosts.slice(firstBoundaryIndex)
      .filter((message: AntiRaidWorkerMessage): boolean =>
        message.type === "barrier" || message.type === "drain")
      .map((message: AntiRaidWorkerMessage): string => message.type))
      .toEqual([
        "drain",
        "barrier", "barrier", "drain",
        "barrier", "barrier", "drain",
      ]);
    chatStates.delete(-9090);
  });

  test("初始 Worker drain 边界登记的广告处置必须结算后才能返回 flushed", async () => {
    antiRaid.initAntiRaid();
    const firstBoundaryIndex: number = workerPosts.length;
    const disposal = deferred<void>();
    const disposalTask: Promise<void> = disposal.promise.finally((): void => {
      inFlightAdDisposals.delete(disposalTask);
    });
    const result: Promise<FlushResult> = antiRaid.drainAntiRaid(1_000);
    let settled: boolean = false;
    void result.finally((): void => { settled = true; });

    await Bun.sleep(0);
    const initialDrain: AntiRaidWorkerMessage | undefined =
      workerPosts[firstBoundaryIndex];
    expect(initialDrain?.type).toBe("drain");
    inFlightAdDisposals.add(disposalTask);
    if (initialDrain?.type === "drain") {
      workerHooks.supervisorOptions!.onEvent({
        type: "drainComplete",
        drainId: initialDrain.drainId,
      });
    }

    await Bun.sleep(0);
    expect(settled).toBeFalse();
    expect(inFlightAdDisposals.has(disposalTask)).toBeTrue();

    const remainingBoundaryIndex: number = workerPosts.length;
    disposal.resolve();
    await expect(
      settleAntiRaidDrain(result, remainingBoundaryIndex)
    ).resolves.toBe("flushed");
    expect(inFlightAdDisposals.has(disposalTask)).toBeFalse();
  });

  test("Worker 重建不会把尚未完成 saveState 的 lockdown 镜像当成已持久化", async () => {
    let releaseSave: (() => void) | undefined;
    saveState.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSave = resolve; }));
    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2002,
      phase: "applying",
      intentId: 77,
      originalPermissions: { can_invite_users: true },
      announced: false,
      expiresAt: 123_456,
    });

    const respawnPosts: AntiRaidWorkerMessage[] = [];
    workerHooks.supervisorOptions!.onRespawn((message) => {
      respawnPosts.push(message);
      return true;
    });
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

    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2003,
      phase: "active",
      intentId: 88,
      originalPermissions: { can_invite_users: true },
      announced: true,
      expiresAt: 200_000,
    });
    // 真正推进了一个阶段：这才是「完成后要补写」的那种变化。
    workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2003,
      phase: "restoring",
      intentId: 89,
      originalPermissions: { can_invite_users: true },
      announced: true,
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
      phase: "restoring",
      intentId: 89,
    }]);
  });

  test("同阶段 announced 翻转必须补写后才回落盘回执", async () => {
    workerPosts.length = 0;
    saveState.mockClear();
    const releases: (() => void)[] = [];
    saveState.mockImplementation(() => new Promise<void>((resolve) => {
      releases.push(resolve);
    }));

    const publish = (announced: boolean): void => workerHooks.supervisorOptions!.onEvent({
      type: "lockdown",
      chatId: -2004,
      phase: "active",
      intentId: 90,
      originalPermissions: { can_invite_users: true },
      announced,
      expiresAt: 400_000,
    });
    publish(false);
    publish(true);
    expect(saveState).toHaveBeenCalledTimes(1);

    releases[0]?.();
    await Bun.sleep(0);
    expect(saveState).toHaveBeenCalledTimes(2);
    expect(workerPosts.some((message) =>
      message.type === "lockdownPersisted" && message.chatId === -2004
    )).toBeFalse();

    releases[1]?.();
    await Bun.sleep(0);
    expect(workerPosts.filter((message) =>
      message.type === "lockdownPersisted" && message.chatId === -2004
    )).toEqual([{
      type: "lockdownPersisted",
      chatId: -2004,
      phase: "active",
      intentId: 90,
    }]);
  });

  test("第五轮保存期间的新意图会续跑下一任务，不等待第七条事件唤醒", async () => {
    workerPosts.length = 0;
    saveState.mockClear();
    const releases: (() => void)[] = [];
    saveState.mockImplementation(() => new Promise<void>((resolve: () => void): void => {
      releases.push(resolve);
    }));
    const publish = (intentId: number): void => {
      workerHooks.supervisorOptions!.onEvent({
        type: "lockdown",
        chatId: -2005,
        phase: "active",
        intentId,
        originalPermissions: { can_invite_users: true },
        announced: true,
        expiresAt: 500_000 + intentId,
      });
    };

    publish(1);
    for (let intentId: number = 2; intentId <= 6; intentId++) {
      expect(releases).toHaveLength(intentId - 1);
      publish(intentId);
      releases[intentId - 2]!();
      await Bun.sleep(0);
    }
    // 第五轮看到 intent 6 后触顶；finally 必须消费 lost wake-up 并新开第六次保存。
    await Bun.sleep(0);
    expect(saveState).toHaveBeenCalledTimes(6);
    releases[5]!();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(workerPosts.filter(
      (message: AntiRaidWorkerMessage): boolean =>
        message.type === "lockdownPersisted" && message.chatId === -2005
    )).toEqual([{
      type: "lockdownPersisted",
      chatId: -2005,
      phase: "active",
      intentId: 6,
    }]);
    expect(pendingLockdownPersistence.has(-2005)).toBeFalse();
    expect(queuedLockdownPersistence.has(-2005)).toBeFalse();
  });
});
