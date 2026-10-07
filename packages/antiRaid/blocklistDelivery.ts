import {
  getPendingBlockedRemovalParams,
  persistPendingBlockedRemovals,
} from "../infra/blocklist/outbox";
import { requestBlocklistResweep } from "../infra/blocklist/sweep";
import {
  retainCurrentlyBlockedIdentityIds,
} from "../infra/identityStorage";
import { logger } from "../infra/logger";
import { BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS } from "../consts/antiRaid/blocklist";
import type { AntiRaidWorkerMessage } from "../types/antiRaid/protocol";
import type { RemoveBlockedMembersParams } from "../types/blocklist";

/** 两个有界补扫页是否包含同一组稳定顺序的主键。 */
function blocklistPagesMatch(
  left: readonly number[],
  right: readonly number[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index: number = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * 以主线程当前权威镜像重建处置消息；已经取消的批次从待投数组摘掉。
 *
 * 摘掉时若这批处置取代过一条 join（黑名单成员入群那一路：Worker 不为将被踢掉的人开
 * 验证窗口，那条 join 没入过数组），把被取代的 join 补回。
 * @param replacedJoins removalId -> 被它取代的 join，由 claimBlockedJoiner 登记。
 */
async function reconcileBlockedRemovalMessages(
  messages: readonly AntiRaidWorkerMessage[],
  replacedJoins: ReadonlyMap<number, AntiRaidWorkerMessage>,
  filterProbeIds: boolean
): Promise<AntiRaidWorkerMessage[]> {
  const reconciled: AntiRaidWorkerMessage[] = [];
  let previousProbeIds: readonly number[] | null = null;
  let previousRetainedIds: readonly number[] = [];
  for (const message of messages) {
    if (message.type !== "removeBlockedMembers") {
      reconciled.push(message);
      continue;
    }
    let blockedIds: readonly number[] = message.userIds;
    if (message.probeMembership && filterProbeIds) {
      if (
        previousProbeIds !== null &&
        blocklistPagesMatch(previousProbeIds, message.userIds)
      ) {
        blockedIds = previousRetainedIds;
      } else {
        blockedIds = await retainCurrentlyBlockedIdentityIds(message.userIds);
        previousProbeIds = message.userIds;
        previousRetainedIds = blockedIds;
      }
    }
    const params: RemoveBlockedMembersParams | undefined =
      getPendingBlockedRemovalParams(message.removalId, blockedIds);
    if (params !== undefined) {
      reconciled.push({ type: "removeBlockedMembers", ...params });
      continue;
    }
    const replacedJoin: AntiRaidWorkerMessage | undefined = replacedJoins.get(message.removalId);
    if (replacedJoin !== undefined) reconciled.push(replacedJoin);
  }
  return reconciled;
}

/** 两份处置消息是否描述同一批权威任务；非处置消息始终复用原对象引用。 */
function durableAntiRaidMessagesMatch(
  left: readonly AntiRaidWorkerMessage[],
  right: readonly AntiRaidWorkerMessage[]
): boolean {
  if (left.length !== right.length) return false;
  for (let index: number = 0; index < left.length; index++) {
    const leftMessage: AntiRaidWorkerMessage | undefined = left[index];
    const rightMessage: AntiRaidWorkerMessage | undefined = right[index];
    if (leftMessage === undefined || rightMessage === undefined) return false;
    if (
      leftMessage.type !== "removeBlockedMembers" ||
      rightMessage.type !== "removeBlockedMembers"
    ) {
      if (leftMessage !== rightMessage) return false;
      continue;
    }
    if (
      leftMessage.removalId !== rightMessage.removalId ||
      leftMessage.chatId !== rightMessage.chatId ||
      leftMessage.probeMembership !== rightMessage.probeMembership ||
      leftMessage.joinedAt !== rightMessage.joinedAt ||
      leftMessage.announcementMessageId !== rightMessage.announcementMessageId
    ) {
      return false;
    }
    // 补扫（probeMembership）的名单不参与比较：它不进 outbox，是投递前按当时的黑名单
    // 现算的（见 types/blocklist.ts 的 PendingBlockedRemovalParams），durable 的只有任务本身。
    if (leftMessage.probeMembership) continue;
    if (leftMessage.userIds.length !== rightMessage.userIds.length) return false;
    for (
      let userIndex: number = 0;
      userIndex < leftMessage.userIds.length;
      userIndex++
    ) {
      if (leftMessage.userIds[userIndex] !== rightMessage.userIds[userIndex]) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 处置消息在 outbox flush 等待期间仍可能被 `/block disable` 或停管裁剪。每次发现
 * 权威参数变化都重新持久化，直到「本次已 durable 的内容」与即将投递的内容
 * 完全一致；最终对账与同步 post 之间没有 await。
 *
 * 轮次上限为 BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS（同 antiRaid/workerBridge/events.ts 的
 * persistCurrentLockdown）。
 *
 * 用尽时既不投也不抛，只把处置消息整批摘掉：
 * - 不投最后一次对账结果，它可能含刚被 `/block disable` 取消的批次。
 * - 不抛：本函数跑在 update 中间件里（postAntiRaidDurably 没有 try/catch），
 *   降级语义与 blocklistGuard.claimBlockedJoiner 一致。
 * 任务本身留在 durable outbox 里，相关群欠一次补扫（requestBlocklistResweep）。
 * 这一档不补投被取代的 join：批次还在 outbox 里、这个人仍待清出。只有批次被取消
 * （权威镜像里查不到）才补，见 reconcileBlockedRemovalMessages。
 * @param replacedJoins removalId -> 被它取代的 join，由 claimBlockedJoiner 登记。
 */
export async function prepareDurableAntiRaidMessages(
  messages: readonly AntiRaidWorkerMessage[],
  replacedJoins: ReadonlyMap<number, AntiRaidWorkerMessage> = new Map()
): Promise<AntiRaidWorkerMessage[]> {
  let durableMessages: AntiRaidWorkerMessage[] =
    await reconcileBlockedRemovalMessages(messages, replacedJoins, false);
  for (let round: number = 0; round < BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS; round++) {
    await persistPendingBlockedRemovals();
    const currentMessages: AntiRaidWorkerMessage[] =
      await reconcileBlockedRemovalMessages(messages, replacedJoins, true);
    if (durableAntiRaidMessagesMatch(durableMessages, currentMessages)) {
      return currentMessages;
    }
    durableMessages = currentMessages;
  }
  const stalledChatIds: Set<number> = new Set<number>();
  const withoutRemovals: AntiRaidWorkerMessage[] = [];
  for (const message of durableMessages) {
    if (message.type === "removeBlockedMembers") stalledChatIds.add(message.chatId);
    else withoutRemovals.push(message);
  }
  logger.error(
    `Blocklist removal messages kept changing across ${BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS} durability rounds; ` +
    `withholding the batches for ${stalledChatIds.size} chat(s), which stay in the durable outbox and now owe a resweep.`
  );
  for (const chatId of stalledChatIds) requestBlocklistResweep(chatId);
  return withoutRemovals;
}
