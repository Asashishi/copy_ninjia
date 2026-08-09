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
  BLOCKLIST_MEMORY_DIR,
} from "../../../packages/consts/paths";
import {
  blocklistRemovalOutbox,
  blocklistRemovalOutboxDirty,
  resetBlocklistRemovalOutboxCache,
} from "../../../packages/cache/workers/diskIO/blocklistRemovals";
import {
  flushBlocklistRemovalOutbox,
  handleBlocklistRemovalsMessage,
  hydrateBlocklistRemovalOutbox,
} from "../../../packages/workers/diskIO/blocklistRemovalOutbox";
import type { PendingBlockedRemoval } from "../../../packages/types/blocklist";

/** 秒踢/广告处置那一类：人此刻确定在群里，名单随任务冻结。 */
const pending: PendingBlockedRemoval = {
  params: {
    chatId: -1001,
    userIds: [7, -4004],
    probeMembership: false,
    removalId: 9,
  },
  createdAt: 1_721_921_234_567,
  attempts: 2,
  lastFailure: "worker-restarted",
};

/** 补扫：只记「拿黑名单扫这个群」这件事，不冻结名单。 */
const sweepPending: PendingBlockedRemoval = {
  params: { chatId: -1002, probeMembership: true, removalId: 12 },
  createdAt: 1_721_921_234_567,
  attempts: 0,
  lastFailure: null,
};

beforeEach(() => {
  resetBlocklistRemovalOutboxCache();
  rmSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, { recursive: true, force: true });
  mkdirSync(BLOCKLIST_MEMORY_DIR, { recursive: true });
});

