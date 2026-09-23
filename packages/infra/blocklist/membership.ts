/**
 * /block 黑名单的主线程同步名单。
 *
 * 判定必须是同步的：入群更新到达时要立刻决定踢不踢，不能等跨线程往返。
 * 每条 update 进入业务链前批量预热 LRU；写保持「先发布内存最终值、后投递
 * Disk I/O Worker」并保留到事务 ACK。durable removal outbox 由同目录 outbox.ts
 * 持有，本模块只在 /block disable 时请求它裁剪相关任务。
 * @see ../../../docs/cn/04-invariants.md
 */

import { formatTokyoTime } from "../../libs/time";
import { MANAGED_CHAT_BATCH_CONCURRENCY } from "../../consts/commands";
import { runBoundedSettledBatch } from "../../libs/boundedSettledBatch";
import type {
  BoundedBatchExecution,
  BoundedBatchResult,
} from "../../libs/boundedSettledBatch";
import { getChatStateCache } from "../storage/stateStore";
import { flushDiskIODomainOutcome } from "../diskIO";
import { logger } from "../logger";
import { forgetUserBlocklistRemovals } from "./outbox";
import type { DomainFlushOutcome } from "../../types/diskIO/replies";
import {
  cachedBlocklistEntry,
  prefetchIdentityPolicies,
  queueBlocklistDeletion,
  queueIdentityPolicyWrite,
  requeueUnacknowledgedIdentityWrite,
} from "../identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../consts/paths";
import { clearTemporaryAdBypassActivity } from
  "../identityPolicy/temporaryAdBypass";
import type { TelegramIdentityMetadata } from "../../types/identityPolicy";

/**
 * 连坐封禁与跨群解封共用的目标群清单：机器人已确证是管理员的全部托管群，发起群排在
 * 最前；发起群不是管理员时不进入清单。`/block enable` 与 `/block disable` 必须使用
 * 同一份清单。`runManagedChatBatch` 按输入顺序取任务、按输入顺序结算，计数与并发度无关。
 * @param isAdminHere 发起群的管理员位，由调用方现查（`botChatPermissionsIn`）；其余群
 *   读已落盘的权限快照。
 */
export function managedAdminChatIds(chatId: number, isAdminHere: boolean): number[] {
  const targetChatIds: number[] = isAdminHere ? [chatId] : [];
  for (const [adminChatId, chatState] of getChatStateCache()) {
    if (chatState.botPermissions?.isAdministrator === true && adminChatId !== chatId) {
      targetChatIds.push(adminChatId);
    }
  }
  return targetChatIds;
}

/** 单群处置的结算：`value` 已把意外 rejection 折算成调用方给的失败取值。 */
export interface ManagedChatOutcome<T> {
  readonly chatId: number;
  readonly value: T;
}

/** runManagedChatBatch 的入参。 */
export interface RunManagedChatBatchParams<T> {
  /** 目标群清单，必须来自 managedAdminChatIds（发起群排最前）。 */
  readonly chatIds: readonly number[];
  /** 意外 rejection 日志里的英文动作名，如 `ban blocked identity 7`。 */
  readonly action: string;
  /** 单群处置；常规 API 错误已由适配层归一化，这里只产出业务结果。 */
  readonly execute: (chatId: number) => Promise<T>;
  /** 单群意外 rejection 折算成的结果；调用方据此把这个群计进失败一侧。 */
  readonly onUnexpectedFailure: T;
}

/**
 * 对 `managedAdminChatIds` 的清单做有界并发处置（并发度 `MANAGED_CHAT_BATCH_CONCURRENCY`）。
 * 结果数组与输入同序结算，与并发度无关；单群失败（意外异常或调用方判定的业务失败）
 * 不中断其余群的处置。
 */
export async function runManagedChatBatch<T>({
  chatIds,
  action,
  execute,
  onUnexpectedFailure,
}: RunManagedChatBatchParams<T>): Promise<readonly ManagedChatOutcome<T>[]> {
  const settlements: BoundedBatchResult<number, T>[] =
    await runBoundedSettledBatch<number, T>({
      items: chatIds,
      maxConcurrent: MANAGED_CHAT_BATCH_CONCURRENCY,
      execute: ({ item: targetChatId }: BoundedBatchExecution<number>): Promise<T> =>
        execute(targetChatId),
    });
  const outcomes: ManagedChatOutcome<T>[] = [];
  for (const settlement of settlements) {
    if (settlement.status === "rejected") {
      // 常规 API 错误已在适配层归一化成业务结果；这里只处理意外 rejection。
      logger.error(
        `Unexpected error while running ${action} in chat ${settlement.item} ` +
        `(batch index ${settlement.index}, attempt ${settlement.attempt}):`,
        settlement.reason
      );
    }
    outcomes.push({
      chatId: settlement.item,
      value: settlement.status === "fulfilled" ? settlement.value : onUnexpectedFailure,
    });
  }
  return outcomes;
}

/**
 * 该用户/频道身份是否在黑名单里。入群秒踢与 `/block` 去重都走这一条，也是全项目
 * 唯一的黑名单成员判定入口。
 * 冷缺失按 fail-closed 解释为「不在名单」，预热由 update 前置中间件负责。
 */
export function isUserBlocked(userId: number): boolean {
  return cachedBlocklistEntry(userId) !== undefined;
}

/**
 * 启动阶段的致命互斥校验：配置里的超级管理员不得同时存在于 blocklist_entries。
 *
 * `isWhitelisted` 对超管短路 true，`isUserBlocked` 不短路（见 identityPolicy/whitelist.ts
 * 与本文件上方 `isUserBlocked`）。两者同时成立会导致该身份被 `sweepManagedBlocklistChats`
 * 反复清出并被 `claimBlockedJoiner` 再次拉黑。校验失败时以非零码退出，不继续启动。
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
 * 拉黑一个 id：先写 LRU 再投递落盘消息，写入顺序约束见 docs/cn/04-invariants.md。
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
  if (!clearTemporaryAdBypassActivity(userId)) {
    throw new Error(
      `Temporary ad bypass reset for identity ${userId} was rejected by the persistence Worker.`
    );
  }
  queueIdentityPolicyWrite("blocklist", userId, { blockedAt, meta });
  return true;
}

/**
 * 等待本次拉黑落盘的统一 flush 回执。`queueIdentityPolicyWrite` 只保证消息进入
 * Worker 信箱；写盘失败时 Worker 内部只有 console.error，不进入 logs/。
 * @returns 已 durable 为 true；false 表示这条记录目前只活在内存里，重启就没了。
 */
export async function confirmBlocklistPersisted(): Promise<boolean> {
  // flushDiskIODomainOutcome 按各领域合取判定，这里只看 "blocklist" 领域的结果。
  const outcome: DomainFlushOutcome = await flushDiskIODomainOutcome("blocklist");
  if (outcome.result === "flushed") return true;
  // 领域名取自本次 flush 的回执；超时或崩溃时 outcome.failedDomains 为 undefined。
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
 * 把 tombstone 投给 Disk I/O Worker；顺序是裁剪快照先于 tombstone。Worker 按
 * 到达顺序处理，已提交的数据库不会留下引用已删条目的冻结批次。已经投进业务
 * Worker 的批次无法撤回，管理员仍可能需要执行一次 Telegram 解封。
 * @returns 本次真的移除了记录为 true；本来就不在名单里为 false。
 */
export function unblockUser(userId: number): boolean {
  if (cachedBlocklistEntry(userId) === undefined) return false;
  queueBlocklistDeletion(userId, (): void => forgetUserBlocklistRemovals(userId));
  return true;
}
