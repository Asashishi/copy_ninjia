/**
 * /block 黑名单的主线程同步名单。
 *
 * 判定必须是同步的：入群更新到达时要立刻决定踢不踢，不能等跨线程往返。
 * 每条 update 进入业务链前批量预热 LRU；写保持「先发布内存最终值、后投递
 * Disk I/O Worker」并保留到事务 ACK。durable removal outbox 由同目录 outbox.ts
 * 持有，本模块只在 /unblock 时请求它裁剪相关任务。
 * @see ../../../docs/cn/04-invariants.md
 */

import { formatTokyoTime } from "../../libs/time";
import { flushDiskIODomainOutcome } from "../diskIO";
import { logger } from "../logger";
import { forgetUserBlocklistRemovals } from "./outbox";
import type { DomainFlushOutcome } from "../../types/diskIO";
import {
  cachedBlocklistEntry,
  prefetchIdentityPolicies,
  queueIdentityPolicyWrite,
  requeueUnacknowledgedIdentityWrite,
} from "../identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../consts/paths";
import type { TelegramIdentityMetadata } from "../../types/identityPolicy";

/**
 * 该用户/频道身份是否在黑名单里。入群秒踢与 `/block` 去重都走这一条，也是全项目
 * 唯一的黑名单成员判定入口——同一判定曾经有 isBlockedIdentity / isUserBlocked
 * 两个公开名互为一行转发，语义一旦要改（比如给超管加短路）只会落到其中一个。
 * 冷缺失按 fail-closed 解释为「不在名单」，预热由 update 前置中间件负责。
 */
export function isUserBlocked(userId: number): boolean {
  return cachedBlocklistEntry(userId) !== undefined;
}

/**
 * 启动阶段的致命互斥校验：配置里的超级管理员不得同时存在于 blocklist_entries。
 *
 * `isWhitelisted` 对超管短路 true，`isUserBlocked` 不短路（见 infra/identityPolicy/whitelist.ts
 * 与本文件上方）。两者同时成立时，`sweepManagedBlocklistChats` 会给每个托管群排一次
 * 探测扫描，把这位新超管从所有群里清出去，重进又被 claimBlockedJoiner 再踢一次；
 * 而他连撤销的机会都没有——私聊网关只放行 `/send`，群里的消息在落地前就被处置。
 * SQLite 迁移把这条互斥断言连同 `packages/config/blocklist.ts` 一起删掉了，只在
 * 一次性迁移脚本里留了个影子。按 AGENTS.md「不为用户行为兜底」在这里补回：
 * 启动阶段以非零码退出，不猜测部署方意图继续运行。
 */
export async function assertSuperAdminNotBlocked(
  superAdminUserId: number
): Promise<void> {
  if (!await prefetchIdentityPolicies([superAdminUserId])) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}: blocklist_entries could not be read; ` +
      "refusing to start without confirming the super admin is absent from it."
    );
  }
  if (cachedBlocklistEntry(superAdminUserId) === undefined) return;
  throw new Error(
    `${IDENTITY_DATABASE_PATH}: blocklist_entries must not contain the configured ` +
    `super admin identity ${superAdminUserId}; expected the two sets to stay disjoint.`
  );
}

/**
 * 拉黑一个 id：先写 LRU，再投递落盘消息——顺序不能反。反过来的话，两步
 * 之间到达的入群更新会查到一个还没记上的黑名单，那个人就这么进来了。
 * @returns 本次真的新增了记录为 true；已经在名单里为 false（不重复落盘）。
 */
export function blockUser(
  userId: number,
  meta: Readonly<TelegramIdentityMetadata> = {
    firstName: "",
    lastName: "",
    username: "",
  }
): boolean {
  if (isUserBlocked(userId)) return false;
  const blockedAt: string = formatTokyoTime(Date.now());
  queueIdentityPolicyWrite("blocklist", userId, { blockedAt, meta });
  return true;
}

/**
 * 等这一次拉黑真正落盘。postDiskIO 只保证消息进了 Worker 的信箱；写盘失败
 * （database/ 只读、磁盘满、部署后属主不对）在 Worker 内部只有 console.error，
 * 而按本仓库的设计那条日志不会进 logs/，管理员那边看到的仍是「永久拉黑成功」。
 * /block 低频且关键，值得为它等一次统一 flush 回执再措辞。
 * @returns 已 durable 为 true；false 表示这条记录目前只活在内存里，重启就没了。
 */
export async function confirmBlocklistPersisted(): Promise<boolean> {
  // 只看黑名单这一个领域：统一 flush 是九个领域的合取，某群 AI 记忆快照写不
  // 进去也会让这里报「小本本没能写进硬盘」，把运维引向一个其实没坏的文件。
  const outcome: DomainFlushOutcome = await flushDiskIODomainOutcome("blocklist");
  if (outcome.result === "flushed") return true;
  // 领域名必须取自**这一次** flush 的回执：Worker 侧的写盘错误按设计只有
  // console.error，不在这里点名就没有任何一条进得了 logs/，而点错名比不点名
  // 更糟——超时/崩溃这两种没有回执的情况下，进程级的「最后一次失败领域」是
  // 上一次无关 flush 留下的，会把运维支去修一个跟本次失败毫无关系的文件。
  const domainNote: string = outcome.failedDomains === undefined
    ? " no reply arrived for this flush; the persistence Worker timed out or crashed mid-flush."
    : ` failed domains: ${outcome.failedDomains.join(", ")}.`;
  logger.error(`Blocklist entry was not persisted to disk: flush ${outcome.result}.${domainNote}`);
  return false;
}

/**
 * 重复 /block 时的落盘补投：若最新 revision 尚未收到事务 ACK，管理员再次执行
 * 命令会把同一最终值重投给当前 Worker，而不创建新的 revision。
 * @returns 本次补投了落盘消息、调用方应重新等一次确认为 true。
 */
export function ensureBlocklistEntryQueued(userId: number): boolean {
  return requeueUnacknowledgedIdentityWrite("blocklist", userId);
}

/**
 * 解除拉黑：先发布 LRU 负缓存，再让 outbox owner 裁剪含该 id 的在途批次，最后
 * 把 tombstone 投给 Disk I/O Worker。已经投进业务 Worker 的批次
 * 无法撤回，管理员仍可能需要执行一次 Telegram 解封。
 * @returns 本次真的移除了记录为 true；本来就不在名单里为 false。
 */
export function unblockUser(userId: number): boolean {
  if (cachedBlocklistEntry(userId) === undefined) return false;
  queueIdentityPolicyWrite("blocklist", userId, null);
  forgetUserBlocklistRemovals(userId);
  return true;
}
