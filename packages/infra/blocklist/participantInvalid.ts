/**
 * 黑名单销号识别的主线程 owner。
 *
 * Anti-Raid 处置回执带回两组用户 ID：本批补扫里全部探测与封禁都被 Telegram 以
 * PARTICIPANT_ID_INVALID 拒绝的，以及本批已落定的。本模块按回执到达顺序维护
 * `blocklist_entries.data.participantInvalidCount`：前者每条回执加 1，后者清零；
 * 达到 BLOCKLIST_PARTICIPANT_INVALID_LIMIT 视为已销号，经 unblockUser 移出黑名单
 * 并裁剪待踢批次。补扫的重试、退避与 outbox 结算不在这里改动。
 * @see ../../../docs/cn/04-invariants.md
 */

import { blocklistParticipantInvalidQueue } from "../../cache/main/blocklist";
import {
  BLOCKLIST_PARTICIPANT_INVALID_LIMIT,
  BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS,
} from "../../consts/antiRaid/blocklist";
import {
  cachedBlocklistEntry,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
  queueIdentityPolicyWrite,
  retainParticipantInvalidBlocklistIds,
  writeOutsideBlocklistSweepFlushWindows,
} from "../identityStorage";
import { runBlocklistIdentityMutation } from "../identityPolicy/coordination";
import { logger } from "../logger";
import { unblockUser } from "./membership";
import type { BlockedMembersRemovedEvent } from "../../types/antiRaid/events";
import type { BlocklistEntryData } from "../../types/identityPolicy";

function allIdentityPoliciesCached(ids: readonly number[]): boolean {
  for (const id of ids) {
    if (!isIdentityPolicyCached(id)) return false;
  }
  return true;
}

/**
 * 在同一身份的黑名单处置队列里解除一名已判定销号的用户。缓存里的条目必须仍是
 * 排队时那一个对象，期间被改写、清零、淘汰重读或已被 `/unblock` 删除时放弃。
 */
async function unblockDeletedAccount(
  userId: number,
  expected: Readonly<BlocklistEntryData>
): Promise<void> {
  if (!await prefetchIdentityPolicies([userId])) return;
  await writeOutsideBlocklistSweepFlushWindows((): void => {
    if (!isIdentityPolicyCached(userId) || cachedBlocklistEntry(userId) !== expected) return;
    unblockUser(userId);
    logger.log(
      `Removed blocklisted user ${userId} after ${BLOCKLIST_PARTICIPANT_INVALID_LIMIT} consecutive ` +
      "PARTICIPANT_ID_INVALID sweep results; treating the account as deleted."
    );
  });
}

/** 同步写出一条回执对应的计数变化；调用方已确认相关身份全部在缓存中。 */
function applyParticipantReadability(
  participantInvalidUserIds: readonly number[],
  resettableUserIds: readonly number[]
): void {
  for (const userId of resettableUserIds) {
    const entry: Readonly<BlocklistEntryData> | undefined = cachedBlocklistEntry(userId);
    if (entry?.participantInvalidCount === undefined) continue;
    queueIdentityPolicyWrite("blocklist", userId, {
      blockedAt: entry.blockedAt,
      meta: entry.meta,
    });
  }
  for (const userId of participantInvalidUserIds) {
    const entry: Readonly<BlocklistEntryData> | undefined = cachedBlocklistEntry(userId);
    if (entry === undefined) continue;
    const count: number = (entry.participantInvalidCount ?? 0) + 1;
    if (count < BLOCKLIST_PARTICIPANT_INVALID_LIMIT) {
      queueIdentityPolicyWrite("blocklist", userId, {
        blockedAt: entry.blockedAt,
        meta: entry.meta,
        participantInvalidCount: count,
      });
      continue;
    }
    // 与广告封禁、/unblock 共用逐身份队列，较早的封禁处置先完整结算。
    void runBlocklistIdentityMutation(
      userId,
      (): Promise<void> => unblockDeletedAccount(userId, entry)
    ).catch((error: unknown): void => {
      logger.error(`Failed to remove deleted account ${userId} from the blocklist:`, error);
    });
  }
}

/**
 * 只预热需要改写的身份，并在补扫 flush 窗口之外一次写出整条回执的计数变化。
 * 已落定的 ID 可达一整页，先经不回填 LRU 的读取筛出仍带计数的少数条目；等待
 * 窗口期间有身份被淘汰时整条重来，不做部分写入。
 */
async function settleParticipantReadability(
  event: BlockedMembersRemovedEvent
): Promise<void> {
  const { participantInvalidUserIds, settledUserIds }: BlockedMembersRemovedEvent = event;
  const resettableUserIds: readonly number[] = settledUserIds.length === 0
    ? settledUserIds
    : await retainParticipantInvalidBlocklistIds(settledUserIds);
  if (participantInvalidUserIds.length === 0 && resettableUserIds.length === 0) return;
  const ids: readonly number[] = [...participantInvalidUserIds, ...resettableUserIds];
  for (let attempt: number = 1; attempt <= BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS; attempt++) {
    if (!await prefetchIdentityPolicies(ids)) return;
    const written: boolean = await writeOutsideBlocklistSweepFlushWindows((): boolean => {
      if (!allIdentityPoliciesCached(ids)) return false;
      applyParticipantReadability(participantInvalidUserIds, resettableUserIds);
      return true;
    });
    if (written) return;
  }
  logger.error(
    `Skipped blocklist PARTICIPANT_ID_INVALID counts for removal ${event.removalId} in chat ` +
    `${event.chatId}: identities left the policy cache before ${BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS} write attempts.`
  );
}

/**
 * 接收一条处置回执的销号观测，排进主线程串行尾链；没有观测时不排队。
 * 调用方在 settleBlockedRemoval 之后同步调用。
 */
export function recordBlocklistParticipantReadability(
  event: BlockedMembersRemovedEvent
): void {
  if (event.participantInvalidUserIds.length === 0 && event.settledUserIds.length === 0) return;
  const step: Promise<void> = blocklistParticipantInvalidQueue.current.then(
    (): Promise<void> => settleParticipantReadability(event)
  );
  blocklistParticipantInvalidQueue.current = step.catch((error: unknown): void => {
    logger.error(
      `Failed to update blocklist PARTICIPANT_ID_INVALID counts for removal ${event.removalId} ` +
      `in chat ${event.chatId}:`,
      error
    );
  });
}
