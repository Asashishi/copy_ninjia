import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BLOCKED_AT,
  META,
  deferred,
  identityWrites,
  lastWrittenData,
  participantInvalidDiskIO,
  participantInvalidHarness,
  participantInvalidLogger,
  readIdentityPolicies,
  receipt,
  resetParticipantInvalidHarness,
  storeBlocked,
  writtenCounts,
} from "../helpers/blocklistParticipantInvalidHarness";
import { waitUntil } from "../helpers/waitUntil";
import { BLOCKLIST_PARTICIPANT_INVALID_LIMIT } from "../../packages/consts/antiRaid/blocklist";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";

/**
 * 黑名单销号计数规则：回执驱动的 JSONB 计数、清零、满额解除与失败路径。
 * 顺序、淘汰与补扫 flush 窗口见 blocklistParticipantInvalidOrdering.test.ts。
 */

mock.module("../../packages/infra/diskIO", participantInvalidDiskIO);
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: (): ReadonlyMap<number, { isInitEnabled: boolean; botPermissions: BotChatPermissions }> =>
    new Map([[-1001, { isInitEnabled: true, botPermissions: botPermissions() }]]),
}));
mock.module("../../packages/infra/logger", participantInvalidLogger);

const {
  blocklistIdentityMutationQueues,
  blocklistParticipantInvalidQueue,
  pendingBlockedRemovals,
} = await import("../../packages/cache/main/blocklist");
const {
  blocklistEntryCache,
  resetIdentityStorageCache,
} = await import("../../packages/cache/main/identityStorage");
const { diskIORuntime } = await import("../../packages/cache/main/diskIO");
const { cachedBlocklistEntry } = await import("../../packages/infra/identityStorage");
const { runBlocklistIdentityMutation } = await import("../../packages/infra/identityPolicy/coordination");
const { isUserBlocked } = await import("../../packages/infra/blocklist/membership");
const { recordBlocklistParticipantReadability } = await import("../../packages/infra/blocklist/participantInvalid");

async function drain(): Promise<void> {
  await blocklistParticipantInvalidQueue.current;
  await waitUntil((): boolean => blocklistIdentityMutationQueues.size === 0);
}

beforeEach(async () => {
  await blocklistParticipantInvalidQueue.current;
  resetParticipantInvalidHarness();
  pendingBlockedRemovals.clear();
  diskIORuntime.fatalSignaled = false;
  resetIdentityStorageCache();
});

