import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerEvent, AntiRaidWorkerMessage } from "../../../src/types";

const calls: string[] = [];
const workerEvents: AntiRaidWorkerEvent[] = [];
const workerSelf: {
  onmessage: ((event: MessageEvent<AntiRaidWorkerMessage>) => void) | null;
  postMessage: (event: AntiRaidWorkerEvent) => void;
} = {
  onmessage: null,
  postMessage: (event) => { workerEvents.push(event); },
};
Object.defineProperty(globalThis, "self", { configurable: true, value: workerSelf });

mock.module("../../../src/workers/antiRaid/verificationRuntime", () => ({
  handleJoin(): void { calls.push("join"); },
  handleTrackedMessage(): void { calls.push("message"); },
  handleVerificationCallback(): void { calls.push("callback"); },
  dispatchVerification(): void { calls.push("left"); },
  adoptVerifications(): void { calls.push("adoptVerifications"); },
  handleVerificationPersisted(): void { calls.push("verificationPersisted"); },
  deactivateVerificationChat(): void { calls.push("deactivateVerification"); },
  stopVerificationRuntime(): void { calls.push("stopVerification"); },
}));
mock.module("../../../src/workers/antiRaid/lockdownRuntime", () => ({
  adoptLockdowns(): void { calls.push("adopt"); },
  handleLockdownPersisted(): void { calls.push("lockdownPersisted"); },
  deactivateLockdownChat(): void { calls.push("deactivateLockdown"); },
  stopLockdownRuntime(): void { calls.push("stopLockdown"); },
}));
mock.module("../../../src/workers/antiRaid/adminCache", () => ({
  applyAdminChange(): void { calls.push("adminsChanged"); },
}));
const sweepRecentComments = mock((_now: number): number => 0);
mock.module("../../../src/workers/antiRaid/recentComments", () => ({ sweepRecentComments }));
const initTelegramClients = mock((): void => {});
mock.module("../../../src/infra/telegram/client", () => ({ initTelegramClients }));

const worker = await import("../../../src/workers/antiRaidWorker");
const {
  adminFetches,
  chatAdmins,
} = await import("../../../src/cache/antiRaid/admins");
const {
  linkedChannelFetches,
  linkedChannels,
} = await import("../../../src/cache/antiRaid/linkedChannels");
const { verificationRevisions } = await import("../../../src/cache/antiRaid/verification");
const { ADMIN_CACHE_TTL_MS, LINKED_CHANNEL_TTL_MS, VERIFICATION_REVISION_RETENTION_MS } = await import("../../../src/consts/antiRaid");

beforeEach(() => {
  worker.stopAntiRaidWorker();
  calls.length = 0;
  workerEvents.length = 0;
  initTelegramClients.mockClear();
  sweepRecentComments.mockClear();
  adminFetches.clear();
  chatAdmins.clear();
  linkedChannelFetches.clear();
  linkedChannels.clear();
  verificationRevisions.clear();
});

describe("Anti-Raid Worker lifecycle", () => {
  test("启动幂等、路由完整，停止后清除 handler 与唯一 sweeper", () => {
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
      { type: "barrier", barrierId: 99 },
    ];
    for (const message of messages) workerSelf.onmessage!({ data: message } as MessageEvent<AntiRaidWorkerMessage>);
    expect(calls).toEqual([
      "join", "left", "deactivateVerification", "deactivateLockdown", "message", "callback",
      "adopt", "lockdownPersisted", "adoptVerifications", "verificationPersisted", "adminsChanged",
    ]);
    expect(workerEvents).toEqual([{ type: "barrierComplete", barrierId: 99 }]);

    worker.stopAntiRaidWorker();
    expect(workerSelf.onmessage).toBeNull();
    expect(calls.slice(-2)).toEqual(["stopVerification", "stopLockdown"]);
    worker.startAntiRaidWorker();
    expect(initTelegramClients).toHaveBeenCalledTimes(2);
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
});
