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
import type { ChatAdminCache } from "../../types/antiRaid/internal";
import type { ChatMemberAdministrator, ChatMemberOwner } from "@grammyjs/types";

/**
 * 各群非匿名管理员邀请豁免缓存：按需全量拉取 + TTL 缓存 + 拉取在途期间
 * 到达的增量变化缓冲重放（见 pendingAdminChangesDuringFetch 注释），供
 * verificationRuntime.ts 与 lockdownRuntime.ts 的同步邀请者判定使用。
 * 匿名管理员故意不进入缓存：Telegram 对 ChatMemberUpdated.from 的匿名
 * 操作者表示没有稳定保证，不能用可能脱敏/共享的身份跳过入群验证。
 */

/** 未过期的某群非匿名管理员 ID 集合；没有或过期时返回 undefined。 */
export function freshAdminIds(chatId: number): Set<number> | undefined {
  const cached: ChatAdminCache | undefined = chatAdmins.get(chatId);
  if (!cached || Date.now() - cached.fetchedAt > ADMIN_CACHE_TTL_MS) return undefined;
  return cached.adminIds;
}

/** 全量拉取某群非匿名管理员并落缓存（带进行中去重，见 adminFetches）。 */
export function fetchAdminIds(chatId: number): Promise<Set<number>> {
  return getOrCreateAdminFetch(chatId, (): Promise<Set<number>> =>
    joinVerificationApi
      .getChatAdministrators(chatId)
      .then((admins: (ChatMemberOwner | ChatMemberAdministrator)[]): Set<number> => {
        const adminIds: Set<number> = new Set(
          admins.filter((admin: ChatMemberOwner | ChatMemberAdministrator): boolean => admin.is_anonymous !== true).map((admin: ChatMemberOwner | ChatMemberAdministrator): number => admin.user.id)
        );
        // 拉取在途期间到达的增量变化比这份快照更新（chat_member 更新是
        // 近实时的权威信号），重放在其上，不能被这次 resolve 覆盖掉——见
        // pendingAdminChangesDuringFetch 注释。
        const pending: Map<number, boolean> | undefined = takePendingAdminChanges(chatId);
        if (pending) {
          for (const [userId, isInviterExempt] of pending) {
            if (isInviterExempt) adminIds.add(userId);
            else adminIds.delete(userId);
          }
        }
        cacheAdminIds(chatId, adminIds);
        return adminIds;
      })
      .catch((error: unknown): never => {
        // 没有成功的全量快照就没有可重放增量的基底。下次拉取会取得更新的
        // 权威快照；继续留着只会让失败过的群永久占住这张 Map。
        discardPendingAdminChanges(chatId);
        throw error;
      })
  );
}

/**
 * 应用一条非匿名管理员邀请豁免资格变化（主线程从 chat_member 更新提取）。
 * 原地增删已有缓存——还没按需拉取过的群没有条目可改，首次全量拉取天然最新。
 * 若此刻恰好有一次全量拉取在途，额外把这次变化记进 pendingAdminChangesDuringFetch，
 * 由 fetchAdminIds 的 resolve 回调重放，避免被迟到的快照覆盖/漏收（见其注释）。
 */
export function applyAdminChange(chatId: number, userId: number, isInviterExempt: boolean): void {
  bufferAdminChangeDuringFetch(chatId, userId, isInviterExempt);
  const cached: ChatAdminCache | undefined = chatAdmins.get(chatId);
  if (!cached) return;
  if (isInviterExempt) {
    cached.adminIds.add(userId);
  } else {
    cached.adminIds.delete(userId);
  }
}
