import {
  blocklistEntryCache,
  identityEntryCounts,
  resetIdentityStorageCache,
  whitelistEntryCache,
} from "../../packages/cache/main/identityStorage";
import type { BlocklistEntryData } from "../../packages/types/identityPolicy";

interface BlockedTestRecord {
  readonly isBlocked: true;
  readonly blockedAt: string;
}

/** 旧黑名单单测迁到新 LRU 时使用的无敏感字段 meta。 */
export const TEST_IDENTITY_META: Readonly<{
  firstName: string;
  lastName: string;
  username: string;
}> = { firstName: "Test", lastName: "", username: "test" };

const blockedIdentityTestIds: Set<number> = new Set<number>();

/**
 * 只存在于测试 isolate 的旧 Map 观察适配器；生产代码不再持有无界黑名单 Map。
 * set 同时补齐两表正/负缓存，使被测写操作满足“先冷读、后变更”的运行时前提。
 */
export const blockedIdentityTestView: {
  readonly size: number;
  clear(): void;
  get(id: number): BlockedTestRecord | undefined;
  has(id: number): boolean;
  keys(): IterableIterator<number>;
  set(id: number, record: BlockedTestRecord): void;
} = {
  get size(): number {
    return identityEntryCounts.blocklist;
  },
  clear(): void {
    blockedIdentityTestIds.clear();
    resetIdentityStorageCache();
  },
  get(id: number): BlockedTestRecord | undefined {
    const entry: Readonly<BlocklistEntryData> | null | undefined =
      blocklistEntryCache.peek(id);
    return entry === undefined || entry === null
      ? undefined
      : { isBlocked: true, blockedAt: entry.blockedAt };
  },
  has(id: number): boolean {
    return blocklistEntryCache.peek(id) !== undefined &&
      blocklistEntryCache.peek(id) !== null;
  },
  keys(): IterableIterator<number> {
    return blockedIdentityTestIds.keys();
  },
  set(id: number, record: BlockedTestRecord): void {
    if (!this.has(id)) identityEntryCounts.blocklist++;
    blockedIdentityTestIds.add(id);
    blocklistEntryCache.set(id, {
      blockedAt: record.blockedAt,
      meta: TEST_IDENTITY_META,
    });
    whitelistEntryCache.set(id, null);
  },
};

/** 模拟 SQLite 全表主键查询；不受主线程 8192 项 LRU 淘汰影响。 */
export function readBlockedIdentityTestIds(): readonly number[] {
  return [...blockedIdentityTestIds];
}

/** 为将要新增的身份建立两张表的负缓存。 */
export function seedMissingIdentity(id: number): void {
  if (!blocklistEntryCache.has(id)) blocklistEntryCache.set(id, null);
  if (!whitelistEntryCache.has(id)) whitelistEntryCache.set(id, null);
}
