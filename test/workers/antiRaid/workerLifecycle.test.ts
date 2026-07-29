import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerEvent, AntiRaidWorkerMessage } from "../../../packages/types";

const calls: string[] = [];
const workerEvents: AntiRaidWorkerEvent[] = [];
let removeBlockedMembersTask: Promise<void> = Promise.resolve();
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
  stopVerificationRuntime(): void { calls.push("stopVerification"); },
}));
mock.module("../../../packages/workers/antiRaid/lockdownRuntime", () => ({
  adoptLockdowns(): void { calls.push("adopt"); },
  handleLockdownPersisted(): void { calls.push("lockdownPersisted"); },
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
  sweepAdDetect(): void { calls.push("sweepAdDetect"); },
  quiesceAdDetectQueue(): void { calls.push("quiesceAdDetect"); },
  startAdDetectQueue(): void { calls.push("startAdDetect"); },
  stopAdDetectQueue(): void { calls.push("stopAdDetect"); },
}));
const sweepRecentComments = mock((_now: number): number => 0);
mock.module("../../../packages/workers/antiRaid/recentComments", () => ({ sweepRecentComments }));
const initTelegramClients = mock((): void => {});
mock.module("../../../packages/infra/telegram/client", () => ({ initTelegramClients }));

const worker = await import("../../../packages/workers/antiRaidWorker");
const {
  adminFetches,
  chatAdmins,
} = await import("../../../packages/cache/antiRaid/admins");
const {
  linkedChannelFetches,
  linkedChannels,
} = await import("../../../packages/cache/antiRaid/linkedChannels");
const { verificationRevisions } = await import("../../../packages/cache/antiRaid/verification");
const {
  blocklistRemovalEpochs,
  blocklistRemovalTaskCounts,
} = await import("../../../packages/cache/antiRaid/blocklist");
const { ADMIN_CACHE_TTL_MS, LINKED_CHANNEL_TTL_MS, VERIFICATION_REVISION_RETENTION_MS } = await import("../../../packages/consts/antiRaid");

beforeEach(() => {
  worker.stopAntiRaidWorker();
  calls.length = 0;
  workerEvents.length = 0;
  removeBlockedMembersTask = Promise.resolve();
  initTelegramClients.mockClear();
  sweepRecentComments.mockClear();
  adminFetches.clear();
  chatAdmins.clear();
  linkedChannelFetches.clear();
  linkedChannels.clear();
  verificationRevisions.clear();
});

describe("Anti-Raid Worker lifecycle", () => {
  test("启动幂等、路由完整，停止后清除 handler 与唯一 sweeper", async () => {
    worker.startAntiRaidWorker();
    worker.startAntiRaidWorker();
    expect(initTelegramClients).toHaveBeenCalledTimes(1);
    expect(workerSelf.onmessage).not.toBeNull();

    const messages: AntiRaidWorkerMessage[] = [
      { type: "join", chatId: -1001, member: { id: 1 } },
      { type: "left", chatId: -1001, userId: 1 },
      { type: "deactivateChat", chatId: -1001 },
      { type: "message", chatId: -1001, userId: 1, messageId: 10 },
      { type: "callback", callbackQueryId: "q", targetUserId: 1, from: { id: 1 } },
      { type: "adopt", lockdowns: [] },
      { type: "lockdownPersisted", chatId: -1001, phase: "applying", intentId: 1 },
      { type: "adoptVerifications", generation: 1, verifications: [] },
      { type: "verificationPersisted", key: "-1001:1", generation: 1, revision: 1 },
      { type: "adminsChanged", chatId: -1001, userId: 1, isInviterExempt: true },
      { type: "removeBlockedMembers", chatId: -1001, userIds: [42], probeMembership: false, removalId: 1 },
      { type: "adCandidate", chatId: -1001, senderId: 1, messageId: 11, text: "买号加我", linkUrls: [], label: "@spam", isChannel: false, blocked: false, justJoined: true },
      { type: "clearAdDetect", chatId: -1001 },
      { type: "barrier", barrierId: 99 },
    ];
    for (const message of messages) workerSelf.onmessage!({ data: message } as MessageEvent<AntiRaidWorkerMessage>);
    expect(calls).toEqual([
      // startAntiRaidWorker 先登记广告判定的回投通道与节拍，随后才接消息。
      "startAdDetect",
      "join", "left", "deactivateVerification", "deactivateLockdown",
      // 停管连待检的广告消息串一起丢：不再替这个群判定，也不再在那里删消息。
      "clearAdDetect",
      "message", "callback",
      "adopt", "lockdownPersisted", "adoptVerifications", "verificationPersisted", "adminsChanged",
      "removeBlockedMembers", "adCandidate", "clearAdDetect",
    ]);
    expect(workerEvents).toEqual([{ type: "barrierComplete", barrierId: 99 }]);
    await Bun.sleep(0);

    worker.stopAntiRaidWorker();
    expect(workerSelf.onmessage).toBeNull();
    expect(calls.slice(-3)).toEqual(["stopVerification", "stopLockdown", "stopAdDetect"]);
    worker.startAntiRaidWorker();
    expect(initTelegramClients).toHaveBeenCalledTimes(2);
    worker.stopAntiRaidWorker();
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
      data: { type: "deactivateChat", chatId: -1001 },
    } as MessageEvent<AntiRaidWorkerMessage>);
    workerSelf.onmessage!({
      data: { type: "barrier", barrierId: 10 },
    } as MessageEvent<AntiRaidWorkerMessage>);
    workerSelf.onmessage!({
      data: { type: "drain", drainId: 11 },
    } as MessageEvent<AntiRaidWorkerMessage>);

    await Bun.sleep(0);
    expect(workerEvents).toEqual([{ type: "barrierComplete", barrierId: 10 }]);
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
      worker.handleAntiRaidWorkerMessage({ type: "deactivateChat", chatId });
    }
    expect(blocklistRemovalTaskCounts.size).toBe(0);
    expect(blocklistRemovalEpochs.size).toBe(0);
  });
});
