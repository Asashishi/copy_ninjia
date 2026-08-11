import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  DiskBusinessMessage,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";
import {
  blockedIdentityTestView as blockedUserIds,
  seedMissingIdentity,
} from "../helpers/identityStorage";

const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];

mock.module("../../packages/infra/diskIO", () => ({
  flushDiskIODomain: async (): Promise<string> => "flushed",
  flushDiskIODomainOutcome: async (): Promise<{ result: "flushed" }> => ({ result: "flushed" }),
  isDiskIOInitialized: (): boolean => false,
  onDiskIORespawn: (): void => {},
  onIdentityStoragePersisted: (listener: (reply: IdentityStoragePersistedReply) => void): void => {
    persistedListeners.push(listener);
  },
  relayLogMessage: (): boolean => true,
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskMessages.push(message);
    return true;
  },
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getAllChatStates: (): ReadonlyMap<number, { isInitEnabled: boolean; botIsAdmin: boolean }> =>
    new Map([[-1001, { isInitEnabled: true, botIsAdmin: true }]]),
}));

const {
  pendingBlockedRemovals,
} = await import("../../packages/cache/main/blocklist");
const {
  resetIdentityStorageCache,
  unacknowledgedBlocklistWrites,
} = await import("../../packages/cache/main/identityStorage");
const {
  assertSuperAdminNotBlocked,
  blockUser,
  ensureBlocklistEntryQueued,
  isUserBlocked,
  unblockUser,
} = await import("../../packages/infra/blocklist/membership");

beforeEach(() => {
  diskMessages.length = 0;
  pendingBlockedRemovals.clear();
  resetIdentityStorageCache();
});

describe("SQLite 黑名单主线程最终值", () => {
  test("拉黑先发布 LRU，再排队带 meta 的 revision 写入", () => {
    seedMissingIdentity(7);
    expect(blockUser(7, {
      firstName: "Alice",
      lastName: "Cat",
      username: "alice",
    })).toBeTrue();
    expect(isUserBlocked(7)).toBeTrue();
    expect(diskMessages.at(-1)).toEqual(expect.objectContaining({
      type: "identityPolicyWrite",
      table: "blocklist",
      id: 7,
      revision: 1,
    }));
    const queuedData: string | null | undefined =
      unacknowledgedBlocklistWrites.get(7)?.data;
    expect(queuedData).not.toBeNull();
    expect(queuedData).not.toBeUndefined();
    expect(JSON.parse(queuedData!)).toEqual(expect.objectContaining({
      meta: expect.objectContaining({ username: "alice" }),
    }));
    expect(blockUser(7)).toBeFalse();
  });

  test("解除拉黑发布负缓存，并裁掉冻结名单中已解除的成员", () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    const pending: PendingBlockedRemoval = {
      params: {
        chatId: -1001,
        probeMembership: false,
        userIds: [7, 8],
        removalId: 1,
      },
      createdAt: 1,
      attempts: 0,
      lastFailure: null,
    };
    pendingBlockedRemovals.set(1, pending);

    expect(unblockUser(7)).toBeTrue();
    expect(isUserBlocked(7)).toBeFalse();
    expect(unacknowledgedBlocklistWrites.get(7)?.data).toBeNull();
    expect(pendingBlockedRemovals.get(1)?.params).toEqual(expect.objectContaining({
      userIds: [8],
    }));
    expect(unblockUser(7)).toBeFalse();
  });

  test("未 ACK 最终值可重复补投；精确 ACK 后停止补投", () => {
    seedMissingIdentity(9);
    blockUser(9);
    diskMessages.length = 0;
    expect(ensureBlocklistEntryQueued(9)).toBeTrue();
    expect(diskMessages).toHaveLength(1);
    const revision: number = unacknowledgedBlocklistWrites.get(9)!.revision;
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [{ table: "blocklist", id: 9, revision }],
      });
    }
    expect(ensureBlocklistEntryQueued(9)).toBeFalse();
  });
});

describe("超管与黑名单互斥的启动断言", () => {
  test("超管不在黑名单时放行", async () => {
    seedMissingIdentity(1);
    await expect(assertSuperAdminNotBlocked(1)).resolves.toBeUndefined();
  });

  test("超管在黑名单里时拒绝启动，并点名文件与两张表", async () => {
    seedMissingIdentity(1);
    blockUser(1);
    // isWhitelisted 对超管短路 true、isUserBlocked 不短路：两者同时成立时
    // sweepManagedBlocklistChats 会把这位新超管从每个托管群清出去，而他连一条
    // /unblock 都发不出来。按 AGENTS.md「不为用户行为兜底」在启动阶段退出。
    await expect(assertSuperAdminNotBlocked(1)).rejects.toThrow(
      /blocklist_entries must not contain the configured super admin identity 1/
    );
  });
});
