/** Owner: Main thread。身份策略 LRU 与未 ACK 写入；跨线程只通过 Disk I/O 消息同步。 */

import { IDENTITY_READ_CACHE_MAX_ENTRIES } from "../../consts/identityStorage";
import { LruCache } from "../../libs/lruCache";
import type {
  BlocklistEntryData,
  IdentityPolicyTable,
  WhitelistEntryData,
} from "../../types/identityPolicy";
import type { UnacknowledgedIdentityWrite } from "../../types/identityStorage";
import { resetTemporaryWhitelistCache } from "./temporaryWhitelist";

/** 白名单热查询缓存；null 是已确认不存在的负缓存，容量严格为 8192。 */
export const whitelistEntryCache: LruCache<
  number,
  Readonly<WhitelistEntryData> | null
> = new LruCache(IDENTITY_READ_CACHE_MAX_ENTRIES);

/** 黑名单热查询缓存；null 是已确认不存在的负缓存，容量严格为 8192。 */
export const blocklistEntryCache: LruCache<
  number,
  Readonly<BlocklistEntryData> | null
> = new LruCache(IDENTITY_READ_CACHE_MAX_ENTRIES);

/** 启动时从 SQLite 取得的两表计数；之后随已预热主键的本地最终值变化增减。 */
export const identityEntryCounts: {
  whitelist: number;
  blocklist: number;
} = { whitelist: 0, blocklist: 0 };

/** 白名单未 ACK 最终值；同一主键反复修改只保留最新 revision。 */
export const unacknowledgedWhitelistWrites: Map<
  number,
  UnacknowledgedIdentityWrite
> = new Map();

/** 黑名单未 ACK 最终值；同一主键反复修改只保留最新 revision。 */
export const unacknowledgedBlocklistWrites: Map<
  number,
  UnacknowledgedIdentityWrite
> = new Map();

/**
 * 两表各一项未 ACK 字节总数；发布最终值时按差额更新，精确 ACK 释放，reset 清零。
 * Disk I/O Worker 重建时与主线程未 ACK 表一起保留，重放不重复记账。
 */
export const unacknowledgedIdentityBytes: { current: Record<IdentityPolicyTable, number> } = {
  current: { whitelist: 0, blocklist: 0 },
};

/** 身份策略写入 revision 发号器；只在主线程同步自增。 */
export const identityWriteRevision: { current: number } = { current: 0 };

/** 待踢成员完整快照的最新未 ACK revision；null 表示数据库已追平。 */
export const unacknowledgedRemovalSnapshotRevision: {
  current: number | null;
} = { current: null };

/** 待踢成员快照 revision 发号器。 */
export const removalSnapshotRevision: { current: number } = { current: 0 };

/** 按表取得未 ACK Map，供迟到读覆盖与 Worker 重建重放。 */
export function unacknowledgedIdentityWrites(
  table: IdentityPolicyTable
): Map<number, UnacknowledgedIdentityWrite> {
  return table === "whitelist"
    ? unacknowledgedWhitelistWrites
    : unacknowledgedBlocklistWrites;
}

/** 测试和应用全新生命周期初始化前重置有界缓存与一致性水位。 */
export function resetIdentityStorageCache(): void {
  whitelistEntryCache.clear();
  blocklistEntryCache.clear();
  identityEntryCounts.whitelist = 0;
  identityEntryCounts.blocklist = 0;
  unacknowledgedWhitelistWrites.clear();
  unacknowledgedBlocklistWrites.clear();
  unacknowledgedIdentityBytes.current.whitelist = 0;
  unacknowledgedIdentityBytes.current.blocklist = 0;
  identityWriteRevision.current = 0;
  unacknowledgedRemovalSnapshotRevision.current = null;
  removalSnapshotRevision.current = 0;
  resetTemporaryWhitelistCache();
}
