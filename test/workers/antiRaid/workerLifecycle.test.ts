import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerEvent } from "../../../packages/types/antiRaid/events";
import type { AntiRaidWorkerMessage } from "../../../packages/types/antiRaid/protocol";
import type { AdDetectAgentConfig } from "../../../packages/types/config";
import { workerDuplexRequestSignal } from "../../../packages/cache/perThread/workerDuplex";
import { workerAtmosphere } from "../../../packages/workers/antiRaid/atmosphere";
import { plainAtmosphereChats, defaultAtmosphereState } from "../../../packages/cache/workers/antiRaid/atmosphere";
import { ATMOSPHERE_TEXTS } from "../../../packages/consts/atmosphere";

const calls: string[] = [];
const workerEvents: AntiRaidWorkerEvent[] = [];
let removeBlockedMembersTask: Promise<void> = Promise.resolve();
let deleteDeferredVerificationResult: boolean = false;
let deletionFlushRequestSignal: AbortSignal | null | undefined;
/** drain 时统一延迟删除 flush 交回的删除任务；缺省为空。 */
let pendingDeletionTasks: readonly Promise<void>[] = [];
const workerSelf: {
  onmessage: ((event: MessageEvent<AntiRaidWorkerMessage>) => void) | null;
  postMessage: (event: AntiRaidWorkerEvent) => void;
} = {
  onmessage: null,
  postMessage: (event) => { workerEvents.push(event); },
};
Object.defineProperty(globalThis, "self", { configurable: true, value: workerSelf });

mock.module("../../../packages/workers/antiRaid/verificationRuntime", () => ({
  handleJoin(): void { calls.push("join"); },
  handleTrackedMessage(): void { calls.push("message"); },
  handleVerificationCallback(): void { calls.push("callback"); },
  dispatchVerification(): void { calls.push("left"); },
  adoptVerifications(): void { calls.push("adoptVerifications"); },
  handleVerificationPersisted(): void { calls.push("verificationPersisted"); },
  deactivateVerificationChat(): void { calls.push("deactivateVerification"); },
  disableJoinGuardChat(): void { calls.push("disableJoinGuard"); },
  deleteDeferredVerification(): boolean {
    if (!deleteDeferredVerificationResult) return false;
    calls.push("deleteDeferredVerification");
    return true;
  },
  stopVerificationRuntime(): void { calls.push("stopVerification"); },
}));
mock.module("../../../packages/workers/antiRaid/lockdownRuntime", () => ({
  adoptLockdowns(): void { calls.push("adopt"); },
  handleLockdownPersisted(): void { calls.push("lockdownPersisted"); },
  handleLockdownPersistFailed(): void { calls.push("lockdownPersistFailed"); },
  deactivateLockdownChat(): void { calls.push("deactivateLockdown"); },
  stopLockdownRuntime(): void { calls.push("stopLockdown"); },
}));
mock.module("../../../packages/workers/antiRaid/adminCache", () => ({
  applyAdminChange(): void { calls.push("adminsChanged"); },
}));
mock.module("../../../packages/workers/antiRaid/blocklistEffects", () => ({
  handleRemoveBlockedMembers(): Promise<void> {
    calls.push("removeBlockedMembers");
    return removeBlockedMembersTask;
  },
}));
mock.module("../../../packages/workers/antiRaid/adDetect/queue", () => ({
  enqueueAdCandidate(): void { calls.push("adCandidate"); },
  clearChatAdDetect(): void { calls.push("clearAdDetect"); },
  clearIdentityAdDetect(): void { calls.push("clearIdentityAdDetect"); },
  sweepAdDetect(): void { calls.push("sweepAdDetect"); },
  quiesceAdDetectQueue(): void { calls.push("quiesceAdDetect"); },
  startAdDetectQueue(): void { calls.push("startAdDetect"); },
  stopAdDetectQueue(): void { calls.push("stopAdDetect"); },
}));
mock.module("../../../packages/workers/antiRaid/floodControl", () => ({
  handleFloodCandidate(): void { calls.push("floodCandidate"); },
  clearChatFloodWindows(): void { calls.push("clearFloodWindows"); },
  sweepFloodWindows(): number { calls.push("sweepFloodWindows"); return 0; },
  resetFloodWindows(): void { calls.push("resetFloodWindows"); },
}));
mock.module("../../../packages/workers/antiRaid/botPermissions", () => ({
  applyBotPermissionsChange(): void { calls.push("botPermissionsChanged"); },
  forgetWorkerBotPermissions(): void { calls.push("forgetBotPermissions"); },
  resetWorkerBotPermissions(): void { calls.push("resetBotPermissions"); },
}));
mock.module("../../../packages/workers/antiRaid/chatKind", () => ({
  applyChatKindChange(): void { calls.push("chatKindChanged"); },
  forgetWorkerChatKind(): void { calls.push("forgetChatKind"); },
  resetWorkerChatKind(): void { calls.push("resetChatKind"); },
}));
const sweepRecentComments = mock((_now: number): number => 0);
mock.module("../../../packages/workers/antiRaid/recentComments", () => ({
  sweepRecentComments,
  resetRecentComments(): void { calls.push("resetRecentComments"); },
}));
mock.module("../../../packages/infra/telegram/actions/messageLifecycle", () => ({
  flushPendingMessageDeletions(): readonly Promise<void>[] {
    calls.push("flushGenericMessageDeletions");
    deletionFlushRequestSignal = workerDuplexRequestSignal.current;
    return pendingDeletionTasks;
  },
  resetPendingMessageDeletions(): void { calls.push("resetGenericMessageDeletions"); },
}));
const worker = await import("../../../packages/workers/antiRaidWorker");
const { workerTelegramApi } = await import("../../../packages/infra/telegram/workerClient");
const { telegramApiState } = await import("../../../packages/cache/perThread/telegramApi");
const {
  adminFetches,
  chatAdmins,
} = await import("../../../packages/cache/workers/antiRaid/admins");
const {
  getOrCreateLinkedChannelFetch,
  linkedChannelFetches,
  linkedChannels,
} = await import("../../../packages/cache/workers/antiRaid/linkedChannels");
const { verificationRevisions } = await import("../../../packages/cache/workers/antiRaid/verification");
const {
  blocklistRemovalEpochs,
  blocklistRemovalTaskCounts,
} = await import("../../../packages/cache/workers/antiRaid/blocklist");
const { ADMIN_CACHE_TTL_MS, LINKED_CHANNEL_TTL_MS } = await import(
  "../../../packages/consts/antiRaid/cache"
);
const { VERIFICATION_REVISION_RETENTION_MS } = await import(
  "../../../packages/consts/antiRaid/verification"
);
const { adDetectAgentConfigCache } = await import("../../../packages/cache/perThread/config");
const { aiCacheUsageSink } = await import("../../../packages/cache/perThread/aiCacheUsage");