describe("黑名单成员移除 outbox", () => {
  test("文件不存在视为空；覆盖写入后可按当前 schema 完整恢复", () => {
    expect(hydrateBlocklistRemovalOutbox()).toEqual(new Map());
    expect(existsSync(BLOCKLIST_REMOVAL_OUTBOX_PATH)).toBeFalse();

    handleBlocklistRemovalsMessage({
      type: "blocklistRemovals",
      removals: [[9, pending]],
    });
    // 快照消息只替换镜像并标脏：落盘是统一 flush 的事，需要 durable 的调用方
    // 投完快照都紧接着 await 一次 flush。就地写盘会让「一批群依次清扫完成」
    // 变成一次 O(群数²) 的整份 outbox 重写。
    expect(blocklistRemovalOutboxDirty.current).toBeTrue();
    expect(existsSync(BLOCKLIST_REMOVAL_OUTBOX_PATH)).toBeFalse();
    expect(flushBlocklistRemovalOutbox()).toBeTrue();
    expect(blocklistRemovalOutboxDirty.current).toBeFalse();

    expect((): void =>
      handleBlocklistRemovalsMessage({
        type: "blocklistRemovals",
        removals: [[10, pending]],
      })
    ).toThrow();
    expect(blocklistRemovalOutbox.get(9)).toEqual(pending);

    expect(statSync(BLOCKLIST_REMOVAL_OUTBOX_PATH).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, "utf8"))).toEqual({
      version: 2,
      entries: [pending],
    });
    expect(hydrateBlocklistRemovalOutbox()).toEqual(new Map([[9, pending]]));
  });

  test("补扫条目不带名单，原样往返", () => {
    // outbox 记的是「拿黑名单扫这个群」这件事。冻一份 id 列表进来会让每次整份
    // 重写按「群数 × 名单长度」放大，重放时那份快照还可能已经过期
    // （见 types/blocklist.ts 的 PendingBlockedRemovalParams）。
    handleBlocklistRemovalsMessage({ type: "blocklistRemovals", removals: [[12, sweepPending]] });
    expect(flushBlocklistRemovalOutbox()).toBeTrue();

    const written = JSON.parse(readFileSync(BLOCKLIST_REMOVAL_OUTBOX_PATH, "utf8")) as {
      entries: { params: Record<string, unknown> }[];
    };
    expect("userIds" in written.entries[0]!.params).toBeFalse();
    expect(hydrateBlocklistRemovalOutbox()).toEqual(new Map([[12, sweepPending]]));
  });

  test("调用方后续修改数组不会污染 Worker 持有的 durable 快照", () => {
    const mutableIds: number[] = [7, -4004];
    const mutable: PendingBlockedRemoval = {
      params: { chatId: -1001, probeMembership: false, userIds: mutableIds, removalId: 9 },
      createdAt: pending.createdAt,
      attempts: pending.attempts,
      lastFailure: pending.lastFailure,
    };
    handleBlocklistRemovalsMessage({
      type: "blocklistRemovals",
      removals: [[9, mutable]],
    });
    mutableIds.push(99);
    expect(flushBlocklistRemovalOutbox()).toBeTrue();

    const restored = hydrateBlocklistRemovalOutbox().get(9)!.params;
    expect(restored.probeMembership).toBeFalse();
    expect(restored.probeMembership === false ? restored.userIds : []).toEqual([7, -4004]);
  });

  test("两次 flush 之间的多次快照变化合成一次写盘", () => {
    // 一批群依次清扫完成会连着投多份快照，而每份快照又按已登记的群数增长：
    // 就地写盘等于按群数放大的 O(n²) 整份 outbox 重写，每次还都是
    // tmp + fsync + rename。
    handleBlocklistRemovalsMessage({ type: "blocklistRemovals", removals: [[9, pending]] });
    handleBlocklistRemovalsMessage({ type: "blocklistRemovals", removals: [] });
    expect(existsSync(BLOCKLIST_REMOVAL_OUTBOX_PATH)).toBeFalse();

    expect(flushBlocklistRemovalOutbox()).toBeTrue();
    expect(hydrateBlocklistRemovalOutbox()).toEqual(new Map());
  });

  test("损坏、旧版本、重复 ID 与不合法字段都拒绝恢复", () => {
    const invalidFiles: unknown[] = [
      { version: 0, entries: [] },
      // v1 是补扫仍然冻结名单的旧格式：必须拒绝启动，而不是把一份过期快照
      // 当成任务重放（迁移见 docs/cn/07-operations.md）。
      { version: 1, entries: [] },
      { version: 2, entries: [pending, pending] },
      { version: 2, entries: [{ ...pending, attempts: -1 }] },
      { version: 2, entries: [{ ...pending, createdAt: -1 }] },
      { version: 2, entries: [{ ...pending, createdAt: 1.5 }] },
      { version: 2, entries: [{ ...pending, params: { ...pending.params, joinedAt: 1.5 } }] },
      { version: 2, entries: [{ ...pending, lastFailure: "unknown" }] },
      {
        version: 2,
        entries: [{
          params: { ...pending.params, userIds: [7, 7] },
          createdAt: pending.createdAt,
          attempts: 0,
          lastFailure: null,
        }],
      },
      // 补扫带着名单 / 秒踢字段：多半是没迁移干净的 v1 条目。
      { version: 2, entries: [{ ...sweepPending, params: { ...sweepPending.params, userIds: [7] } }] },
      { version: 2, entries: [{ ...sweepPending, params: { ...sweepPending.params, joinedAt: 1 } }] },
      { version: 2, entries: [{ ...sweepPending, params: { ...sweepPending.params, announcementMessageId: 1 } }] },
      // 非补扫必须带名单。
      { version: 2, entries: [{ ...pending, params: { chatId: -1001, probeMembership: false, removalId: 9 } }] },
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
    expect(flushBlocklistRemovalOutbox()).toBeTrue();
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
    const orphan: string = `${BLOCKLIST_MEMORY_DIR}/.removals.json.99.outbox.tmp`;
    // 同目录下的外来临时文件也不能碰：前缀是这道清扫唯一的归属判据。
    const foreign: string = `${BLOCKLIST_MEMORY_DIR}/.foreign.json.99.outbox.tmp`;
    writeFileSync(orphan, "{}");
    writeFileSync(foreign, "{}");

    hydrateBlocklistRemovalOutbox();

    expect(existsSync(orphan)).toBeFalse();
    expect(existsSync(foreign)).toBeTrue();
    rmSync(foreign, { force: true });
  });
});
