import { beforeEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import {
  BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE,
} from "../../../packages/consts/antiRaid/blocklist";
import {
  IDENTITY_DATABASE_DIRECTORY_MODE,
  IDENTITY_DATABASE_FILE_MODE,
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import {
  DATABASE_DIR,
  IDENTITY_DATABASE_PATH,
} from "../../../packages/consts/paths";
import {
  clearStorageBusinessTables,
  putIdentityPolicyRow,
  seedStorageDatabase,
} from "../../../packages/database/interact/admin";
import {
  readStorageDatabasePendingRemovalPage,
} from "../../../packages/database/interact/inspection";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { encodeChatStateData } from "../../../packages/database/codec/chatState";
import type {
  StorageDatabase,
  StoredPendingRemovalStartupRow,
} from "../../../packages/types/storageDatabase";
import {
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../../packages/database/codec/identity";
import {
  pendingBlocklistWrites,
  pendingChatStateWrites,
  pendingWhitelistWrites,
  resetStorageDatabaseCache,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import { handleChatStateWrite } from
  "../../../packages/workers/diskIO/storageDatabase/chatState";
import { flushStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/flush";
import { hydrateStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/hydration";
import {
  handleIdentityPolicyWrite,
  readIdentityPolicies,
} from "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import { handlePendingRemovalSnapshot } from
  "../../../packages/workers/diskIO/storageDatabase/pendingRemoval";
import type { PendingBlockedRemoval } from "../../../packages/types/blocklist";
import type {
  ChatStateWriteDiskMessage,
  IdentityStoragePersistedReply,
  IdentityPolicyWriteDiskMessage,
} from "../../../packages/types/diskIO";
import type { WhitelistEntryData } from "../../../packages/types/identityPolicy";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../../packages/consts/whitelist";

const META: Readonly<{ firstName: string; lastName: string; username: string }> = {
  firstName: "本天才才不是雑魚喵~",
  lastName: "",
  username: "copy_ninjia_bot",
};
const acknowledgements: IdentityStoragePersistedReply[] = [];

function reply(value: IdentityStoragePersistedReply): void {
  acknowledgements.push(value);
}

function clearBusinessTables(): void {
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  clearStorageBusinessTables(database);
  closeStorageDatabase(database);
}

function whitelistWrite(id: number, revision: number): IdentityPolicyWriteDiskMessage {
  const value: WhitelistEntryData = {
    permissions: DEFAULT_WHITELIST_PERMISSIONS,
    meta: META,
  };
  return {
    type: "identityPolicyWrite",
    table: "whitelist",
    id,
    data: encodeWhitelistEntryData(value),
    revision,
  };
}

function blocklistWrite(id: number, revision: number): IdentityPolicyWriteDiskMessage {
  return {
    type: "identityPolicyWrite",
    table: "blocklist",
    id,
    data: encodeBlocklistEntryData({
      blockedAt: "2026/08/11 00:00:00",
      meta: META,
    }),
    revision,
  };
}

function removal(removalId: number): PendingBlockedRemoval {
  return {
    params: {
      chatId: -1001,
      probeMembership: false,
      userIds: [7],
      removalId,
    },
    createdAt: 1_000,
    attempts: 0,
    lastFailure: null,
  };
}

function chatStateWrite(
  chatId: number,
  revision: number,
  proxyEnabled: boolean = false
): ChatStateWriteDiskMessage {
  return {
    type: "chatStateWrite",
    chatId,
    data: encodeChatStateData({
      isInitEnabled: true,
      ...(proxyEnabled ? { isProxySendEnabled: true } : {}),
    }),
    revision,
  };
}

beforeEach(() => {
  acknowledgements.length = 0;
  clearBusinessTables();
  hydrateStorageDatabase();
});

describe("DiskIO Worker SQLite 身份存储", () => {
  test("数据库文件由 owner 读写，启动只恢复计数和待踢行", () => {
    expect(statSync(IDENTITY_DATABASE_PATH).mode & 0o777).toBe(IDENTITY_DATABASE_FILE_MODE);
    // 隔离测试进程未必属于临时根目录的 group，内核可清除 setgid；这里验证
    // owner/group 权限位，真实迁移再在 chown 后落实并核验 setgid。
    expect(statSync(DATABASE_DIR).mode & 0o777).toBe(
      IDENTITY_DATABASE_DIRECTORY_MODE & 0o777
    );
    expect(hydrateStorageDatabase()).toEqual({
      blocklistEntryCount: 0,
      whitelistEntryCount: 0,
      pendingBlockedRemovals: new Map(),
      chatStates: new Map(),
    });
  });

  test("未提交最终值参与读取，显式 flush 后才发送精确 revision ACK", () => {
    handleIdentityPolicyWrite(whitelistWrite(7, 1), reply);
    const before = readIdentityPolicies({
      type: "readIdentityPolicies",
      requestId: 1,
      ids: [7],
    });
    expect(before.whitelist).toHaveLength(1);
    expect(acknowledgements).toHaveLength(0);

    expect(flushStorageDatabase(reply)).toBeTrue();
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [{ table: "whitelist", id: 7, revision: 1 }],
      chatStateWrites: [],
    }]);
    resetStorageDatabaseCache();
    expect(hydrateStorageDatabase().whitelistEntryCount).toBe(1);
  });

  test("黑白两表分别计到 128；任一满批时同一事务提交当时全部变化", () => {
    for (let index: number = 1; index < IDENTITY_WRITE_BATCH_MAX_ENTRIES; index++) {
      handleIdentityPolicyWrite(whitelistWrite(index, index), reply);
      handleIdentityPolicyWrite(blocklistWrite(-index, 10_000 + index), reply);
    }
    expect(pendingWhitelistWrites.size).toBe(IDENTITY_WRITE_BATCH_MAX_ENTRIES - 1);
    expect(pendingBlocklistWrites.size).toBe(IDENTITY_WRITE_BATCH_MAX_ENTRIES - 1);
    expect(acknowledgements).toHaveLength(0);

    handleIdentityPolicyWrite(
      whitelistWrite(IDENTITY_WRITE_BATCH_MAX_ENTRIES, IDENTITY_WRITE_BATCH_MAX_ENTRIES),
      reply
    );

    expect(pendingWhitelistWrites.size).toBe(0);
    expect(pendingBlocklistWrites.size).toBe(0);
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]!.writes).toHaveLength(
      IDENTITY_WRITE_BATCH_MAX_ENTRIES * 2 - 1
    );
    resetStorageDatabaseCache();
    const restored = hydrateStorageDatabase();
    expect(restored.whitelistEntryCount).toBe(IDENTITY_WRITE_BATCH_MAX_ENTRIES);
    expect(restored.blocklistEntryCount).toBe(IDENTITY_WRITE_BATCH_MAX_ENTRIES - 1);
  });

  test("待踢完整快照与名单写入共用事务，并在 durable 后单独 ACK 快照 revision", () => {
    handleIdentityPolicyWrite(blocklistWrite(7, 1), reply);
    handlePendingRemovalSnapshot({
      type: "blocklistRemovals",
      removals: [[9, removal(9)]],
      revision: 4,
    }, reply);
    expect(flushStorageDatabase(reply)).toBeTrue();
    expect(acknowledgements.at(-1)).toEqual({
      type: "identityStoragePersisted",
      writes: [{ table: "blocklist", id: 7, revision: 1 }],
      chatStateWrites: [],
      removalSnapshotRevision: 4,
    });

    resetStorageDatabaseCache();
    const restored = hydrateStorageDatabase();
    expect(restored.blocklistEntryCount).toBe(1);
    expect(restored.pendingBlockedRemovals).toEqual(new Map([[9, removal(9)]]));
  });

  test("待踢启动恢复按 removal_id 每页 2048 条读取并在页间继续", () => {
    handleIdentityPolicyWrite(blocklistWrite(7, 1), reply);
    const persisted: [number, PendingBlockedRemoval][] = Array.from(
      { length: BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE + 1 },
      (_value: unknown, index: number): [number, PendingBlockedRemoval] => {
        const removalId: number = index + 1;
        return [removalId, removal(removalId)];
      }
    );
    handlePendingRemovalSnapshot({
      type: "blocklistRemovals",
      removals: persisted,
      revision: 4,
    }, reply);
    expect(flushStorageDatabase(reply)).toBeTrue();

    resetStorageDatabaseCache();
    const database: StorageDatabase = openStorageDatabase({
      path: IDENTITY_DATABASE_PATH,
    });
    const firstPage: readonly StoredPendingRemovalStartupRow[] =
      readStorageDatabasePendingRemovalPage(database, null);
    expect(firstPage).toHaveLength(BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE);
    expect(firstPage[0]?.removalId).toBe(1);
    expect(firstPage.at(-1)?.removalId).toBe(
      BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE
    );
    const secondPage: readonly StoredPendingRemovalStartupRow[] =
      readStorageDatabasePendingRemovalPage(
        database,
        firstPage.at(-1)!.removalId
      );
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]?.removalId).toBe(
      BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE + 1
    );
    closeStorageDatabase(database);

    const restored: ReturnType<typeof hydrateStorageDatabase> =
      hydrateStorageDatabase();
    expect(restored.pendingBlockedRemovals).toHaveLength(
      BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE + 1
    );
  });

  test("待踢分页为损坏 BLOB 保留表、主键和字段路径", () => {
    handleIdentityPolicyWrite(blocklistWrite(7, 1), reply);
    handlePendingRemovalSnapshot({
      type: "blocklistRemovals",
      removals: [[9, removal(9)]],
      revision: 4,
    }, reply);
    expect(flushStorageDatabase(reply)).toBeTrue();

    resetStorageDatabaseCache();
    const database: StorageDatabase = openStorageDatabase({
      path: IDENTITY_DATABASE_PATH,
    });
    database.$client.exec(
      "PRAGMA ignore_check_constraints=ON; " +
      "UPDATE pending_blocked_removals SET data = x'ff' WHERE removal_id = 9; " +
      "PRAGMA ignore_check_constraints=OFF;"
    );
    closeStorageDatabase(database);

    expect(() => hydrateStorageDatabase()).toThrow(
      `${IDENTITY_DATABASE_PATH}:pending_blocked_removals[9].data: ` +
      "expected a BLOB containing strict SQLite JSONB."
    );
  });

  test("待踢快照只能引用同一事务最终视图中的黑名单身份", () => {
    expect(() => handlePendingRemovalSnapshot({
      type: "blocklistRemovals",
      removals: [[9, removal(9)]],
      revision: 4,
    }, reply)).toThrow("absent from the effective blocklist");
    expect(acknowledgements).toHaveLength(0);
  });

  test("同一主键迟到 revision 不能覆盖更新值，删除也覆盖数据库冷读", () => {
    handleIdentityPolicyWrite(blocklistWrite(7, 2), reply);
    handleIdentityPolicyWrite(blocklistWrite(7, 1), reply);
    expect(pendingBlocklistWrites.get(7)?.revision).toBe(2);
    flushStorageDatabase(reply);

    handleIdentityPolicyWrite({
      type: "identityPolicyWrite",
      table: "blocklist",
      id: 7,
      data: null,
      revision: 3,
    }, reply);
    const pendingDelete = readIdentityPolicies({
      type: "readIdentityPolicies",
      requestId: 2,
      ids: [7],
    });
    expect(pendingDelete.blocklist).toEqual([]);
  });

  test("同一事务允许先删黑名单再加入白名单，最终两表保持互斥", () => {
    handleIdentityPolicyWrite(blocklistWrite(7, 1), reply);
    expect(flushStorageDatabase(reply)).toBeTrue();
    handleIdentityPolicyWrite({
      type: "identityPolicyWrite",
      table: "blocklist",
      id: 7,
      data: null,
      revision: 2,
    }, reply);
    handleIdentityPolicyWrite(whitelistWrite(7, 3), reply);
    // 同表迟到旧值必须在跨表互斥校验前丢弃，不能干扰已经排队的黑转白。
    handleIdentityPolicyWrite(blocklistWrite(7, 1), reply);
    expect(flushStorageDatabase(reply)).toBeTrue();

    resetStorageDatabaseCache();
    const restored = hydrateStorageDatabase();
    expect(restored.blocklistEntryCount).toBe(0);
    expect(restored.whitelistEntryCount).toBe(1);
  });

  test("群状态第 25 条自动事务提交并精确 ACK，第 26 条在 Worker owner 再次拒绝", () => {
    for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index++) {
      handleChatStateWrite(chatStateWrite(-1_000 - index, 1), reply);
    }

    expect(pendingChatStateWrites.size).toBe(0);
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]?.writes).toEqual([]);
    expect(acknowledgements[0]?.chatStateWrites).toHaveLength(
      STATE_MANAGED_CHAT_LIMIT
    );

    resetStorageDatabaseCache();
    const restored = hydrateStorageDatabase();
    expect(restored.chatStates).toHaveLength(STATE_MANAGED_CHAT_LIMIT);
    expect(() => handleChatStateWrite(chatStateWrite(-9_999, 1), reply))
      .toThrow("must contain at most 25 chats");

    handleChatStateWrite({
      type: "chatStateWrite",
      chatId: -1_000,
      data: null,
      revision: 2,
    }, reply);
    handleChatStateWrite(chatStateWrite(-9_999, 1), reply);
    expect(flushStorageDatabase(reply)).toBeTrue();

    resetStorageDatabaseCache();
    const afterReplacement = hydrateStorageDatabase();
    expect(afterReplacement.chatStates).toHaveLength(STATE_MANAGED_CHAT_LIMIT);
    expect(afterReplacement.chatStates.has(-1_000)).toBeFalse();
    expect(afterReplacement.chatStates.has(-9_999)).toBeTrue();
  });

  test("代理目标唯一性覆盖数据库与未提交最终视图，删除旧目标后才允许替换", () => {
    handleChatStateWrite(chatStateWrite(-1_001, 1, true), reply);
    expect(flushStorageDatabase(reply)).toBeTrue();

    expect(() => handleChatStateWrite(chatStateWrite(-1_002, 1, true), reply))
      .toThrow("at most one active proxy send target");
    handleChatStateWrite({
      type: "chatStateWrite",
      chatId: -1_001,
      data: null,
      revision: 2,
    }, reply);
    handleChatStateWrite(chatStateWrite(-1_002, 1, true), reply);
    expect(flushStorageDatabase(reply)).toBeTrue();

    resetStorageDatabaseCache();
    const restored = hydrateStorageDatabase();
    expect(restored.chatStates.has(-1_001)).toBeFalse();
    expect(restored.chatStates.get(-1_002)?.isProxySendEnabled).toBeTrue();
  });

  // 唯一性是归纳不变量：写之前它已经成立，只有「把代理打开」的那一条能破坏它。
  // 因此普通写入不再逐行解码整张表去数一个布尔（那是每条群消息都可能付一次的
  // 完整字段/lockdown/18 位权限校验 × 25 行），而拒绝该拒绝的那一条照旧当场拒绝。
  test("满载的普通写入不影响已有代理目标，再开第二个仍当场拒绝", () => {
    handleChatStateWrite(chatStateWrite(-1_001, 1, true), reply);
    for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT - 1; index++) {
      handleChatStateWrite(chatStateWrite(-4_000 - index, 1), reply);
    }
    expect(flushStorageDatabase(reply)).toBeTrue();

    resetStorageDatabaseCache();
    const restored = hydrateStorageDatabase();
    expect(restored.chatStates).toHaveLength(STATE_MANAGED_CHAT_LIMIT);
    expect(restored.chatStates.get(-1_001)?.isProxySendEnabled).toBeTrue();

    expect(() => handleChatStateWrite(chatStateWrite(-4_000, 2, true), reply))
      .toThrow("at most one active proxy send target");
  });

  test("群状态启动恢复不再执行冷迁移时期的数据正确性校验", () => {
    resetStorageDatabaseCache();
    const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
    seedStorageDatabase(database, {
      metadata: [],
      whitelist: [],
      blocklist: [],
      removals: [],
      chatStates: Array.from(
        { length: STATE_MANAGED_CHAT_LIMIT + 1 },
        (_value: unknown, index: number) => ({
          chatId: -2_000 - index,
          data: encodeChatStateData({ isInitEnabled: true }),
        })
      ),
    });
    closeStorageDatabase(database);
    const oversized = hydrateStorageDatabase();
    expect(oversized.chatStates).toHaveLength(STATE_MANAGED_CHAT_LIMIT + 1);

    clearBusinessTables();
    const second: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
    seedStorageDatabase(second, {
      metadata: [],
      whitelist: [],
      blocklist: [],
      removals: [],
      chatStates: [
        { chatId: -3_001, data: encodeChatStateData({ isProxySendEnabled: true }) },
        { chatId: -3_002, data: encodeChatStateData({ isProxySendEnabled: true }) },
      ],
    });
    closeStorageDatabase(second);
    const duplicateProxyTargets = hydrateStorageDatabase();
    expect(duplicateProxyTargets.chatStates).toHaveLength(2);
  });

  test("启动只统计黑白名单，不读取 data 或核对跨表交集", () => {
    resetStorageDatabaseCache();
    const database: StorageDatabase = openStorageDatabase({
      path: IDENTITY_DATABASE_PATH,
    });
    putIdentityPolicyRow({ database, table: "whitelist", id: 7, data: "{}" });
    database.$client.exec(
      "PRAGMA ignore_check_constraints=ON; " +
      "UPDATE whitelist_entries SET data = x'00' WHERE id = 7; " +
      "PRAGMA ignore_check_constraints=OFF;"
    );
    const black: IdentityPolicyWriteDiskMessage = blocklistWrite(7, 2);
    putIdentityPolicyRow({
      database,
      table: "blocklist",
      id: 7,
      data: black.data!,
    });
    closeStorageDatabase(database);

    const restored: ReturnType<typeof hydrateStorageDatabase> = hydrateStorageDatabase();
    expect(restored.whitelistEntryCount).toBe(1);
    expect(restored.blocklistEntryCount).toBe(1);
  });
});
