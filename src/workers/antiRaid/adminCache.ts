import { joinVerificationApi } from "../../infra/telegram";
import { ADMIN_CACHE_TTL_MS } from "../../consts/antiRaid/cache";
import {
  bufferAdminChangeDuringFetch,
  cacheAdminIds,
  chatAdmins,
  discardPendingAdminChanges,
  getOrCreateAdminFetch,
  takePendingAdminChanges,
} from "../../cache/antiRaid/admins";

/**
 * 各群管理员表缓存：按需全量拉取 + TTL 缓存 + 拉取在途期间到达的增量变化
 * 缓冲重放（见 pendingAdminChangesDuringFetch 注释），供「管理员拉人免
 * 验证」（verificationRuntime.ts）与「私密模式期间管理员拉人同步豁免/预热」
 * （lockdownRuntime.ts）两处同步判定使用。
 */

/** 未过期的某群管理员 ID 集合；没拉取过或已过期则返回 undefined，让调用方走异步兜底。 */
export function freshAdminIds(chatId: number): Set<number> | undefined {
  const cached = chatAdmins.get(chatId);
  if (!cached || Date.now() - cached.fetchedAt > ADMIN_CACHE_TTL_MS) return undefined;
  return cached.adminIds;
}

/** 全量拉取某群的管理员表并落缓存（带进行中去重，见 adminFetches）。 */
export function fetchAdminIds(chatId: number): Promise<Set<number>> {
  return getOrCreateAdminFetch(chatId, () =>
    joinVerificationApi
      .getChatAdministrators(chatId)
      .then((admins) => {
        const adminIds: Set<number> = new Set(admins.map((admin) => admin.user.id));
        // 拉取在途期间到达的增量变化比这份快照更新（chat_member 更新是
        // 近实时的权威信号），重放在其上，不能被这次 resolve 覆盖掉——见
        // pendingAdminChangesDuringFetch 注释。
        const pending = takePendingAdminChanges(chatId);
        if (pending) {
          for (const [userId, isAdmin] of pending) {
            if (isAdmin) adminIds.add(userId);
            else adminIds.delete(userId);
          }
        }
        cacheAdminIds(chatId, adminIds);
        return adminIds;
      })
      .catch((error: unknown) => {
        // 没有成功的全量快照就没有可重放增量的基底。下次拉取会取得更新的
        // 权威快照；继续留着只会让失败过的群永久占住这张 Map。
        discardPendingAdminChanges(chatId);
        throw error;
      })
  );
}

/**
 * 应用一条管理员任免事件（主线程从 chat_member 更新里提取）。原地增删已有的
 * 缓存条目——还没按需拉取过的群没有条目可改，之后的首次全量拉取天然是最新的。
 * 若此刻恰好有一次全量拉取在途，额外把这次变化记进 pendingAdminChangesDuringFetch，
 * 由 fetchAdminIds 的 resolve 回调重放，避免被迟到的快照覆盖/漏收（见其注释）。
 */
export function applyAdminChange(chatId: number, userId: number, isAdmin: boolean): void {
  bufferAdminChangeDuringFetch(chatId, userId, isAdmin);
  const cached = chatAdmins.get(chatId);
  if (!cached) return;
  if (isAdmin) {
    cached.adminIds.add(userId);
  } else {
    cached.adminIds.delete(userId);
  }
}
