import type { ChatAdminCache } from "../../../types/antiRaid/internal";
import { ADMIN_CACHE_TTL_MS, ANTI_RAID_CHAT_CACHE_MAX } from "../../../consts/antiRaid/cache";
import { setBoundedMapValue } from "../../../libs/boundedMap";

/** 非匿名管理员邀请豁免表（packages/workers/antiRaid/adminCache.ts）的内存状态。 */

/** 按需拉取的各群非匿名管理员 ID 表。 */
export const chatAdmins: Map<number, ChatAdminCache> = new Map();
/** 进行中的全量管理员拉取，按 chatId 去重。 */
export const adminFetches: Map<number, Promise<Set<number>>> = new Map();
/** 全量拉取在途期间到达的增量资格变化，待快照落地后重放。 */
export const pendingAdminChangesDuringFetch: Map<number, Map<number, boolean>> = new Map();

/**
 * 整表世代号：`resetAdminCache()` 每次自增。在途的全量拉取用它判断自己那份
 * 快照是不是已经被一次整表清空作废——清空同时丢掉了
 * `pendingAdminChangesDuringFetch`，因此 reset 之后再把 reset 前的快照写回去，
 * 等于让那段窗口里到达的管理员降权凭空消失。
 * 填充/清理时机：只在 resetAdminCache 自增，永不回退；容量固定一个数字，
 * Worker 崩溃重建后从 0 重新开始，届时在途拉取也随旧 isolate 一起没了。
 */
export const adminCacheGeneration: { current: number } = { current: 0 };

/** 某次拉取启动时记下的世代号是否仍然有效（其间没有发生过整表清空）。 */
export function isCurrentAdminCacheGeneration(generation: number): boolean {
  return adminCacheGeneration.current === generation;
}

/** 在 500 群硬顶内落一份非匿名管理员豁免快照。 */
export function cacheAdminIds(chatId: number, adminIds: Set<number>, fetchedAt: number = Date.now()): void {
  setBoundedMapValue({
    map: chatAdmins,
    key: chatId,
    value: { adminIds, fetchedAt },
    maxEntries: ANTI_RAID_CHAT_CACHE_MAX,
  });
}

/**
 * 获取或创建同群唯一一次全量拉取；settle 后释放**自己那个**在途槽位。
 *
 * 释放前必须比对身份（主线程侧的同类表 botAdminFetches/botPermissionFetches
 * 都做了这道比对）：`resetAdminCache()` 会在拉取在途时清空整张表，随后新的
 * `fetchAdminIds` 会为同一个群登记一条全新的 fetch。陈旧 fetch 结算时若无条件
 * delete，删掉的是**新 fetch** 的槽位，去重随之失效——下一个调用者会在入群
 * 验证使用的 query 类别 429 FIFO 上发起第三次全量拉取。
 */
export function getOrCreateAdminFetch(chatId: number, create: () => Promise<Set<number>>): Promise<Set<number>> {
  const existing: Promise<Set<number>> | undefined = adminFetches.get(chatId);
  if (existing) return existing;
  const inFlight: Promise<Set<number>> = create().finally((): void => {
    if (adminFetches.get(chatId) === inFlight) adminFetches.delete(chatId);
  });
  adminFetches.set(chatId, inFlight);
  return inFlight;
}

/** 若全量拉取正在进行，合并记录一条比快照更新的邀请豁免资格变化。 */
export function bufferAdminChangeDuringFetch(
  chatId: number,
  userId: number,
  isInviterExempt: boolean
): void {
  if (!adminFetches.has(chatId)) return;
  let pending: Map<number, boolean> | undefined = pendingAdminChangesDuringFetch.get(chatId);
  if (!pending) {
    pending = new Map();
    pendingAdminChangesDuringFetch.set(chatId, pending);
  }
  pending.set(userId, isInviterExempt);
}

/** 取走并删除一次拉取期间积累的邀请豁免资格变化。 */
export function takePendingAdminChanges(chatId: number): Map<number, boolean> | undefined {
  const pending: Map<number, boolean> | undefined = pendingAdminChangesDuringFetch.get(chatId);
  pendingAdminChangesDuringFetch.delete(chatId);
  return pending;
}

/** 拉取失败或群失效时丢弃该群尚未重放的管理员增量。 */
export function discardPendingAdminChanges(chatId: number): void {
  pendingAdminChangesDuringFetch.delete(chatId);
}

/** 淘汰过期快照；仍在拉取的群保留旧快照供同步快路径使用。 */
export function sweepAdminCache(now: number = Date.now()): number {
  let deleted: number = 0;
  for (const [chatId, cached] of chatAdmins) {
    if (now - cached.fetchedAt > ADMIN_CACHE_TTL_MS && !adminFetches.has(chatId)) {
      chatAdmins.delete(chatId);
      deleted++;
    }
  }
  return deleted;
}

/** Worker dispose/测试隔离时清空管理员缓存及其在途状态，并作废在途拉取的写回。 */
export function resetAdminCache(): void {
  chatAdmins.clear();
  adminFetches.clear();
  pendingAdminChangesDuringFetch.clear();
  adminCacheGeneration.current++;
}
