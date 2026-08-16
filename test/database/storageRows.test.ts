import { describe, expect, test } from "bun:test";
import { BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES } from
  "../../packages/consts/antiRaid/blocklist";
import { encodePendingBlockedRemovalData } from
  "../../packages/database/codec/identity";
import { decodeStoredPendingRemovals } from
  "../../packages/database/validation/storageRows";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";
import type { StoredPendingRemovalRow } from
  "../../packages/types/storageDatabase";

const SOURCE: string = "memory/storage.db";

function pendingRemoval(removalId: number): PendingBlockedRemoval {
  return {
    params: {
      chatId: -1_001,
      probeMembership: true,
      removalId,
    },
    createdAt: 1_000,
    attempts: 0,
    lastFailure: null,
  };
}

function storedPendingRemovals(count: number): readonly StoredPendingRemovalRow[] {
  return Array.from(
    { length: count },
    (_value: unknown, index: number): StoredPendingRemovalRow => {
      const removalId: number = index + 1;
      return {
        removalId,
        data: encodePendingBlockedRemovalData(
          pendingRemoval(removalId),
          `${SOURCE}:pending_blocked_removals[${removalId}].data`
        ).text,
      };
    }
  );
}

describe("SQLite 持久化行启动校验", () => {
  test("待踢 outbox 解码不再用运行时容量硬顶拒绝启动恢复", () => {
    const rows: readonly StoredPendingRemovalRow[] = storedPendingRemovals(
      BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES + 1
    );

    expect(decodeStoredPendingRemovals(rows, SOURCE).values).toHaveLength(
      BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES + 1
    );
  });
});
