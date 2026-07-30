/**
 * 主线程黑名单两层身份视图。
 *
 * configuredBlockedIds 是人工维护、进程内只读的静态层；blockedUserIds 是
 * /block 与广告处置写入 memory/ 的动态层。任何查询和补扫都必须读取并集，
 * 但只有动态层可以被 /unblock 或 Disk I/O Worker 改写。
 */

import {
  blockedUserIds,
  configuredBlockedIds,
} from "../../cache/main/blocklist";

/** 身份是否存在于静态配置层。 */
export function isConfiguredBlockedIdentity(id: number): boolean {
  return configuredBlockedIds.has(id);
}

/** 身份是否存在于静态或动态黑名单任一层。 */
export function isBlockedIdentity(id: number): boolean {
  return configuredBlockedIds.has(id) || blockedUserIds.has(id);
}

/** 两层并集是否至少包含一个身份。 */
export function hasBlockedIdentities(): boolean {
  return configuredBlockedIds.size > 0 || blockedUserIds.size > 0;
}

/**
 * 取得稳定去重的两层并集；静态层排在前面，动态层只补充尚未出现的 ID。
 * 返回新数组，调用方可直接跨线程传递而不会暴露缓存引用。
 */
export function listBlockedIdentityIds(): number[] {
  return [...new Set<number>([
    ...configuredBlockedIds,
    ...blockedUserIds.keys(),
  ])];
}
