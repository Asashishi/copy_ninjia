/**
 * /block 黑名单的主线程同步名单。
 *
 * 判定是同步的，入群更新到达时直接读 LRU，不等跨线程往返。
 * 每条 update 进入业务链前批量预热 LRU；写先发布内存最终值、后投递
 * Disk I/O Worker，并保留到事务 ACK。durable removal outbox 由同目录 outbox.ts
 * 持有，本模块只在 unblockUser 时请求它裁剪相关任务。另含 `/block enable`、
 * `/block disable` 与广告处置共用的托管群清单 `managedAdminChatIds`，以及有界并发处置
 * `runManagedChatBatch`。
 * @see ../../../docs/cn/04-invariants.md
 */

import { formatLocalTime } from "../../libs/time";
import { MANAGED_CHAT_BATCH_CONCURRENCY } from "../../consts/commands";
import { runBoundedSettledBatch } from "../../libs/boundedSettledBatch";
import type {
  BoundedBatchExecution,
  BoundedBatchResult,
} from "../../libs/boundedSettledBatch";
import { getChatStateCache } from "../storage/stateStore";
import { isManagedAdminChat } from "./sweepEligibility";
import { logger } from "../logger";
import { throwIfUpdateAborted } from "../updateContext";
import { forgetUserBlocklistRemovals } from "./outbox";
import {
  cachedBlocklistEntry,
  confirmIdentityPolicyPersisted,
  prefetchIdentityPolicies,
  queueBlocklistDeletion,
  queueIdentityPolicyWrite,
} from "../identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../consts/paths";
import { clearTemporaryAdBypassActivityOrThrow } from
  "../identityPolicy/temporaryAdBypass";
import type { TelegramIdentityMetadata } from "../../types/identityPolicy";

/**
 * 连坐封禁、跨群解封与广告处置共用的目标群清单：发起群排在最前，其余为全部受管群——
 * 已 `/init enable` 且已确证机器人是管理员（口径同 sweepEligibility.ts 的
 * isManagedAdminChat）；发起群不是管理员时不进入清单。`/block enable`、`/block disable`
 * 与广告处置必须使用同一份清单。`runManagedChatBatch` 按输入顺序取任务、按输入顺序
 * 结算，计数与并发度无关。
 * @param isAdminHere 发起群是否纳入：命令路径由调用方现查管理员位（`botChatPermissionsIn`，
 *   命令能到达即已过 `/init` 网关）；广告处置按发起群的受管快照判定。其余群读已落盘的状态快照。
 */
export function managedAdminChatIds(chatId: number, isAdminHere: boolean): number[] {
  const targetChatIds: number[] = isAdminHere ? [chatId] : [];
  for (const [adminChatId, chatState] of getChatStateCache()) {
    if (adminChatId !== chatId && isManagedAdminChat(chatState)) targetChatIds.push(adminChatId);
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
 * 不中断其余群的处置。update 已取消时等全部群结算后上抛取消，不逐群记意外错误。
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
  // update 被取消时各群的 rejection 都是取消本身：先上抛，不逐群记意外错误。
  throwIfUpdateAborted();
  const outcomes: ManagedChatOutcome<T>[] = [];
  for (const settlement of settlements) {
    if (settlement.status === "rejected") {
      // 常规 API 错误已在适配层归一化成业务结果；这里只处理意外 rejection。
      logger.error(
        `Unexpected error while running ${action} in chat ${settlement.item} ` +
        `(batch index ${settlement.index}):`,
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
 * 与本文件上方 `isUserBlocked`）。校验失败时抛错，启动以非零码退出。
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
  meta: Readonly<TelegramIdentityMetadata>
): boolean {
  if (isUserBlocked(userId)) return false;
  const blockedAt: string = formatLocalTime(Date.now());
  clearTemporaryAdBypassActivityOrThrow(userId);
  queueIdentityPolicyWrite("blocklist", userId, { blockedAt, meta });
  return true;
}

/**
 * 等待该 id 当前未 ACK 的黑名单最终值（拉黑记录或解除 tombstone）通过 SQLite 事务并收到
 * 精确 revision ACK，口径同 identityStorage/write.ts 的 confirmIdentityPolicyPersisted；
 * 没有未 ACK 最终值时立即返回 true。retryUnacknowledged 为 true 时先把未 ACK 的同一最终值
 * 补投给当前 Worker（不创建新 revision）。
 * @returns 已 durable 为 true；false 表示这条最终值目前只在内存中，已记一行错误日志。
 */
export async function confirmBlocklistPersisted(
  userId: number,
  retryUnacknowledged: boolean
): Promise<boolean> {
  try {
    await confirmIdentityPolicyPersisted("blocklist", userId, retryUnacknowledged);
    return true;
  } catch (error: unknown) {
    logger.error("Blocklist entry was not persisted to disk:", error);
    return false;
  }
}

/**
 * 解除拉黑：先发布 LRU 负缓存，再让 outbox owner 裁剪含该 id 的在途批次，最后
 * 把 tombstone 投给 Disk I/O Worker；裁剪快照先于 tombstone，Worker 按到达顺序
 * 处理。已经投进业务 Worker 的批次不可撤回。
 * @returns 本次真的移除了记录为 true；本来就不在名单里为 false。
 */
export function unblockUser(userId: number): boolean {
  if (cachedBlocklistEntry(userId) === undefined) return false;
  queueBlocklistDeletion(userId, (): void => forgetUserBlocklistRemovals(userId));
  return true;
}
