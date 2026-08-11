import { beforeEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import {
  IDENTITY_DATABASE_DIRECTORY_MODE,
  IDENTITY_DATABASE_FILE_MODE,
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
import {
  DATABASE_DIR,
  IDENTITY_DATABASE_PATH,
} from "../../../packages/consts/paths";
import {
  clearIdentityBusinessTables,
  closeIdentityDatabase,
  openIdentityDatabase,
  putIdentityPolicyRow,
} from "../../../packages/database/interact/identity";
import type { IdentityDatabase } from "../../../packages/types/identityDatabase";
import {
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../../packages/database/codec/identity";
import {
  pendingBlocklistWrites,
  pendingWhitelistWrites,
  resetIdentityDatabaseCache,
} from "../../../packages/cache/workers/diskIO/identityDatabase";
import {
  flushIdentityDatabase,
  handleIdentityPolicyWrite,
  handlePendingRemovalSnapshot,
  hydrateIdentityDatabase,
  readIdentityPolicies,
} from "../../../packages/workers/diskIO/identityDatabase";
import type { PendingBlockedRemoval } from "../../../packages/types/blocklist";
import type {
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
  resetIdentityDatabaseCache();
  const database: IdentityDatabase = openIdentityDatabase({ path: IDENTITY_DATABASE_PATH });
  clearIdentityBusinessTables(database);
  closeIdentityDatabase(database);
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

beforeEach(() => {
  acknowledgements.length = 0;
  clearBusinessTables();
  hydrateIdentityDatabase();
});

describe("DiskIO Worker SQLite 身份存储", () => {
  test("数据库文件由 owner 读写，启动只恢复计数和待踢行", () => {
    expect(statSync(IDENTITY_DATABASE_PATH).mode & 0o777).toBe(IDENTITY_DATABASE_FILE_MODE);
    // 隔离测试进程未必属于临时根目录的 group，内核可清除 setgid；这里验证
    // owner/group 权限位，真实迁移再在 chown 后落实并核验 setgid。
    expect(statSync(DATABASE_DIR).mode & 0o777).toBe(
      IDENTITY_DATABASE_DIRECTORY_MODE & 0o777
    );
    expect(hydrateIdentityDatabase()).toEqual({
      blocklistEntryCount: 0,
      whitelistEntryCount: 0,
      pendingBlockedRemovals: new Map(),
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

    expect(flushIdentityDatabase(reply)).toBeTrue();
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [{ table: "whitelist", id: 7, revision: 1 }],
    }]);
    resetIdentityDatabaseCache();
    expect(hydrateIdentityDatabase().whitelistEntryCount).toBe(1);
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
    resetIdentityDatabaseCache();
    const restored = hydrateIdentityDatabase();
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
    expect(flushIdentityDatabase(reply)).toBeTrue();
    expect(acknowledgements.at(-1)).toEqual({
      type: "identityStoragePersisted",
      writes: [{ table: "blocklist", id: 7, revision: 1 }],
      removalSnapshotRevision: 4,
    });

    resetIdentityDatabaseCache();
    const restored = hydrateIdentityDatabase();
    expect(restored.blocklistEntryCount).toBe(1);
    expect(restored.pendingBlockedRemovals).toEqual(new Map([[9, removal(9)]]));
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
    flushIdentityDatabase(reply);

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
    expect(flushIdentityDatabase(reply)).toBeTrue();
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
    expect(flushIdentityDatabase(reply)).toBeTrue();

    resetIdentityDatabaseCache();
    const restored = hydrateIdentityDatabase();
    expect(restored.blocklistEntryCount).toBe(0);
    expect(restored.whitelistEntryCount).toBe(1);
  });

  test("损坏 JSON 行与黑白名单交集都在启动恢复时致命拒绝", () => {
    resetIdentityDatabaseCache();
    const database: IdentityDatabase = openIdentityDatabase({
      path: IDENTITY_DATABASE_PATH,
    });
    expect(() => putIdentityPolicyRow({
      database,
      table: "whitelist",
      id: 8,
      data: "{",
    })).toThrow();
    putIdentityPolicyRow({ database, table: "whitelist", id: 7, data: "{}" });
    closeIdentityDatabase(database);
    expect(() => hydrateIdentityDatabase()).toThrow("permissions");

    clearBusinessTables();
    const second: IdentityDatabase = openIdentityDatabase({
      path: IDENTITY_DATABASE_PATH,
    });
    const white: IdentityPolicyWriteDiskMessage = whitelistWrite(7, 1);
    const black: IdentityPolicyWriteDiskMessage = blocklistWrite(7, 2);
    putIdentityPolicyRow({ database: second, table: "whitelist", id: 7, data: white.data! });
    putIdentityPolicyRow({ database: second, table: "blocklist", id: 7, data: black.data! });
    closeIdentityDatabase(second);
    expect(() => hydrateIdentityDatabase()).toThrow("exists in both");
  });
});
