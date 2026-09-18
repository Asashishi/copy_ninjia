/** Owner: Main thread。身份策略 LRU 与未 ACK 写入；跨线程只通过 Disk I/O 消息同步。 */

import { IDENTITY_READ_CACHE_MAX_ENTRIES } from "../../consts/identityStorage";
import { LruCache } from "../../libs/lruCache";
import type {
  BlocklistEntryData,
  IdentityPolicyTable,
  WhitelistEntryData,
} from "../../types/identityPolicy";
import type { UnacknowledgedIdentityWrite } from "../../types/identityStorage";
import { resetTemporaryAdBypassCache } from "./temporaryAdBypass";

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

/**
 * 补扫分页读「flush 请求 → 未 ACK 核对」窗口的计数与关闭通知。
 *
 * readBlocklistSweepPage 发出 flush 前记下 generation 并自增 open，核对结束后只在
 * generation 未变时自减；归零时 resolve 并清空 closed。回执驱动的黑名单写入（销号
 * 计数）等到归零后才同步投递，避免落进窗口让核对失败。容量为一个计数、一个代次
 * 与至多一组 resolver；flush 以回执、超时或失败结算，因此 Disk I/O Worker 重建不会
 * 让窗口悬空；进程重启从零开始，测试隔离重置时推进 generation 并唤醒等待者。
 */
export const blocklistSweepFlushWindows: {
  open: number;
  generation: number;
  closed: PromiseWithResolvers<void> | null;
} = { open: 0, generation: 0, closed: null };

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

/** 测试隔离与基准重置时清空有界缓存与一致性水位；生产进程从模块初始值开始。 */
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
  blocklistSweepFlushWindows.open = 0;
  blocklistSweepFlushWindows.generation++;
  blocklistSweepFlushWindows.closed?.resolve();
  blocklistSweepFlushWindows.closed = null;
  unacknowledgedRemovalSnapshotRevision.current = null;
  removalSnapshotRevision.current = 0;
  resetTemporaryAdBypassCache();
}
