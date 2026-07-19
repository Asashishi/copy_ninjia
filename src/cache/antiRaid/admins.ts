import type { ChatAdminCache } from "../../types/antiRaid/internal";
import { ADMIN_CACHE_TTL_MS, ANTI_RAID_CHAT_CACHE_MAX } from "../../consts/antiRaid/cache";
import { setBoundedMapValue } from "../../libs/boundedMap";

/** 按需拉取的各群管理员表。 */
export const chatAdmins: Map<number, ChatAdminCache> = new Map();
/** 进行中的全量管理员拉取，按 chatId 去重。 */
export const adminFetches: Map<number, Promise<Set<number>>> = new Map();
/** 全量拉取在途期间到达的增量任免，待快照落地后重放。 */
export const pendingAdminChangesDuringFetch: Map<number, Map<number, boolean>> = new Map();

/** 在 500 群硬顶内落一份管理员快照。 */
export function cacheAdminIds(chatId: number, adminIds: Set<number>, fetchedAt: number = Date.now()): void {
  setBoundedMapValue({
    map: chatAdmins,
    key: chatId,
    value: { adminIds, fetchedAt },
    maxEntries: ANTI_RAID_CHAT_CACHE_MAX,
  });
}

/** 获取或创建同群唯一一次全量拉取；settle 后自动释放在途槽位。 */
export function getOrCreateAdminFetch(chatId: number, create: () => Promise<Set<number>>): Promise<Set<number>> {
  let inFlight = adminFetches.get(chatId);
  if (inFlight) return inFlight;
  inFlight = create().finally(() => adminFetches.delete(chatId));
  adminFetches.set(chatId, inFlight);
  return inFlight;
}

/** 若全量拉取正在进行，合并记录一条比快照更新的管理员任免。 */
export function bufferAdminChangeDuringFetch(chatId: number, userId: number, isAdmin: boolean): void {
  if (!adminFetches.has(chatId)) return;
  let pending = pendingAdminChangesDuringFetch.get(chatId);
  if (!pending) {
    pending = new Map();
    pendingAdminChangesDuringFetch.set(chatId, pending);
  }
  pending.set(userId, isAdmin);
}

/** 取走并删除一次拉取期间积累的管理员任免。 */
export function takePendingAdminChanges(chatId: number): Map<number, boolean> | undefined {
  const pending = pendingAdminChangesDuringFetch.get(chatId);
  pendingAdminChangesDuringFetch.delete(chatId);
  return pending;
}

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

/** Worker dispose/测试隔离时清空管理员缓存及其在途状态。 */
export function resetAdminCache(): void {
  chatAdmins.clear();
  adminFetches.clear();
  pendingAdminChangesDuringFetch.clear();
}
