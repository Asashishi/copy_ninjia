import { telegramApi } from "../../infra/telegram";
import { logger } from "../../infra/logger";
import { ADMIN_CACHE_TTL_MS } from "../../consts/antiRaid/cache";
import {
  adminCacheGeneration,
  bufferAdminChangeDuringFetch,
  cacheAdminIds,
  chatAdmins,
  adminFetches,
  pendingAdminChangesDuringFetch,
  takePendingAdminChanges,
} from "../../cache/workers/antiRaid/admins";
import type { ChatAdminCache } from "../../types/antiRaid/internal";
import type { ChatMemberAdministrator, ChatMemberOwner } from "grammy/types";
import { trackAntiRaidTask } from "./taskTracker";
import { isRecordedWithin } from "../../libs/clockWindow";
import { getOrCreateKeyedTask } from "../../libs/keyedTask";

/**
 * 各群非匿名管理员邀请豁免缓存：按需全量拉取 + TTL 缓存 + 拉取在途期间
 * 到达的增量变化缓冲重放（见 pendingAdminChangesDuringFetch 注释），供入群验证
 * （verificationEvents.ts、verificationEffects.ts、verificationEffects/terminal.ts、
 * verificationCallbacks.ts）、私密模式预热（lockdownRuntime.ts）、刷屏禁言与广告处置的
 * 管理员身份判定使用。
 * 匿名管理员不进入缓存，不用于跳过入群验证。
 */

/**
 * 未过期的某群非匿名管理员 ID 集合；没有或过期时返回 undefined。
 *
 * `now` 缺省取墙钟；每条群消息都会走到的调用点显式传本条消息的 `now`
 * （见 adDetect/queue.ts 的 enqueueAdCandidate），TTL 判定与消息记账落在同一时刻。
 * 形状同 libs/chatState.ts 的 isQuietUntilActive：热路径传值，低频命令用缺省。
 */
export function freshAdminIds(chatId: number, now: number = Date.now()): Set<number> | undefined {
  const cached: ChatAdminCache | undefined = chatAdmins.get(chatId);
  if (!cached || !isRecordedWithin(cached.fetchedAt, now, ADMIN_CACHE_TTL_MS)) return undefined;
  return cached.adminIds;
}

/** 全量拉取某群非匿名管理员并落缓存（带进行中去重，见 adminFetches）。 */
export function fetchAdminIds(chatId: number): Promise<Set<number>> {
  // 记下启动时的整表世代号：resetAdminCache() 会把 chatAdmins 与
  // pendingAdminChangesDuringFetch 一起清空，世代不符的拉取不再写回。
  const generation: number = adminCacheGeneration.current;
  const task: Promise<Set<number>> = getOrCreateKeyedTask(adminFetches, chatId, (): Promise<Set<number>> =>
    telegramApi
      .getChatAdministrators(chatId)
      .then((admins: (ChatMemberOwner | ChatMemberAdministrator)[]): Set<number> => {
        const adminIds: Set<number> = new Set(
          admins.filter((admin: ChatMemberOwner | ChatMemberAdministrator): boolean => admin.is_anonymous !== true).map((admin: ChatMemberOwner | ChatMemberAdministrator): number => admin.user.id)
        );
        // 世代对不上就只把结果交给等待者，不写回缓存。
        if (adminCacheGeneration.current !== generation) return adminIds;
        // 拉取在途期间到达的增量变化比这份快照新，重放在其上（见
        // pendingAdminChangesDuringFetch 注释）。
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
        // 没有成功的全量快照就没有可重放增量的基底：丢弃该群在途增量，下次拉取取得
        // 新的权威快照。世代不符时不动这张 Map。
        if (adminCacheGeneration.current === generation) pendingAdminChangesDuringFetch.delete(chatId);
        throw error;
      })
  );
  return trackAntiRaidTask({ task });
}

/**
 * 处置前的身份闸：某人此刻是不是本群管理员。优先用入群守卫本来就热的缓存，
 * 冷了才现拉一次全量。
 *
 * **确证不了一律返回 undefined，调用方按不处置办**；刷屏禁言与广告处置共用这份
 * 兜底语义。
 *
 * @param context 只用于失败日志的英文处置名（见 AGENTS.md 的日志约定）。
 * @returns true=确认是管理员；false=确认不是；undefined=没查出来。
 */
export async function isChatAdmin(
  chatId: number,
  userId: number,
  context: string
): Promise<boolean | undefined> {
  const cached: Set<number> | undefined = freshAdminIds(chatId);
  if (cached !== undefined) return cached.has(userId);
  try {
    return (await fetchAdminIds(chatId)).has(userId);
  } catch (error: unknown) {
    logger.error(`Failed to check admin exemption for ${context} ${userId} in chat ${chatId}:`, error);
    return undefined;
  }
}

/**
 * 应用一条非匿名管理员邀请豁免资格变化（主线程从 chat_member 更新提取）。
 * 原地增删已有缓存——还没按需拉取过的群没有条目可改，首次全量拉取天然最新。
 * 若此刻恰好有一次全量拉取在途，额外把这次变化记进 pendingAdminChangesDuringFetch，
 * 由 fetchAdminIds 的 resolve 回调重放（见其注释）。
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
