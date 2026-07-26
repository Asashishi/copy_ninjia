import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  BLOCKLIST_REMOVAL_OUTBOX_PATH,
  MEMORY_DIR,
} from "../../../packages/consts/paths";
import {
  blocklistRemovalOutbox,
  blocklistRemovalOutboxDirty,
  resetBlocklistRemovalOutboxCache,
} from "../../../packages/cache/diskIO/blocklistRemovals";
import {
  flushBlocklistRemovalOutbox,
  handleBlocklistRemovalsMessage,
  hydrateBlocklistRemovalOutbox,
} from "../../../packages/workers/diskIO/blocklistRemovalOutbox";
import type { PendingBlockedRemoval } from "../../../packages/types/blocklist";

const pending: PendingBlockedRemoval = {
  params: {
    chatId: -1001,
    userIds: [7, -4004],
    probeMembership: true,
    removalId: 9,
  },
  createdAt: 1_721_921_234_567,
  attempts: 2,
  lastFailure: "worker-restarted",
};

beforeEach(() => {
  resetBlocklistRemovalOutboxCache();
  rmSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, { recursive: true, force: true });
  mkdirSync(MEMORY_DIR, { recursive: true });
});

describe("黑名单成员移除 outbox", () => {
  test("文件不存在视为空；覆盖写入后可按当前 schema 完整恢复", () => {
    expect(hydrateBlocklistRemovalOutbox()).toEqual(new Map());
    expect(existsSync(BLOCKLIST_REMOVAL_OUTBOX_PATH)).toBeFalse();

    handleBlocklistRemovalsMessage({
      type: "blocklistRemovals",
      removals: [[9, pending]],
    });
    expect((): void =>
      handleBlocklistRemovalsMessage({
        type: "blocklistRemovals",
        removals: [[10, pending]],
      })
    ).toThrow();
    expect(blocklistRemovalOutbox.get(9)).toEqual(pending);

    expect(statSync(BLOCKLIST_REMOVAL_OUTBOX_PATH).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, "utf8"))).toEqual({
      version: 1,
      entries: [pending],
    });
    expect(hydrateBlocklistRemovalOutbox()).toEqual(new Map([[9, pending]]));
  });

  test("调用方后续修改数组不会污染 Worker 持有的 durable 快照", () => {
    const mutable: PendingBlockedRemoval = {
      params: { ...pending.params, userIds: [...pending.params.userIds] },
      createdAt: pending.createdAt,
      attempts: pending.attempts,
      lastFailure: pending.lastFailure,
    };
    handleBlocklistRemovalsMessage({
      type: "blocklistRemovals",
      removals: [[9, mutable]],
    });
    mutable.params.userIds.push(99);

    expect(hydrateBlocklistRemovalOutbox().get(9)?.params.userIds).toEqual([7, -4004]);
  });

  test("损坏、旧版本、重复 ID 与不合法字段都拒绝恢复", () => {
    const invalidFiles: unknown[] = [
      { version: 0, entries: [] },
      { version: 1, entries: [pending, pending] },
      { version: 1, entries: [{ ...pending, attempts: -1 }] },
      { version: 1, entries: [{ ...pending, createdAt: -1 }] },
      { version: 1, entries: [{ ...pending, createdAt: 1.5 }] },
      { version: 1, entries: [{ ...pending, params: { ...pending.params, joinedAt: 1.5 } }] },
      { version: 1, entries: [{ ...pending, lastFailure: "unknown" }] },
      {
        version: 1,
        entries: [{
          params: { ...pending.params, userIds: [7, 7] },
          createdAt: pending.createdAt,
          attempts: 0,
          lastFailure: null,
        }],
      },
    ];
    for (const invalid of invalidFiles) {
      writeFileSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, JSON.stringify(invalid));
      expect((): Map<number, PendingBlockedRemoval> => hydrateBlocklistRemovalOutbox()).toThrow();
    }
  });

  test("原子重写失败时保持 dirty，目标恢复后统一 flush 会重试", () => {
    handleBlocklistRemovalsMessage({
      type: "blocklistRemovals",
      removals: [[9, pending]],
    });
    const stashed: string = `${BLOCKLIST_REMOVAL_OUTBOX_PATH}.stashed`;
    renameSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, stashed);
    mkdirSync(BLOCKLIST_REMOVAL_OUTBOX_PATH);

    handleBlocklistRemovalsMessage({
      type: "blocklistRemovals",
      removals: [],
    });
    expect(blocklistRemovalOutboxDirty.current).toBeTrue();
    expect(flushBlocklistRemovalOutbox()).toBeFalse();

    rmSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, { recursive: true, force: true });
    renameSync(stashed, BLOCKLIST_REMOVAL_OUTBOX_PATH);
    expect(flushBlocklistRemovalOutbox()).toBeTrue();
    expect(hydrateBlocklistRemovalOutbox()).toEqual(new Map());
  });

  test("启动恢复只清理自己的孤儿临时文件", () => {
    const orphan: string = `${MEMORY_DIR}/.blocklist-removals.json.99.outbox.tmp`;
    const foreign: string = `${MEMORY_DIR}/.foreign.json.99.outbox.tmp`;
    writeFileSync(orphan, "{}");
    writeFileSync(foreign, "{}");

    hydrateBlocklistRemovalOutbox();

    expect(existsSync(orphan)).toBeFalse();
    expect(existsSync(foreign)).toBeTrue();
    rmSync(foreign, { force: true });
  });
});
