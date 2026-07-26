/**
 * /block 黑名单的处置副作用（入群守卫线程侧）。判定不在这里——名单是主线程
 * 状态，`isUserBlocked` 在主线程同步查完才投递本消息（见 infra/blocklist.ts
 * 与 antiRaid/blocklistGuard.ts）。本模块负责「把这些 id 清出这个群」这一步：
 * 探测、封禁、失败重试，以及秒踢路径顺带的入群计数与公告清理。
 *
 * 放在 Worker 里的理由和验证超时踢人一样：请求走 joinVerificationApi，与普通
 * 消息发送分开排队（见 infra/telegram/client.ts）；而且不占主线程处理 update
 * 的时间——新晋管理员后的补扫是 O(名单长度) 次 getChatMember，压在主线程上
 * 会把那个群的更新车道堵住。
 *
 * 与本线程其它副作用共用同一条节奏：dispatch 里同步的部分立即返回，网络请求
 * 事后串行执行，绝不阻塞 mailbox——否则一波刷屏入群的后续投递会被网络往返卡住。
 *
 * 三条与「一次失败就等于放人进群」直接相关的约束（见 docs/04-invariants.md）：
 * - 失败必须重试，且最终结果要回执给主线程。黑名单入群不开验证窗口，没有
 *   超时踢人兜底，处置是这个人被清出去的唯一机会。
 * - 探测失败不算「不在群」。只有确认不在群才跳过，其余一律照封。
 * - 群停管后立刻放弃在途批次，避免在已经不归自己管的群里继续封人。
 */

import { banChatMember, banChatSenderChat, deleteMessage, joinVerificationApi, probeChatMembership } from "../../infra/telegram";
import { logger } from "../../infra/logger";
import { recordJoin } from "./lockdownRuntime";
import { currentBlocklistRemovalEpoch } from "../../cache/antiRaid/blocklist";
import {
  BLOCKLIST_REMOVAL_MAX_ATTEMPTS,
  BLOCKLIST_REMOVAL_RETRY_DELAY_MS,
  BLOCKLIST_SWEEP_BATCH_PAUSE_MS,
  BLOCKLIST_SWEEP_BATCH_SIZE,
} from "../../consts/antiRaid/blocklist";
import type { BlockedMembersRemovedEvent, RemoveBlockedMembersMessage } from "../../types/antiRaid";
import type { RemoveBlockedMembersParams } from "../../types/blocklist";

/** 单个 id 的处置结局：封成功、确认不在群（无需处置）、或没能落定。 */
type RemovalOutcome = "removed" | "absent" | "failed";

export interface RemoveOneParams {
  chatId: number;
  userId: number;
  probeMembership: boolean;
}

/**
 * 处置一个 id，失败按线性退避重试。
 * @returns removed=已封；absent=确认不在群，不必封；failed=尝试用尽仍未落定。
 */
async function removeOne({ chatId, userId, probeMembership }: RemoveOneParams): Promise<RemovalOutcome> {
  for (let attempt: number = 1; attempt <= BLOCKLIST_REMOVAL_MAX_ATTEMPTS; attempt++) {
    // 频道马甲（sender_chat）没有「成员」这个概念，getChatMember 探不到，
    // 一律直接封掉它在本群的发言权（同 commands/block.ts 的处理）。
    if (userId < 0) {
      if (await banChatSenderChat(chatId, userId, joinVerificationApi)) return "removed";
    } else {
      if (probeMembership) {
        const present: boolean | undefined = await probeChatMembership(chatId, userId, joinVerificationApi);
        // 只有「确认不在群」才跳过。探测失败（429、网络抖动）时照样封：对一个
        // 本来就不在群里的黑名单 id 多封一次是幂等的，效果只是提前封住；反过来
        // 把失败当成「不在群」，坐在群里的人就被静默放过了。
        if (present === false) return "absent";
      }
      if (await banChatMember(chatId, userId, joinVerificationApi)) return "removed";
    }
    if (attempt < BLOCKLIST_REMOVAL_MAX_ATTEMPTS) {
      await Bun.sleep(BLOCKLIST_REMOVAL_RETRY_DELAY_MS * attempt);
    }
  }
  return "failed";
}

/**
 * 逐个处置一批黑名单 id。
 * @returns 每个 id 都已落定（封成功或确认不在群）为 true；只要有一个没落定
 *   就是 false——主线程据此保留镜像、不把这个群标成已清扫。
 */
async function removeBlockedMembers({
  chatId,
  userIds,
  probeMembership,
  joinedAt,
  announcementMessageId,
}: RemoveBlockedMembersParams): Promise<boolean> {
  // 入群计数是同步的、与网络无关，先记：黑名单入群不再投 join，若不在这里
  // 补记，一波以黑名单账号为主的刷群就凑不够反刷群窗口的阈值。
  if (joinedAt !== undefined) recordJoin(chatId, joinedAt);
  const epoch: number = currentBlocklistRemovalEpoch(chatId);
  let removed: number = 0;
  let complete: boolean = true;
  for (let index: number = 0; index < userIds.length; index++) {
    // 群已被停管：整批放弃，且不算完成——重新接管后会有新的边沿再扫一次。
    if (currentBlocklistRemovalEpoch(chatId) !== epoch) return false;
    // 补扫可能有几千个 id，且与验证超时踢人共用同一条限流队列；每批之间让一步，
    // 给排在后面的踢人请求留出插空的机会。
    if (index > 0 && index % BLOCKLIST_SWEEP_BATCH_SIZE === 0) {
      await Bun.sleep(BLOCKLIST_SWEEP_BATCH_PAUSE_MS);
    }
    const outcome: RemovalOutcome = await removeOne({ chatId, userId: userIds[index]!, probeMembership });
    if (outcome === "removed") removed++;
    else if (outcome === "failed") complete = false;
  }
  // 入群公告：不投 join 就没人再管这条服务消息了，处置走完顺手删掉。
  if (announcementMessageId !== undefined && currentBlocklistRemovalEpoch(chatId) === epoch) {
    await deleteMessage(chatId, announcementMessageId, joinVerificationApi);
  }
  if (removed > 0) logger.log(`Removed ${removed} blocklisted member(s) from chat ${chatId}.`);
  return complete;
}

export interface HandleRemoveBlockedMembersParams {
  msg: RemoveBlockedMembersMessage;
  /** 回执通道（Worker -> 主线程）；由 antiRaidWorker.ts 注入 self.postMessage。 */
  publish: (event: BlockedMembersRemovedEvent) => void;
}

/**
 * 处置入口：同步返回，网络请求在后台跑完，结束后回执。回执带 complete——
 * 主线程只在 complete 时销镜像并把群标成已清扫，否则留着等重投或下一次边沿。
 */
export function handleRemoveBlockedMembers({ msg, publish }: HandleRemoveBlockedMembersParams): void {
  void removeBlockedMembers(msg)
    .then((complete: boolean): void => {
      publish({ type: "blockedMembersRemoved", chatId: msg.chatId, removalId: msg.removalId, complete });
    })
    .catch((error: unknown): void => {
      logger.error(`Failed to remove blocklisted members from chat ${msg.chatId}:`, error);
      publish({ type: "blockedMembersRemoved", chatId: msg.chatId, removalId: msg.removalId, complete: false });
    });
}
