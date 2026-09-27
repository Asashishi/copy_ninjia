import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { storageDatabaseSchema } from
  "../../../packages/database/schema/storage";
import {
  pendingBlocklistWrites,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  BLOCKLIST_SWEEP_PAGE_SIZE,
  BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES,
} from "../../../packages/consts/identityStorage";
import {
  readBlocklistIdPage,
  readIdentityPolicies,
} from "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import type { StorageDatabase } from
  "../../../packages/types/storageDatabase";
import type {
  BlocklistIdPageReadReply,
  IdentityPoliciesReadReply,
} from "../../../packages/types/diskIO";

function seedBlocklist(database: StorageDatabase, count: number): void {
  const insert = database.$client.prepare(
    "INSERT INTO blocklist_entries (id, data) VALUES (?, x'00');"
  );
  database.$client.transaction((): void => {
    for (let id: number = 1; id <= count; id++) insert.run(id);
  })();
}

beforeEach(() => {
  resetStorageDatabaseCache();
  const client: Database = new Database(":memory:", { strict: true });
  client.run(
    "CREATE TABLE blocklist_entries (id INTEGER PRIMARY KEY, data BLOB NOT NULL);"
  );
  storageDatabaseHandle.current = drizzle({
    client,
    schema: storageDatabaseSchema,
  });
});

afterEach(() => {
  resetStorageDatabaseCache();
});

describe("Disk I/O 黑名单稳定游标页", () => {
  test("单页载荷受硬顶，按唯一主键续读且不重复", () => {
    const database: StorageDatabase = storageDatabaseHandle.current!;
    seedBlocklist(database, BLOCKLIST_SWEEP_PAGE_SIZE + 2);

    const first: BlocklistIdPageReadReply = readBlocklistIdPage({
      type: "readBlocklistIdPage",
      requestId: 1,
      afterId: null,
    });
    expect(first.error).toBeUndefined();
    expect(first.page?.ids).toHaveLength(BLOCKLIST_SWEEP_PAGE_SIZE);
    expect(first.page?.ids[0]).toBe(1);
    expect(first.page?.nextCursor).toBe(BLOCKLIST_SWEEP_PAGE_SIZE);
    expect(first.page?.done).toBeFalse();

    const second: BlocklistIdPageReadReply = readBlocklistIdPage({
      type: "readBlocklistIdPage",
      requestId: 2,
      afterId: first.page!.nextCursor,
    });
    expect(second.page).toEqual({
      ids: [BLOCKLIST_SWEEP_PAGE_SIZE + 1, BLOCKLIST_SWEEP_PAGE_SIZE + 2],
      nextCursor: BLOCKLIST_SWEEP_PAGE_SIZE + 2,
      done: true,
    });
  });

  test("事务内删除和新增只叠加到有界候选页", () => {
    const database: StorageDatabase = storageDatabaseHandle.current!;
    seedBlocklist(database, BLOCKLIST_SWEEP_PAGE_SIZE + 1);
    pendingBlocklistWrites.set(1, { data: null, revision: 1 });
    pendingBlocklistWrites.set(BLOCKLIST_SWEEP_PAGE_SIZE + 2, {
      data: "{}",
      revision: 2,
    });

    const reply: BlocklistIdPageReadReply = readBlocklistIdPage({
      type: "readBlocklistIdPage",
      requestId: 3,
      afterId: null,
    });

    expect(reply.page?.ids).toHaveLength(BLOCKLIST_SWEEP_PAGE_SIZE);
    expect(reply.page?.ids[0]).toBe(2);
    expect(reply.page?.ids.at(-1)).toBe(BLOCKLIST_SWEEP_PAGE_SIZE + 1);
    expect(reply.page?.done).toBeFalse();
  });

  test("事务内待写增量超过硬顶时以错误回执拒绝扩页，不抛出 Worker", () => {
    for (let id: number = 1; id <= BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES + 1; id++) {
      pendingBlocklistWrites.set(id, { data: "{}", revision: id });
    }

    const reply: BlocklistIdPageReadReply = readBlocklistIdPage({
      type: "readBlocklistIdPage",
      requestId: 4,
      afterId: null,
    });

    expect(reply).toEqual({
      type: "blocklistIdPageRead",
      requestId: 4,
      error: expect.stringContaining("refusing to expand a sweep page"),
    });
  });

  test("非法游标与非法身份主键都以错误回执结算对应请求", () => {
    const page: BlocklistIdPageReadReply = readBlocklistIdPage({
      type: "readBlocklistIdPage",
      requestId: 5,
      afterId: 1.5,
    });
    expect(page.type).toBe("blocklistIdPageRead");
    expect(page.requestId).toBe(5);
    expect(page.error).toEqual(expect.any(String));
    expect(page.page).toBeUndefined();

    const policies: IdentityPoliciesReadReply = readIdentityPolicies({
      type: "readIdentityPolicies",
      requestId: 6,
      ids: [7, 0],
    });
    expect(policies.type).toBe("identityPoliciesRead");
    expect(policies.requestId).toBe(6);
    expect(policies.error).toEqual(expect.any(String));
    expect(policies.whitelist).toBeUndefined();
  });
});
