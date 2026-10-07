import type { Chat, Message } from "grammy/types";
import { isUserBlocked } from "../infra/blocklist/membership";
import {
  registerBlockedMemberRemover,
  trackBlockedRemoval,
} from "../infra/blocklist/outbox";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import { botCanDeleteMessagesIn } from "../infra/botAdmin";
import { logger } from "../infra/logger";
import { deleteMessageWithOutcome } from "../infra/telegram/actions";
import {
  blockedSenderChatDeleteDeniedChats,
  recentBlockedJoinCounts,
} from "../cache/main/antiRaid/blocklistGuard";
import { verificationKey } from "../libs/verificationKey";
import { BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES } from "../consts/antiRaid/blocklist";
import { JOIN_WINDOW_MS } from "../consts/antiRaid/lockdown";
import { visibleSenderChat } from "../users/visibleSender";
import type { AntiRaidWorkerMessage } from "../types/antiRaid/protocol";
import type { RemoveBlockedMembersParams } from "../types/blocklist";
import type { DeleteMessageOutcome } from "../types/telegram";

/**
 * /block 黑名单在入群守卫主线程侧的那一半：判定与投递。真正的探测/封禁在
 * workers/antiRaid/blocklistEffects.ts 执行。两者为什么按线程分家，见
 * docs/cn/04-invariants.md。
 */

/** 把一批处置投给 Worker 的方式；由 durableDelivery.ts 在模块加载时把 postAntiRaidDurably 传进来。 */
export type DurableAntiRaidPost = (messages: readonly AntiRaidWorkerMessage[]) => Promise<number>;

/**
 * 已拉黑频道身份仍能发出消息时就地在主线程删除，不经 Worker。返回 true 表示消息已被
 * 黑名单门禁接管，调用方无论删除成败都不得再把它送进广告、刷屏或普通消息流水线。
 *
 * 同步返回 `false` 是常态（没有 `sender_chat`，或频道不在黑名单里），只有真的要删消息
 * 时才返回 Promise。本函数挂在每条群消息的 ingress 上（见 AGENTS.md「性能、内存与
 * Bun/JSC JIT」一节）。
 */
export function deleteBlockedSenderChatMessage(message: Message): boolean | Promise<boolean> {
  const senderChat: Chat | undefined = visibleSenderChat(message);
  const chatId: number = message.chat.id;
  if (
    senderChat === undefined ||
    senderChat.id === chatId ||
    !isUserBlocked(senderChat.id)
  ) {
    return false;
  }

  // 权限快照未知时仍发删除请求，只有明确缺权限（=== false）才跳过。
  if (botCanDeleteMessagesIn(chatId) === false) {
    // 按消息量放大的错误只在该群进入缺权限状态时记一次（见 blockedSenderChatDeleteDeniedChats）。
    if (!blockedSenderChatDeleteDeniedChats.has(chatId)) {
      blockedSenderChatDeleteDeniedChats.add(chatId);
      logger.error(
        `Blocked sender chat message ${message.message_id} in chat ${chatId} could not be deleted: ` +
        "the bot is known to lack can_delete_messages; further messages there are not logged."
      );
    }
    return true;
  }
  blockedSenderChatDeleteDeniedChats.delete(chatId);

  return deleteMessageWithOutcome(chatId, message.message_id).then(
    (outcome: DeleteMessageOutcome): boolean => {
      if (outcome === "forbidden" || outcome === "failed") {
        logger.error(
          `Blocked sender chat message ${message.message_id} from ${senderChat.id} in chat ${chatId} ` +
          `could not be deleted (${outcome}).`
        );
      }
      return true;
    }
  );
}

export interface ClaimBlockedJoinerParams {
  chatId: number;
  userId: number;
  /** 本次要投给 Worker 的消息数组；命中时就地追加一条处置。 */
  messages: AntiRaidWorkerMessage[];
  /**
   * 这次处置取代掉的那条 join 消息：处置替代 join，Worker 不为将被踢掉的人开验证窗口。
   * 处置批次若在随后的 durable 对账里被取消（`forgetUserBlocklistRemovals`），
   * 被取代的 join 经 replacedJoins 补回。
   *
   * 入群守卫关着时（`joinGuardEnabled === false`）没有这条 join。
   */
  replacedJoin?: AntiRaidWorkerMessage;
  /** removalId -> 被取代的 join，交给 prepareDurableAntiRaidMessages 兜底。 */
  replacedJoins: Map<number, AntiRaidWorkerMessage>;
  /** 入群服务消息 id（群没隐藏入群消息时才有）；处置落地后由 Worker 删掉。 */
  announcementMessageId?: number;
  /** 入群时刻，交给 Worker 补记反刷群的入群计数。 */
  now?: number;
  /**
   * 本群的入群守卫（`/antiraid`）是否开着。
   *
   * 黑名单秒踢不受这个开关影响；它只决定这次入群是否计进反刷群滑动窗口
   * （见 workers/antiRaid/blocklistEffects.ts 替这条处置补记的 recordJoin）。
   */
  joinGuardEnabled: boolean;
}

