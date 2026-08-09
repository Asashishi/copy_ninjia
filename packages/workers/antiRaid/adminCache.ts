import { joinVerificationApi } from "../../infra/telegram";
import { logger } from "../../infra/logger";
import { ADMIN_CACHE_TTL_MS } from "../../consts/antiRaid/cache";
import {
  adminCacheGeneration,
  bufferAdminChangeDuringFetch,
  cacheAdminIds,
  chatAdmins,
  discardPendingAdminChanges,
  getOrCreateAdminFetch,
  isCurrentAdminCacheGeneration,
  takePendingAdminChanges,
} from "../../cache/workers/antiRaid/admins";
import type { ChatAdminCache } from "../../types/antiRaid/internal";
import type { ChatMemberAdministrator, ChatMemberOwner } from "@grammyjs/types";
import { trackAntiRaidTask } from "./taskTracker";

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
  // 记下启动时的整表世代号：resetAdminCache() 会在拉取在途时把 chatAdmins 与
  // pendingAdminChangesDuringFetch 一起清空，此后这次拉取的一切写回都是过期的。
  const generation: number = adminCacheGeneration.current;
  const task: Promise<Set<number>> = getOrCreateAdminFetch(chatId, (): Promise<Set<number>> =>
    joinVerificationApi
      .getChatAdministrators(chatId)
      .then((admins: (ChatMemberOwner | ChatMemberAdministrator)[]): Set<number> => {
        const adminIds: Set<number> = new Set(
          admins.filter((admin: ChatMemberOwner | ChatMemberAdministrator): boolean => admin.is_anonymous !== true).map((admin: ChatMemberOwner | ChatMemberAdministrator): number => admin.user.id)
        );
        // 世代对不上就只把结果交给等待者，绝不写回缓存：整表已被清空一次，而
        // 那次清空同时丢掉了本次拉取期间到达的增量。此刻把 reset 前的旧快照灌
        // 进刚清空的表，等于让那段窗口里的管理员降权静默消失——被降权者会在
        // 整个 ADMIN_CACHE_TTL_MS 内继续留在邀请人豁免集合里，他拉进来的人
        // 全部免入群验证。
        if (!isCurrentAdminCacheGeneration(generation)) return adminIds;
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
        // 同样要比对世代：整表清空之后这张 Map 里躺的是**新**一轮拉取积累的
        // 增量，陈旧拉取的失败不该把它们一并丢掉。
        if (isCurrentAdminCacheGeneration(generation)) discardPendingAdminChanges(chatId);
        throw error;
      })
  );
  return trackAntiRaidTask({ task });
}

/**
 * 处置前的身份闸：某人此刻是不是本群管理员。优先用入群守卫本来就热的缓存，
 * 冷了才现拉一次全量。
 *
 * **确证不了一律返回 undefined，调用方按不处置办**——这是一条权限边界契约，
 * 因此和 freshAdminIds / fetchAdminIds 住在一起，而不是让每个处置点各抄一份：
 * 抄两份就意味着哪天改了兜底语义（比如把 403 当成「不是管理员」）只改到一处，
 * 刷屏禁言与广告处置从此对「谁豁免」各执一词。
 *
 * 为什么不能把失败当成「不是管理员」：`restrictChatMember` 对管理员本来就会被
 * 拒，而 Telegram 回的那句 400 `not enough rights` 与「机器人自己缺权限」完全
 * 一样，照打只会往 `logs/` 塞一条把运维引向权限配置的假线索；把群主按住三分钟
 * 的代价也远大于放过一次刷屏（下一条消息会重新计数）。
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
