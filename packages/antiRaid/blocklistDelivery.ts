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
import type { AntiRaidWorkerMessage } from "../types/antiRaid";
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
 * 摘掉时若这批处置**取代过**一条 join（黑名单成员入群那一路：Worker 不会为一个
 * 马上要被踢掉的人开窗口，所以那条 join 压根没入过数组），必须把它补回去。否则
 * 并发的 `/unblock` 在 outbox flush 的等待期里取消掉这批处置之后，这个人既没有
 * 移除、也没有验证窗口——没有窗口就没有提醒、没有超时踢人，他就这么留在群里，
 * 而系统里再没有任何一处会为他重新开一个（反刷群的入群计数同样漏记）。
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
    // **补扫的名单不参与比较**：它不进 outbox，是投递前按当时的黑名单现算的
    // （见 types/blocklist.ts 的 PendingBlockedRemovalParams）。这个循环要确认的是
    // 「本次已 durable 的内容与即将投递的内容一致」，而补扫 durable 的只有任务本身。
    // 拿现算结果来比，等落盘的这几毫秒里随便一次 /block 或广告处置命中都会白烧
    // 一轮，连着变几次就把一次完全合法的补扫整个 withheld 掉。
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
 * 处置消息在 outbox flush 等待期间仍可能被 `/unblock` 或停管裁剪。每次发现
 * 权威参数变化都重新持久化，直到「本次已 durable 的内容」与即将投递的内容
 * 完全一致；最终对账与同步 post 之间没有 await，不留旧任务重新进入 Worker
 * 的事件循环窗口。
 *
 * 轮次有上限（同 antiRaid/workerBridge.ts 的 persistCurrentLockdown）：每轮都是整份
 * outbox 深拷贝加一次带 fsync 的整文件重写，而本函数跑在 update 处理里面。
 *
 * 用尽时既不投也不抛，只把处置消息整批摘掉：
 * - 不投最后一次对账结果——那可能含刚被 `/unblock` 取消的批次，正是这套对账要挡的。
 * - 不抛——本函数跑在 update 中间件里（postAntiRaidDurably 没有 try/catch），异常
 *   会让这条 update 判失败、最终 offset 被扣住，重启后 Telegram 重投同一条，
 *   而触发条件（并发 `/unblock` 反复裁剪同一批）照样成立，正好把重启循环焊死。
 *   这与同子系统 blocklistGuard.claimBlockedJoiner 的降级语义一致。
 * 任务本身留在 durable outbox 里不会丢，再让相关群欠一次补扫作为下一次机会。
 * 这一档**不补投被取代的 join**：批次还在 outbox 里、这个人仍然待清出去，补一个
 * 验证窗口等于给一个仍在黑名单上的人开门。只有批次真的被取消（权威镜像里查不到
 * 了）才需要兜底，见 reconcileBlockedRemovalMessages。
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
