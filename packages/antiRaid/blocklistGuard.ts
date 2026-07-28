import {
  isUserBlocked,
  registerBlockedMemberRemover,
  requestBlocklistResweep,
  trackBlockedRemoval,
} from "../infra/blocklist";
import { logger } from "../infra/logger";
import { recentBlockedJoinCounts } from "../cache/antiRaid/blocklistGuard";
import { verificationKey } from "../libs/verificationKey";
import { BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES } from "../consts/antiRaid/blocklist";
import { JOIN_WINDOW_MS } from "../consts/antiRaid/lockdown";
import type { AntiRaidWorkerMessage } from "../types/antiRaid";
import type { RemoveBlockedMembersParams } from "../types/blocklist";

/**
 * /block 黑名单在入群守卫主线程侧的那一半：判定与投递。真正的探测/封禁在
 * workers/antiRaid/blocklistEffects.ts 执行。两者为什么按线程分家，见
 * docs/04-invariants.md。
 */

/** 把一批处置投给 Worker 的方式；由 index.ts 在注册时把 postAntiRaidDurably 传进来。 */
export type DurableAntiRaidPost = (messages: readonly AntiRaidWorkerMessage[]) => Promise<void>;

export interface ClaimBlockedJoinerParams {
  chatId: number;
  userId: number;
  /** 本次要投给 Worker 的消息数组；命中时就地追加一条处置。 */
  messages: AntiRaidWorkerMessage[];
  /** 入群服务消息 id（群没隐藏入群消息时才有）；处置落地后由 Worker 删掉。 */
  announcementMessageId?: number;
  /** 入群时刻，交给 Worker 补记反刷群的入群计数。 */
  now?: number;
}

/**
 * 淘汰过期的入群记账，并兜住表的上界。写入侧保证插入顺序即时间顺序，因此
 * 碰到第一个还在窗口内的条目就可以停。
 *
 * 这是一次「先按时间清、再把表压回上界」的独立修剪，与 libs/boundedMap.ts 的
 * setBoundedMapValue（写入某个键时顺带淘汰一项）不是同一件事：它跑在插入之前、
 * 不知道要写哪个键，也需要一次能压掉多条。
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
 * new_chat_members 两条路径各来一次，只有第一次该带 joinedAt——处置这一路
 * 没有 joinCreatesNewRecord 那道去重闸，两条都带就是记两次
 * （见 cache/antiRaid/blocklistGuard.ts）。
 */
function claimBlockedJoinCount(chatId: number, userId: number, now: number): boolean {
  pruneRecentBlockedJoins(now);
  const key: string = verificationKey(chatId, userId);
  const countedAt: number | undefined = recentBlockedJoinCounts.get(key);
  if (countedAt !== undefined && now - countedAt < JOIN_WINDOW_MS) return false;
  // 先删再插，让这条重新排到队尾，插入顺序才等于时间顺序。
  recentBlockedJoinCounts.delete(key);
  recentBlockedJoinCounts.set(key, now);
  return true;
}

/**
 * 黑名单成员入群时的秒踢：不开验证窗口、不等超时，改为投一条处置给 Worker。
 * 判定同步完成——入群更新到达时就要决定投不投 join，而名单是主线程状态。
 * 处置与同批 join/left 一起投递，因此 update 交接前 Worker 已经收下它。
 *
 * 处置消息带上 joinedAt 与入群公告 id：不投 join 就没人替这条入群记刷群计数、
 * 也没人清理那条公告，两件事都要在这里补给 Worker（见 blocklistEffects.ts）。
 * 但 joinedAt 每次物理入群只带一次——两条投递路径的去重见
 * claimBlockedJoinCount；公告 id 照常带，删公告本来就是幂等的。
 * 批次经 trackBlockedRemoval 登记镜像，Worker 崩溃后由主线程重投。
 *
 * 登记失败（outbox 满、id 空间耗尽）必须就地降级，**不能让异常逃出去**：本函数
 * 跑在更新中间件里，抛出去会让整批 update 失败、扣住 offset、进程非零退出，
 * systemd 重启后 Telegram 重投同一条 update 再抛一次——那是一个只能靠手改
 * memory/blocklist/removals.json 解开的重启循环，而 outbox 满本身通常正是一批
 * 永远封不掉的处置堆出来的。降级后这个人暂时留在群里，但仍算「已按黑名单
 * 处置」：名单判定没变，不该反过来给他开一个入群验证窗口。
 * @returns 已按黑名单处置、调用方应就此打住为 true。
 */
export function claimBlockedJoiner({
  chatId,
  userId,
  messages,
  announcementMessageId,
  now = Date.now(),
}: ClaimBlockedJoinerParams): boolean {
  if (!isUserBlocked(userId)) return false;
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({
      chatId,
      userIds: [userId],
      probeMembership: false,
      joinedAt: claimBlockedJoinCount(chatId, userId, now) ? now : undefined,
      announcementMessageId,
    });
  } catch (error: unknown) {
    logger.error(`Failed to queue removal of blocklisted user ${userId} in chat ${chatId}:`, error);
    // 让这个群重新欠一次补扫：outbox 腾出位置后，下一次管理员身份观测会把
    // 这个人一并清出去。
    requestBlocklistResweep(chatId);
    return true;
  }
  messages.push({ type: "removeBlockedMembers", ...params });
  logger.log(`Blocklisted user ${userId} rejoined chat ${chatId}; queued removal.`);
  return true;
}

/**
 * 把「清扫某群的黑名单成员」这件事的执行 owner 注册给 infra 侧。反向注册是为了
 * 让 infra/blocklist.ts 不静态依赖本领域模块（同 infra/chatTeardown.ts 的做法）。
 * @param postDurably 通常是 index.ts 的 postAntiRaidDurably。
 */
export function registerBlocklistRemoval(postDurably: DurableAntiRaidPost): void {
  registerBlockedMemberRemover(
    (removals: readonly RemoveBlockedMembersParams[]): Promise<void> =>
      postDurably(removals.map(
        (params: RemoveBlockedMembersParams): AntiRaidWorkerMessage => ({
          type: "removeBlockedMembers",
          ...params,
        })
      ))
  );
}
