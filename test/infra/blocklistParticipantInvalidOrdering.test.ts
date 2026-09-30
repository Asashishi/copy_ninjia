import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BLOCKED_AT,
  META,
  drainParticipantInvalidWork,
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
import {
  BLOCKLIST_PARTICIPANT_INVALID_LIMIT,
  BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS,
} from "../../packages/consts/antiRaid/blocklist";
import type { BlocklistIdPage } from "../../packages/types/identityStorage";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";

/**
 * 黑名单销号计数的次序边界：回执到达顺序、逐身份队列里的解除核对、预热等待期间的
 * LRU 淘汰，以及与补扫分页读 flush 的并发。
 */

mock.module("../../packages/infra/diskIO", participantInvalidDiskIO);
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: (): ReadonlyMap<number, { isInitEnabled: boolean; botPermissions: BotChatPermissions }> =>
    new Map([[-1001, { isInitEnabled: true, botPermissions: botPermissions() }]]),
}));
mock.module("../../packages/infra/logger", participantInvalidLogger);

const {
  blocklistParticipantInvalidQueue,
  pendingBlockedRemovals,
} = await import("../../packages/cache/main/blocklist");
const {
  blocklistEntryCache,
  resetIdentityStorageCache,
  whitelistEntryCache,
} = await import("../../packages/cache/main/identityStorage");
const {
  cachedBlocklistEntry,
  prefetchIdentityPolicies,
  readBlocklistSweepPage,
} = await import("../../packages/infra/identityStorage");
const { runBlocklistIdentityMutation } = await import("../../packages/infra/identityPolicy/coordination");
const { isUserBlocked } = await import("../../packages/infra/blocklist/membership");
const { recordBlocklistParticipantReadability } = await import("../../packages/infra/blocklist/participantInvalid");

const EMPTY_PAGE: BlocklistIdPage = { ids: [], nextCursor: null, done: true };

/** 发起一次卡在 flush 上的补扫分页读，返回放行 flush 的 resolver 与读取结果。 */
function startGatedSweepPageRead(): { release: () => void; page: Promise<BlocklistIdPage> } {
  const gate: { promise: Promise<void>; resolve: () => void } = Promise.withResolvers<void>();
  participantInvalidHarness.flushGate = gate.promise;
  const page: Promise<BlocklistIdPage> = readBlocklistSweepPage(null);
  participantInvalidHarness.flushGate = null;
  return { release: gate.resolve, page };
}

beforeEach(async () => {
  await blocklistParticipantInvalidQueue.current;
  resetParticipantInvalidHarness();
  pendingBlockedRemovals.clear();
  resetIdentityStorageCache();
});

