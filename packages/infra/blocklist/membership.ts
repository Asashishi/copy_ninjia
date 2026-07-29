/**
 * /block 黑名单的主线程同步名单与命令侧确证缓存。
 *
 * 判定必须是同步的：入群更新到达时要立刻决定踢不踢，不能等跨线程往返。
 * 磁盘只在启动时读一次，此后 blockedUserIds 是事实源，写保持「先内存、后
 * Disk I/O Worker」的单向同步。durable removal outbox 由同目录 outbox.ts
 * 持有，本模块只在 /unblock 时请求它裁剪相关任务。
 * @see ../../../docs/04-invariants.md
 */

import {
  blockedUserIds,
  confirmedKickedUserIdsByChat,
  confirmedKickedUsersDay,
  sessionBlockedAt,
  sessionUnblockedIds,
} from "../../cache/blocklist";
import { formatTokyoTime, getTokyoDateKey } from "../../libs/time";
import { flushDiskIODomain, lastFailedDiskIODomains, postDiskIO } from "../diskIO";
import { logger } from "../logger";
import { forgetUserBlocklistRemovals } from "./outbox";
import type {
  BlockUserDiskMessage,
  DiskIODomain,
  UnblockUserDiskMessage,
} from "../../types/diskIO";
import type { FlushResult } from "../../types/lifecycle";

/** 跨东京自然日时整表轮换；懒清理避免为这份命令侧缓存单独常驻 timer。 */
function rotateConfirmedKickedUsers(day: string): void {
  if (confirmedKickedUsersDay.current === day) return;
  confirmedKickedUserIdsByChat.clear();
  confirmedKickedUsersDay.current = day;
}

/**
 * 这个用户今天是否已经由 `/block` 在该群确证踢出。
 * 可选 day 只供确定性测试；生产调用统一使用当前东京日期。
 */
export function wasUserConfirmedKickedInChat(
  chatId: number,
  userId: number,
  day: string = getTokyoDateKey()
): boolean {
  rotateConfirmedKickedUsers(day);
  return confirmedKickedUserIdsByChat.get(chatId)?.has(userId) === true;
}

/** 记录一次“查到在群且封禁成功”的 `/block` 结局。 */
export function recordUserConfirmedKickedInChat(
  chatId: number,
  userId: number,
  day: string = getTokyoDateKey()
): void {
  rotateConfirmedKickedUsers(day);
  let userIds: Set<number> | undefined = confirmedKickedUserIdsByChat.get(chatId);
  if (userIds === undefined) {
    userIds = new Set();
    confirmedKickedUserIdsByChat.set(chatId, userIds);
  }
  userIds.add(userId);
}

/**
 * `/unblock` 后提前失效这个用户的所有群缓存。即使默认模式不解除 Telegram
 * 封禁，也宁可让下一次 `/block` 重新确认，避免 `all` 解封后同日重拉黑时误跳过。
 */
export function forgetUserConfirmedKicked(userId: number): void {
  // `/unblock` 也是这份 cache 的一次访问；跨日后先整表轮换，不能为了删一个
  // 当前用户而继续扫描、保留上一东京自然日的群集合。
  rotateConfirmedKickedUsers(getTokyoDateKey());
  for (const [chatId, userIds] of confirmedKickedUserIdsByChat) {
    userIds.delete(userId);
    if (userIds.size === 0) confirmedKickedUserIdsByChat.delete(chatId);
  }
}

/** 该用户/频道身份是否在黑名单里。入群秒踢与 /block 去重都走这一条。 */
export function isUserBlocked(userId: number): boolean {
  return blockedUserIds.has(userId);
}

/**
 * 拉黑一个 id：先写内存 Map，再投递落盘消息——顺序不能反。反过来的话，两步
 * 之间到达的入群更新会查到一个还没记上的黑名单，那个人就这么进来了。
 * @returns 本次真的新增了记录为 true；已经在名单里为 false（不重复落盘）。
 */