/**
 * 淘汰过期的入群记账，并把表压回 BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES 上界。写入侧保证
 * 插入顺序即时间顺序，碰到第一个还在窗口内的条目即停。
 *
 * 本修剪在插入之前运行，一次可淘汰多条，独立于 libs/boundedMap.ts 的 setBoundedMapValue。
 */
function pruneRecentBlockedJoins(now: number): void {
  for (const [key, countedAt] of recentBlockedJoinCounts) {
    if (now - countedAt < JOIN_WINDOW_MS) break;
    recentBlockedJoinCounts.delete(key);
  }
  while (recentBlockedJoinCounts.size > BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES) {
    const oldest: IteratorResult<string> = recentBlockedJoinCounts.keys().next();
    if (oldest.done === true) break;
    recentBlockedJoinCounts.delete(oldest.value);
  }
}

/**
 * 这次入群是否还欠一笔反刷群计数。同一次物理入群会经 chat_member 与
 * new_chat_members 两条路径各来一次，只有第一次带 joinedAt；处置这一路
 * 没有 joinCreatesNewRecord 那道去重闸（见 cache/main/antiRaid/blocklistGuard.ts）。
 *
 * 只判定、不记账：真正消耗这条去重项的时机见 commitBlockedJoinCount。
 */
function owesBlockedJoinCount(key: string, now: number): boolean {
  pruneRecentBlockedJoins(now);
  const countedAt: number | undefined = recentBlockedJoinCounts.get(key);
  return countedAt === undefined || now - countedAt >= JOIN_WINDOW_MS;
}

/**
 * 记下这次物理入群的计数已经交出去了。
 *
 * 与判定分开：只在处置登记进 outbox 之后调用，此后由 Worker 侧的
 * removeBlockedMembers 替这次入群 recordJoin。
 */
function commitBlockedJoinCount(key: string, now: number): void {
  // 先删再插，让这条重新排到队尾，插入顺序才等于时间顺序。
  recentBlockedJoinCounts.delete(key);
  recentBlockedJoinCounts.set(key, now);
}

/**
 * 黑名单成员入群时的秒踢：不开验证窗口、不等超时，改为投一条处置给 Worker。
 * 判定同步完成（名单是主线程状态）。处置与同批 join/left 一起投递。
 *
 * 处置消息带上 joinedAt 与入群公告 id（见 blocklistEffects.ts）：joinedAt 供 Worker 补记
 * 刷群计数，公告 id 供 Worker 清理公告。joinedAt 每次物理入群只带一次，两条投递路径的
 * 去重见 owesBlockedJoinCount / commitBlockedJoinCount；公告 id 照常带。
 * 批次经 trackBlockedRemoval 登记镜像，Worker 崩溃后由主线程重投。
 *
 * 登记失败（outbox 满、id 空间耗尽）就地降级，不抛错：记日志并请求补扫
 * （requestBlocklistResweep），仍返回 true（已按黑名单处置，不再开入群验证窗口）。
 * @returns 已按黑名单处置、调用方应就此打住为 true。
 */
export function claimBlockedJoiner({
  chatId,
  userId,
  messages,
  replacedJoin,
  replacedJoins,
  announcementMessageId,
  now = Date.now(),
  joinGuardEnabled,
}: ClaimBlockedJoinerParams): boolean {
  if (!isUserBlocked(userId)) return false;
  // 判定与记账分两步：trackBlockedRemoval 成功后才消耗去重项；键只算一次，两步共用。
  const dedupKey: string = verificationKey(chatId, userId);
  const owesJoinCount: boolean = joinGuardEnabled && owesBlockedJoinCount(dedupKey, now);
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({
      chatId,
      userIds: [userId],
      probeMembership: false,
      joinedAt: owesJoinCount ? now : undefined,
      announcementMessageId,
    });
  } catch (error: unknown) {
    logger.error(`Failed to queue removal of blocklisted user ${userId} in chat ${chatId}:`, error);
    // 让这个群重新欠一次补扫，由下一次管理员身份观测接手。
    requestBlocklistResweep(chatId);
    return true;
  }
  // 登记成功 = 这笔计数已经随 durable 任务交出去，Worker 侧的 removeBlockedMembers
  // 会替它 recordJoin；此刻才轮到消耗去重项。
  if (owesJoinCount) commitBlockedJoinCount(dedupKey, now);
  messages.push({ type: "removeBlockedMembers", ...params });
  if (replacedJoin !== undefined) replacedJoins.set(params.removalId, replacedJoin);
  logger.log(`Blocklisted user ${userId} rejoined chat ${chatId}; queued removal.`);
  return true;
}

/**
 * 把「清扫某群的黑名单成员」这件事的执行 owner 注册给 infra 侧；
 * infra/blocklist/ 不静态依赖本领域模块（同 infra/chatTeardownRegistry.ts）。
 * @param postDurably 通常是 antiRaid/durableDelivery.ts 的 postAntiRaidDurably。
 */
export function registerBlocklistRemoval(postDurably: DurableAntiRaidPost): void {
  registerBlockedMemberRemover(
    (removals: readonly RemoveBlockedMembersParams[]): Promise<number> =>
      postDurably(removals.map(
        (params: RemoveBlockedMembersParams): AntiRaidWorkerMessage => ({
          type: "removeBlockedMembers",
          ...params,
        })
      ))
  );
}