describe("黑名单销号计数", () => {
  test("没有观测的回执不排队也不读库", async () => {
    const before: Promise<void> = blocklistParticipantInvalidQueue.current;
    recordBlocklistParticipantReadability(receipt([], []));
    expect(blocklistParticipantInvalidQueue.current).toBe(before);
    await drain();
    expect(readIdentityPolicies).not.toHaveBeenCalled();
  });

  test("每条回执给冷读到的黑名单条目加 1，原样保留 blockedAt 与 meta", async () => {
    storeBlocked(7);

    recordBlocklistParticipantReadability(receipt([7]));
    await drain();

    expect(readIdentityPolicies).toHaveBeenCalledTimes(1);
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META, participantInvalidCount: 1 });
    expect(cachedBlocklistEntry(7)?.participantInvalidCount).toBe(1);

    recordBlocklistParticipantReadability(receipt([7]));
    await drain();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META, participantInvalidCount: 2 });
    expect(isUserBlocked(7)).toBeTrue();
  });

  test(`连续 ${BLOCKLIST_PARTICIPANT_INVALID_LIMIT} 条回执后移出黑名单并裁剪待踢批次`, async () => {
    storeBlocked(7);
    storeBlocked(8);
    const pending: PendingBlockedRemoval = {
      params: { chatId: -1001, probeMembership: false, userIds: [7, 8], removalId: 3 },
      createdAt: 1,
      attempts: 2,
      lastFailure: "side-effect-incomplete",
    };
    pendingBlockedRemovals.set(3, pending);

    for (let round: number = 1; round <= BLOCKLIST_PARTICIPANT_INVALID_LIMIT; round++) {
      recordBlocklistParticipantReadability(receipt([7]));
    }
    await drain();

    expect(isUserBlocked(7)).toBeFalse();
    expect(lastWrittenData(7)).toBeNull();
    expect(lastWrittenData(8)).toBeUndefined();
    expect(pendingBlockedRemovals.get(3)?.params).toEqual({
      chatId: -1001,
      probeMembership: false,
      userIds: [8],
      removalId: 3,
    });
    // 裁剪后的 outbox 快照先于 tombstone 投递。
    expect(participantInvalidHarness.diskMessages.slice(-2).map((message) => message.type))
      .toEqual(["blocklistRemovals", "identityPolicyWrite"]);
    // 计数只持久化到上限减 1；满额那次直接解除，不写出越界值。
    expect(writtenCounts()).toEqual([[7, 1], [7, 2], [7, 3], [7, 4], [7, null]]);
    expect(participantInvalidHarness.logged.some((message: string): boolean =>
      message.includes("Removed blocklisted user 7")
    )).toBeTrue();
  });

  test("已落定回执清零已有计数，之后重新从 1 开始", async () => {
    storeBlocked(7, 3);

    recordBlocklistParticipantReadability(receipt([], [7]));
    await drain();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META });
    expect(cachedBlocklistEntry(7)).not.toHaveProperty("participantInvalidCount");

    recordBlocklistParticipantReadability(receipt([7]));
    await drain();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META, participantInvalidCount: 1 });
  });

  test("已落定但没有计数、或不在黑名单里的 id 都不写库", async () => {
    storeBlocked(8);

    recordBlocklistParticipantReadability(receipt([9], [8, 10]));
    await drain();

    // 已落定 ID 一次筛选读，只有待计数的 9 进入预热。
    expect(readIdentityPolicies.mock.calls.map((call) => call[0])).toEqual([[8, 10], [9]]);
    expect(identityWrites("blocklist")).toEqual([]);
  });

  test("整页已落定 ID 的筛选不回填热缓存，已缓存条目直接判断", async () => {
    storeBlocked(7, 2);
    storeBlocked(8);
    recordBlocklistParticipantReadability(receipt([], [7]));
    await drain();
    readIdentityPolicies.mockClear();
    expect(blocklistEntryCache.peek(7)).not.toBeUndefined();

    recordBlocklistParticipantReadability(receipt([], [7, 8, 11]));
    await drain();

    expect(readIdentityPolicies.mock.calls.map((call) => call[0])).toEqual([[8, 11]]);
    expect(blocklistEntryCache.peek(8)).toBeUndefined();
    expect(blocklistEntryCache.peek(11)).toBeUndefined();
    expect(writtenCounts()).toEqual([[7, undefined]]);
  });

  test("冷读到的计数叠加本地未 ACK 最终值", async () => {
    storeBlocked(7);
    recordBlocklistParticipantReadability(receipt([7]));
    await drain();
    // 本地已写出计数 1 但尚未 flush；数据库行仍没有计数。
    blocklistEntryCache.delete(7);

    recordBlocklistParticipantReadability(receipt([], [7]));
    await drain();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META });
  });

  test("排队等待解除期间计数被清零时放弃解除", async () => {
    storeBlocked(7, BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1);
    const busy: { promise: Promise<void>; resolve: () => void } = deferred();
    const held: Promise<void> = runBlocklistIdentityMutation(7, (): Promise<void> => busy.promise);

    recordBlocklistParticipantReadability(receipt([7]));
    recordBlocklistParticipantReadability(receipt([], [7]));
    await blocklistParticipantInvalidQueue.current;
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META });

    busy.resolve();
    await held;
    await drain();
    expect(isUserBlocked(7)).toBeTrue();
    expect(identityWrites("blocklist")).toHaveLength(1);
  });

  test("冷读失败记一行错误并跳过这条回执，后续回执照常处理", async () => {
    storeBlocked(7);
    participantInvalidHarness.readFailure = new Error("disk offline");

    recordBlocklistParticipantReadability(receipt([7]));
    await drain();
    expect(identityWrites("blocklist")).toEqual([]);
    expect(participantInvalidHarness.loggedErrors.length).toBeGreaterThan(0);

    participantInvalidHarness.readFailure = null;
    recordBlocklistParticipantReadability(receipt([7]));
    await drain();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META, participantInvalidCount: 1 });
  });

  test("持久化拒收计数写入时记一行错误，后续回执照常处理", async () => {
    storeBlocked(7);
    diskIORuntime.fatalSignaled = true;

    recordBlocklistParticipantReadability(receipt([7]));
    await drain();
    expect(identityWrites("blocklist")).toEqual([]);
    expect(participantInvalidHarness.loggedErrors.some((message: string): boolean =>
      message.includes("Failed to update blocklist PARTICIPANT_ID_INVALID counts for removal 1 in chat -1001")
    )).toBeTrue();

    diskIORuntime.fatalSignaled = false;
    recordBlocklistParticipantReadability(receipt([7]));
    await drain();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META, participantInvalidCount: 1 });
  });

  test("持久化拒收解除时记一行错误并保留黑名单条目", async () => {
    storeBlocked(7, BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1);
    const busy: { promise: Promise<void>; resolve: () => void } = deferred();
    const held: Promise<void> = runBlocklistIdentityMutation(7, (): Promise<void> => busy.promise);

    recordBlocklistParticipantReadability(receipt([7]));
    await blocklistParticipantInvalidQueue.current;
    diskIORuntime.fatalSignaled = true;
    busy.resolve();
    await held;
    await drain();

    expect(isUserBlocked(7)).toBeTrue();
    expect(identityWrites("blocklist")).toEqual([]);
    expect(participantInvalidHarness.loggedErrors.some((message: string): boolean =>
      message.includes("Failed to remove deleted account 7 from the blocklist")
    )).toBeTrue();
  });
});