describe("黑名单销号计数的次序", () => {
  test("回执按到达顺序结算：先到的计数即使冷读更慢也排在后到的清零之前", async () => {
    storeBlocked(7, 2);
    const gate: { promise: Promise<void>; resolve: () => void } = Promise.withResolvers<void>();
    participantInvalidHarness.readGate = gate.promise;

    recordBlocklistParticipantReadability(receipt([7]));
    recordBlocklistParticipantReadability(receipt([], [7]));
    await Bun.sleep(0);
    expect(identityWrites("blocklist")).toEqual([]);
    participantInvalidHarness.readGate = null;
    gate.resolve();
    await drainParticipantInvalidWork();

    expect(writtenCounts()).toEqual([[7, 3], [7, undefined]]);
  });

  test("排队期间清零后又涨回上限减 1，也按条目对象判定为已变化", async () => {
    storeBlocked(7, BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1);
    const busy: { promise: Promise<void>; resolve: () => void } = Promise.withResolvers<void>();
    const held: Promise<void> = runBlocklistIdentityMutation(7, (): Promise<void> => busy.promise);

    recordBlocklistParticipantReadability(receipt([7]));
    recordBlocklistParticipantReadability(receipt([], [7]));
    for (let round: number = 1; round < BLOCKLIST_PARTICIPANT_INVALID_LIMIT; round++) {
      recordBlocklistParticipantReadability(receipt([7]));
    }
    await blocklistParticipantInvalidQueue.current;
    expect(cachedBlocklistEntry(7)?.participantInvalidCount).toBe(BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1);

    busy.resolve();
    await held;
    await drainParticipantInvalidWork();
    expect(isUserBlocked(7)).toBeTrue();
    expect(lastWrittenData(7)).toEqual({
      blockedAt: BLOCKED_AT,
      meta: META,
      participantInvalidCount: BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1,
    });
  });

  test("排队解除期间条目被淘汰后重读，放弃这次解除", async () => {
    storeBlocked(7, BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1);
    const busy: { promise: Promise<void>; resolve: () => void } = Promise.withResolvers<void>();
    const held: Promise<void> = runBlocklistIdentityMutation(7, (): Promise<void> => busy.promise);

    recordBlocklistParticipantReadability(receipt([7]));
    await blocklistParticipantInvalidQueue.current;
    blocklistEntryCache.delete(7);
    busy.resolve();
    await held;
    await drainParticipantInvalidWork();

    expect(identityWrites("blocklist")).toEqual([]);
    expect(isUserBlocked(7)).toBeTrue();
  });

  test("预热等待期间身份被淘汰时整条回执重新预热后一起写出", async () => {
    storeBlocked(7);
    storeBlocked(8);
    await prefetchIdentityPolicies([7]);
    readIdentityPolicies.mockClear();
    const read: { promise: Promise<void>; resolve: () => void } = Promise.withResolvers<void>();
    participantInvalidHarness.readGate = read.promise;

    recordBlocklistParticipantReadability(receipt([7, 8]));
    await waitUntil((): boolean => readIdentityPolicies.mock.calls.length === 1);
    // 预热正在读 8；这期间已缓存的 7 被淘汰。
    whitelistEntryCache.delete(7);
    participantInvalidHarness.readGate = null;
    read.resolve();
    await drainParticipantInvalidWork();

    expect(readIdentityPolicies.mock.calls.map((call) => call[0])).toEqual([[8], [7]]);
    expect(writtenCounts()).toEqual([[7, 1], [8, 1]]);
  });

  test("每轮预热等待期间都有身份被淘汰时，轮数用尽后跳过整条回执并记错误", async () => {
    storeBlocked(7);
    storeBlocked(8);
    await prefetchIdentityPolicies([7]);
    readIdentityPolicies.mockClear();
    let read: { promise: Promise<void>; resolve: () => void } = Promise.withResolvers<void>();
    participantInvalidHarness.readGate = read.promise;
    recordBlocklistParticipantReadability(receipt([7, 8]));

    for (let attempt: number = 1; attempt <= BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS; attempt++) {
      await waitUntil((): boolean => readIdentityPolicies.mock.calls.length === attempt);
      // 这一轮在读哪个身份，就把另一个已缓存的淘汰掉。
      const reading: readonly number[] = readIdentityPolicies.mock.calls[attempt - 1]![0] as readonly number[];
      whitelistEntryCache.delete(reading.includes(8) ? 7 : 8);
      const current: { promise: Promise<void>; resolve: () => void } = read;
      read = Promise.withResolvers<void>();
      participantInvalidHarness.readGate = attempt < BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS ? read.promise : null;
      current.resolve();
    }
    await drainParticipantInvalidWork();

    expect(identityWrites("blocklist")).toEqual([]);
    expect(readIdentityPolicies).toHaveBeenCalledTimes(BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS);
    expect(participantInvalidHarness.loggedErrors.some((message: string): boolean =>
      message.includes("Skipped blocklist PARTICIPANT_ID_INVALID counts for removal 1 in chat -1001")
    )).toBeTrue();
  });

  test("补扫分页读 flush 期间落下的计数写入立即投递，也不让这次核对失败", async () => {
    storeBlocked(7);
    await prefetchIdentityPolicies([7]);
    const sweep: { release: () => void; page: Promise<BlocklistIdPage> } = startGatedSweepPageRead();

    recordBlocklistParticipantReadability(receipt([7]));
    await drainParticipantInvalidWork();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META, participantInvalidCount: 1 });

    // 这次写入晚于 flush 发出，不属于它覆盖的那一批，核对只看更早的 revision。
    sweep.release();
    await expect(sweep.page).resolves.toEqual(EMPTY_PAGE);
    // 之后开始的分页读由自己的 flush 覆盖这次写入。
    await expect(readBlocklistSweepPage(null)).resolves.toEqual(EMPTY_PAGE);
  });
});
