/** Owner: 主线程。临时白名单读取 LRU 与尚未收到 SQLite ACK 的最终值。 */

import { IDENTITY_READ_CACHE_MAX_ENTRIES } from "../../consts/identityStorage";
import { LruCache } from "../../libs/lruCache";
import type {
  TemporaryWhitelistActivity,
  UnacknowledgedTemporaryWhitelistWrite,
} from "../../types/temporaryWhitelist";

/**
 * 临时白名单累计热查询；update 预读与本地 write-through 填充，null 表示确证不存在。
 * 容量严格为 8192，超出按 LRU 淘汰；进程初始化时清空。Disk I/O Worker 重建期间
 * 本缓存继续提供同步最终值，冷缺失在新 Worker 激活后重新预读。
 */
export const temporaryWhitelistActivityCache: LruCache<
  number,
  Readonly<TemporaryWhitelistActivity> | null
> = new LruCache(IDENTITY_READ_CACHE_MAX_ENTRIES);

/**
 * SQLite 尚未精确 ACK 的主线程最终值；同一身份原地合并，ACK 后删除。
 * 本表不淘汰未落盘事实；健康态由 128 条/30 秒事务持续收敛，Worker 重建时按
 * revision 顺序重放，进程全新初始化才整体清空。
 */
export const unacknowledgedTemporaryWhitelistWrites: Map<
  number,
  UnacknowledgedTemporaryWhitelistWrite
> = new Map();

/**
 * 临时白名单累计写入 revision 发号器；主线程同步自增并在溢出前拒绝写入。
 * Disk I/O Worker 重建不回退，保证重放次序；进程全新初始化时归零。
 */
export const temporaryWhitelistWriteRevision: { current: number } = { current: 0 };

/** 应用全新生命周期和测试隔离时清空读取、未 ACK 最终值与 revision。 */
export function resetTemporaryWhitelistCache(): void {
  temporaryWhitelistActivityCache.clear();
  unacknowledgedTemporaryWhitelistWrites.clear();
  temporaryWhitelistWriteRevision.current = 0;
}