/** 主线程投递过来的那一代 ad_detect 快照；断言 Worker 原样收进 holder。 */
const injectedAdDetectConfig: AdDetectAgentConfig = {
  provider: "openai",
  apiKey: "injected-ad-key",
  baseUrl: undefined,
  headers: undefined,
  model: "injected-ad-model",
};

beforeEach(() => {
  worker.stopAntiRaidWorker();
  // 新 isolate 的 holder 本来就是空的：配置消息之前取 ad_detect 必须 fail-closed。
  adDetectAgentConfigCache.current = null;
  calls.length = 0;
  workerEvents.length = 0;
  removeBlockedMembersTask = Promise.resolve();
  deleteDeferredVerificationResult = false;
  deletionFlushRequestSignal = undefined;
  sweepRecentComments.mockClear();
  adminFetches.clear();
  chatAdmins.clear();
  linkedChannelFetches.clear();
  linkedChannels.clear();
  verificationRevisions.clear();
});

describe("Anti-Raid Worker lifecycle", () => {
  test("风格镜像只响应变更消息，失权保留，移除和 Worker 停止清理", () => {
    worker.startAntiRaidWorker();
    worker.handleAntiRaidWorkerMessage({ type: "atmosphere", chatId: -1001, plain: true });
    expect(workerAtmosphere(-1001)).toBe(ATMOSPHERE_TEXTS.plain);
    expect(workerAtmosphere(-1002)).toBe(ATMOSPHERE_TEXTS.teasing);
    worker.handleAntiRaidWorkerMessage({ type: "deactivateChat", chatId: -1001, cleanupVerificationMessages: false });
    expect(workerAtmosphere(-1001)).toBe(ATMOSPHERE_TEXTS.plain);
    worker.handleAntiRaidWorkerMessage({ type: "atmosphere", chatId: -1001, plain: false });
    expect(plainAtmosphereChats.size).toBe(0);
    worker.handleAntiRaidWorkerMessage({ type: "atmosphere", chatId: -1001, plain: true });
    worker.stopAntiRaidWorker();
    expect(plainAtmosphereChats.size).toBe(0);
    expect(defaultAtmosphereState.current).toBeNull();
  });
  test("stop/start 作废旧关联频道在途槽，旧 settle 不破坏新代去重", async () => {
    let resolveStale!: () => void;
    let resolveFresh!: () => void;
    worker.startAntiRaidWorker();
    const stale: Promise<void> = getOrCreateLinkedChannelFetch(
      -1001,
      (): Promise<void> => new Promise((resolve: () => void): void => {
        resolveStale = resolve;
      })
    );

    worker.stopAntiRaidWorker();
    worker.startAntiRaidWorker();
    const fresh: Promise<void> = getOrCreateLinkedChannelFetch(
      -1001,
      (): Promise<void> => new Promise((resolve: () => void): void => {
        resolveFresh = resolve;
      })
    );
    const freshSlot: Promise<void> | undefined = linkedChannelFetches.get(-1001);
    expect(freshSlot).toBe(fresh);

    resolveStale();
    await stale;
    expect(linkedChannelFetches.get(-1001)).toBe(freshSlot!);

    resolveFresh();
    await fresh;
    expect(linkedChannelFetches.has(-1001)).toBeFalse();
    worker.stopAntiRaidWorker();
  });

  test("离群先删除本进程延后的持久化终态；没有延后记录才投给活动状态机", () => {
    deleteDeferredVerificationResult = true;
    worker.handleAntiRaidWorkerMessage({ type: "left", chatId: -1001, userId: 1 });
    expect(calls).toEqual(["deleteDeferredVerification"]);

    calls.length = 0;
    deleteDeferredVerificationResult = false;
    worker.handleAntiRaidWorkerMessage({ type: "left", chatId: -1001, userId: 1 });
    expect(calls).toEqual(["left"]);
  });

  test("显式停管会走提醒清理状态机，失权停管只清本地验证 owner", () => {
    worker.handleAntiRaidWorkerMessage({
      type: "deactivateChat",
      chatId: -1001,
      cleanupVerificationMessages: true,
    });
    expect(calls[0]).toBe("disableJoinGuard");

    calls.length = 0;
    worker.handleAntiRaidWorkerMessage({
      type: "deactivateChat",
      chatId: -1001,
      cleanupVerificationMessages: false,
    });
    expect(calls[0]).toBe("deactivateVerification");
  });

  test("启动幂等、路由完整，停止后清除 handler 与唯一 sweeper", async () => {
    worker.startAntiRaidWorker();
    worker.startAntiRaidWorker();
    expect(telegramApiState.current).toBe(workerTelegramApi);
    expect(workerDuplexRequestSignal.current?.aborted).toBeFalse();
    expect(workerSelf.onmessage).not.toBeNull();

    const messages: AntiRaidWorkerMessage[] = [
      { defaultAtmosphere: "teasing", type: "agentConfig", adDetect: injectedAdDetectConfig, adSamples: [] },
      {
        type: "join",
        chatId: -1001,
        member: { id: 1 },
      },
      { type: "left", chatId: -1001, userId: 1 },
      { type: "deactivateChat", chatId: -1001, cleanupVerificationMessages: false },
      { type: "deactivateJoinGuard", chatId: -1001 },
      { type: "message", chatId: -1001, userId: 1, messageId: 10 },
      {
        type: "callback",
        callbackQueryId: "q",
        targetUserId: 1,
        action: "self",
        from: { id: 1 },
      },
      { type: "adopt", lockdowns: [] },
      { type: "lockdownPersisted", chatId: -1001, phase: "applying", intentId: 1 },
      { type: "lockdownPersistFailed", chatId: -1001, phase: "applying", intentId: 2 },
      { type: "adoptVerifications", generation: 1, verifications: [] },
      { type: "verificationPersisted", key: "-1001:1", generation: 1, revision: 1 },
      { type: "adminsChanged", chatId: -1001, userId: 1, isInviterExempt: true },
      { type: "removeBlockedMembers", chatId: -1001, userIds: [42], probeMembership: false, removalId: 1 },
      { type: "adCandidate", chatId: -1001, senderId: 1, messageId: 11, observedAt: 1, text: "买号加我", linkUrls: [], label: "@spam", meta: { firstName: "Spam", lastName: "", username: "spam" }, isChannel: false, isForwarded: false, blocked: false, justJoined: true },
      { type: "clearAdDetect", chatId: -1001 },
      { type: "floodCandidate", chatId: -1001, userId: 1, observedAt: 1, label: "@noisy" },
      { type: "clearFloodControl", chatId: -1001 },
      { type: "temporaryAdBypassGranted", identityId: 1 },
      { type: "botPermissionsChanged", chatId: -1001, permissions: { canRestrictMembers: true, canDeleteMessages: true } },
      { type: "chatKind", chatId: -1001, isSupergroup: true },
      { type: "barrier", barrierId: 99 },
    ];
    for (const message of messages) workerSelf.onmessage!({ data: message } as MessageEvent<AntiRaidWorkerMessage>);
    expect(calls).toEqual([
      // startAntiRaidWorker 先登记广告判定的回投通道与节拍，随后才接消息。
      "startAdDetect",
      "join", "left", "deactivateVerification", "deactivateLockdown",
      // 停管连待检的广告消息串一起丢：不再替这个群判定，也不再在那里删消息。
      "clearAdDetect",
      // 刷屏计数与权限镜像同理：重新接管时主线程会重新镜像，计数从零开始。
      "clearFloodWindows", "forgetBotPermissions", "forgetChatKind",
      // `/antiraid disable` 只收入群这一条链路：验证经状态机收摊、私密模式解锁，
      // 广告队列、刷屏窗口、权限与群类型镜像一个都不动（各有各的开关）。
      "disableJoinGuard", "deactivateLockdown",
      "message", "callback",
      "adopt", "lockdownPersisted", "lockdownPersistFailed", "adoptVerifications", "verificationPersisted", "adminsChanged",
      "removeBlockedMembers", "adCandidate", "clearAdDetect",
      "floodCandidate", "clearFloodWindows", "clearIdentityAdDetect",
      "botPermissionsChanged", "chatKindChanged",
    ]);
    // 配置消息不产生业务副作用，只把快照写进 holder：本线程此后不读 agent.json。
    expect(adDetectAgentConfigCache.current).toBe(injectedAdDetectConfig);
    expect(workerEvents).toEqual([{ type: "barrierComplete", barrierId: 99 }]);
    await Bun.sleep(0);

    worker.stopAntiRaidWorker();
    expect(workerSelf.onmessage).toBeNull();
    expect(calls.slice(-8)).toEqual([
      "stopVerification", "stopLockdown", "stopAdDetect", "resetRecentComments",
      "resetFloodWindows", "resetGenericMessageDeletions", "resetBotPermissions",
      "resetChatKind",
    ]);
    worker.startAntiRaidWorker();
    expect(telegramApiState.current).toBe(workerTelegramApi);
    worker.stopAntiRaidWorker();
  });

  test("drain 等统一延迟删除 flush 交回的删除任务结算后才回 drainComplete", async () => {
    let releaseDeletion!: () => void;
    pendingDeletionTasks = [new Promise<void>((resolve: () => void): void => { releaseDeletion = resolve; })];
    worker.startAntiRaidWorker();
    try {
      workerSelf.onmessage!({ data: { type: "drain", drainId: 21 } } as MessageEvent<AntiRaidWorkerMessage>);
      await Bun.sleep(0);
      expect(workerEvents).toEqual([]);

      releaseDeletion();
      await Bun.sleep(0);
      expect(workerEvents).toEqual([{ type: "drainComplete", drainId: 21 }]);
    } finally {
      pendingDeletionTasks = [];
      worker.stopAntiRaidWorker();
    }
  });

  test("启动时装上缓存用量出口，把用量作为事件发回主线程；停止时卸下", () => {
    worker.startAntiRaidWorker();
    const usage = {
      timestamp: 1, capability: "ad_detect", provider: "openai", model: "m", inputTokens: 10, cachedInputTokens: 8, outputTokens: 1,
    } as const;
    aiCacheUsageSink.current!(usage);
    expect(workerEvents).toContainEqual({ type: "aiCacheUsage", usage });
    worker.stopAntiRaidWorker();
    expect(aiCacheUsageSink.current).toBeNull();
  });

  test("mailbox barrier 不等网络任务，真实 drain 必须等在途任务结算", async () => {
    let releaseRemoval!: () => void;
    removeBlockedMembersTask = new Promise<void>((resolve: () => void): void => {
      releaseRemoval = resolve;
    });
    worker.startAntiRaidWorker();

    workerSelf.onmessage!({
      data: {
        type: "removeBlockedMembers",
        chatId: -1001,
        userIds: [42],
        probeMembership: false,
        removalId: 1,
      },
    } as MessageEvent<AntiRaidWorkerMessage>);
    workerSelf.onmessage!({
      data: {
        type: "deactivateChat",
        chatId: -1001,
        cleanupVerificationMessages: false,
      },
    } as MessageEvent<AntiRaidWorkerMessage>);
    workerSelf.onmessage!({
      data: { type: "barrier", barrierId: 10 },
    } as MessageEvent<AntiRaidWorkerMessage>);
    workerSelf.onmessage!({
      data: { type: "drain", drainId: 11 },
    } as MessageEvent<AntiRaidWorkerMessage>);

    await Bun.sleep(0);
    expect(workerEvents).toEqual([{ type: "barrierComplete", barrierId: 10 }]);
    // 统一延迟删除 flush 必须在 quiesce 后、任务 drain 前认领全部 timer；
    // 返回的删除 Promise 会接入同一个在途集合。
    expect(calls.indexOf("flushGenericMessageDeletions"))
      .toBeGreaterThan(calls.indexOf("quiesceAdDetect"));
    expect(deletionFlushRequestSignal).toBeNull();
    expect(workerDuplexRequestSignal.current?.aborted).toBeTrue();
    expect(blocklistRemovalTaskCounts.get(-1001)).toBe(1);
    expect(blocklistRemovalEpochs.get(-1001)).toBe(1);

    releaseRemoval();
    await Bun.sleep(0);
    expect(workerEvents).toEqual([
      { type: "barrierComplete", barrierId: 10 },
      { type: "drainComplete", drainId: 11 },
    ]);
    expect(blocklistRemovalTaskCounts.has(-1001)).toBeFalse();
    expect(blocklistRemovalEpochs.has(-1001)).toBeFalse();
    worker.stopAntiRaidWorker();
  });

  test("统一 sweep 删除过期缓存，保留仍在拉取或仍在保留期的条目", () => {
    const now = 1_000_000;
    chatAdmins.set(1, { adminIds: new Set(), fetchedAt: now - ADMIN_CACHE_TTL_MS - 1 });
    chatAdmins.set(2, { adminIds: new Set(), fetchedAt: now - ADMIN_CACHE_TTL_MS - 1 });
    adminFetches.set(2, Promise.resolve(new Set()));
    linkedChannels.set(1, { hasLinked: false, fetchedAt: now - LINKED_CHANNEL_TTL_MS - 1 });
    linkedChannels.set(2, { hasLinked: true, fetchedAt: now });
    verificationRevisions.set("old", { revision: 1, retiredAt: now - VERIFICATION_REVISION_RETENTION_MS - 1 });
    verificationRevisions.set("active", { revision: 2 });

    worker.sweepAntiRaidWorkerCaches(now);
    expect([...chatAdmins.keys()]).toEqual([2]);
    expect([...linkedChannels.keys()]).toEqual([2]);
    expect([...verificationRevisions.keys()]).toEqual(["active"]);
    expect(sweepRecentComments).toHaveBeenCalledWith(now);
  });

  test("没有在途处置时，高基数停管不会留下历史群世代", () => {
    for (let chatId: number = -1; chatId >= -1_000; chatId--) {
      worker.handleAntiRaidWorkerMessage({
        type: "deactivateChat",
        chatId,
        cleanupVerificationMessages: false,
      });
    }
    expect(blocklistRemovalTaskCounts.size).toBe(0);
    expect(blocklistRemovalEpochs.size).toBe(0);
  });
});
