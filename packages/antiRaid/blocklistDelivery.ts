import {
  getPendingBlockedRemovalParams,
  persistPendingBlockedRemovals,
  requestBlocklistResweep,
} from "../infra/blocklist";
import { logger } from "../infra/logger";
import { BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS } from "../consts/antiRaid/blocklist";
import type { AntiRaidWorkerMessage } from "../types/antiRaid";
import type { RemoveBlockedMembersParams } from "../types/blocklist";

/** 以主线程当前权威镜像重建处置消息；已经取消的批次直接从待投数组摘掉。 */
function reconcileBlockedRemovalMessages(
  messages: readonly AntiRaidWorkerMessage[]
): AntiRaidWorkerMessage[] {
  const reconciled: AntiRaidWorkerMessage[] = [];
  for (const message of messages) {
    if (message.type !== "removeBlockedMembers") {
      reconciled.push(message);
      continue;
    }
    const params: RemoveBlockedMembersParams | undefined =
      getPendingBlockedRemovalParams(message.removalId);
    if (params !== undefined) {
      reconciled.push({ type: "removeBlockedMembers", ...params });
    }
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
      leftMessage.announcementMessageId !== rightMessage.announcementMessageId ||
      leftMessage.userIds.length !== rightMessage.userIds.length
    ) {
      return false;
    }
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
 * 处置消息在 outbox flush 等待期间仍可能被 `/unblock` 或停管裁剪。每次发现
 * 权威参数变化都重新持久化，直到「本次已 durable 的内容」与即将投递的内容
 * 完全一致；最终对账与同步 post 之间没有 await，不留旧任务重新进入 Worker
 * 的事件循环窗口。
 *
 * 轮次有上限（同 antiRaid/index.ts 的 persistCurrentLockdown）：每轮都是整份
 * outbox 深拷贝加一次带 fsync 的整文件重写，而本函数跑在 update 处理里面。
 *
 * 用尽时既不投也不抛，只把处置消息整批摘掉：
 * - 不投最后一次对账结果——那可能含刚被 `/unblock` 取消的批次，正是这套对账要挡的。
 * - 不抛——本函数跑在 update 中间件里（postAntiRaidDurably 没有 try/catch），异常
 *   会让这条 update 判失败、最终 offset 被扣住，重启后 Telegram 重投同一条，
 *   而触发条件（并发 `/unblock` 反复裁剪同一批）照样成立，正好把重启循环焊死。
 *   这与同子系统 blocklistGuard.claimBlockedJoiner 的降级语义一致。
 * 任务本身留在 durable outbox 里不会丢，再让相关群欠一次补扫作为下一次机会。
 */
export async function prepareDurableAntiRaidMessages(
  messages: readonly AntiRaidWorkerMessage[]
): Promise<AntiRaidWorkerMessage[]> {
  let durableMessages: AntiRaidWorkerMessage[] =
    reconcileBlockedRemovalMessages(messages);
  for (let round: number = 0; round < BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS; round++) {
    await persistPendingBlockedRemovals();
    const currentMessages: AntiRaidWorkerMessage[] =
      reconcileBlockedRemovalMessages(messages);
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