export function blockUser(userId: number): boolean {
  if (blockedUserIds.has(userId)) return false;
  const blockedAt: string = formatTokyoTime(Date.now());
  blockedUserIds.set(userId, { isBlocked: true, blockedAt });
  sessionBlockedAt.set(userId, blockedAt);
  // 本进程内先解除又重新拉黑：两张 session 表互斥，否则 Worker 重建后的
  // 重放顺序会决定这个人到底在不在名单里。
  sessionUnblockedIds.delete(userId);
  // 投递失败（落盘 Worker 已彻底不可用）不回滚内存：本进程内这个人照样被拦住，
  // 回滚只会让他立刻能进群。但重启后这条记录就没了，必须留下可排查的记录。
  if (!postDiskIO({ type: "blockUser", userId, blockedAt } satisfies BlockUserDiskMessage)) {
    logger.error(`Failed to queue blocklist entry for user ${userId}; it is in memory only and will be lost on restart.`);
  }
  return true;
}

/**
 * 等这一次拉黑真正落盘。postDiskIO 只保证消息进了 Worker 的信箱；写盘失败
 * （memory/ 只读、磁盘满、部署后属主不对）在 Worker 内部只有 console.error，
 * 而按本仓库的设计那条日志不会进 logs/，管理员那边看到的仍是「永久拉黑成功」。
 * /block 低频且关键，值得为它等一次统一 flush 回执再措辞。
 * @returns 已 durable 为 true；false 表示这条记录目前只活在内存里，重启就没了。
 */
export async function confirmBlocklistPersisted(): Promise<boolean> {
  // 只看黑名单这一个领域：统一 flush 是七个领域的合取，某群 AI 记忆快照写不
  // 进去也会让这里报「小本本没能写进硬盘」，把运维引向一个其实没坏的文件。
  const result: FlushResult = await flushDiskIODomain("blocklist");
  if (result === "flushed") return true;
  const failedDomains: readonly DiskIODomain[] = lastFailedDiskIODomains();
  // 带上真正坏掉的领域名：Worker 侧的写盘错误按设计只有 console.error，
  // 不在这里点名就没有任何一条进得了 logs/。
  const domainNote: string = failedDomains.length > 0 ? ` failed domains: ${failedDomains.join(", ")}.` : "";
  logger.error(`Blocklist entry was not persisted to disk: flush ${result}.${domainNote}`);
  return false;
}

/**
 * 重复 /block 时的落盘补投：这个 id 已经在内存 Map 里，但如果它是本进程新增
 * 的（在 sessionBlockedAt 里），上一次的落盘可能压根没成功。管理员修好磁盘
 * 再跑一次 /block 是最自然的重试动作，不能因为「Map 里已经有了」就静默跳过。
 * @returns 本次补投了落盘消息、调用方应重新等一次确认为 true。
 */
export function ensureBlocklistEntryQueued(userId: number): boolean {
  const blockedAt: string | undefined = sessionBlockedAt.get(userId);
  // 不在 sessionBlockedAt 里 = 启动时从文件 hydrate 进来的，本来就在磁盘上。
  if (blockedAt === undefined) return false;
  if (!postDiskIO({ type: "blockUser", userId, blockedAt } satisfies BlockUserDiskMessage)) {
    logger.error(`Failed to re-queue blocklist entry for user ${userId}; it is in memory only and will be lost on restart.`);
  }
  return true;
}

/**
 * 解除拉黑：先从内存 Map 删掉，再让 outbox owner 裁剪含该 id 的在途批次，最后
 * 把删除后的完整 Map 交给 Disk I/O Worker 重写。已经投进业务 Worker 的批次
 * 无法撤回，管理员仍可能需要执行一次 Telegram 解封。
 * @returns 本次真的移除了记录为 true；本来就不在名单里为 false。
 */
export function unblockUser(userId: number): boolean {
  if (!blockedUserIds.delete(userId)) return false;
  sessionBlockedAt.delete(userId);
  sessionUnblockedIds.add(userId);
  forgetUserBlocklistRemovals(userId);
  if (!postDiskIO({
    type: "unblockUser",
    userId,
    blocked: [...blockedUserIds],
  } satisfies UnblockUserDiskMessage)) {
    logger.error(`Failed to queue blocklist removal for user ${userId}; the entry is still on disk and will come back on restart.`);
  }
  return true;
}
