import {
  getPendingBlockedRemovalParams,
  persistPendingBlockedRemovals,
} from "../infra/blocklist";
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
 */
export async function prepareDurableAntiRaidMessages(
  messages: readonly AntiRaidWorkerMessage[]
): Promise<AntiRaidWorkerMessage[]> {
  let durableMessages: AntiRaidWorkerMessage[] =
    reconcileBlockedRemovalMessages(messages);
  while (true) {
    await persistPendingBlockedRemovals();
    const currentMessages: AntiRaidWorkerMessage[] =
      reconcileBlockedRemovalMessages(messages);
    if (durableAntiRaidMessagesMatch(durableMessages, currentMessages)) {
      return currentMessages;
    }
    durableMessages = currentMessages;
  }
}
