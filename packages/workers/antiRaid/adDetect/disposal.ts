/**
 * 判定命中后的处置副作用（入群守卫线程侧）：删掉这一串消息，并把「这个人该按
 * /block 处置」回投主线程。
 *
 * 拉黑名单与跨群封禁**不在这里做**：名单是主线程的同步安全边界、要落盘，
 * 封禁批次要进 durable outbox 才能跨进程重放（见 docs/04-invariants.md）。
 * 主线程收到事件后走的正是 /block 那条路径，而封禁本身又会被投回本线程执行，
 * 因此真正的网络请求仍然全部发生在这条线程上。群内播报同理跟着结果走，由
 * 主线程发（见 antiRaid/adDetect.ts 的 announceAdDisposal）。
 */

import { deleteMessage, deleteMessages, joinVerificationApi } from "../../../infra/telegram";
import { logger } from "../../../infra/logger";
import { adDetectPublishHolder } from "../../../cache/workers/antiRaid/adDetect";
import { botCanDeleteIn } from "../botPermissions";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../../consts/telegram";
import type { AdDetectedEvent, AdSampleMessage } from "../../../types/antiRaid";
import type { AdCandidateEntry, AdMessageBundle, AdVerdict } from "../../../types/antiRaid/adDetect";

export interface DisposeAdSenderParams {
  bundle: AdMessageBundle;
  verdict: AdVerdict;
  /**
   * 送检那一刻真正交给模型的条目（见 bundle.ts 的 selectAdBundleEntries）。与
   * `bundle.entries` 分开传：后者是活对象，往返期间会并进新消息、也可能被裁掉
   * 几条。样本记这一份，删除取两者的并集。
   */
  judged: readonly AdCandidateEntry[];
}

/**
 * 这次处置要删的消息 id：判定依据 ∪ 此刻串里还剩的 ∪ 挤出去时转存的。三边都
 * 不能少——只删第一份会放过往返期间抢发的后续广告，只删第二份会漏掉被单 key
 * 条数/字符预算挤出当前上下文、但模型确实读过并据此判定的那些消息，而第三份
 * 是压根没赶上判定就被挤出去的那些（见 AdMessageBundle.pendingDeleteIds）。
 */
function disposalMessageIds(
  judged: readonly AdCandidateEntry[],
  current: readonly AdCandidateEntry[],
  evicted: readonly number[]
): number[] {
  const ids: number[] = [];
  const seen: Set<number> = new Set<number>();
  for (const entry of [...judged, ...current]) {
    if (seen.has(entry.messageId)) continue;
    seen.add(entry.messageId);
    ids.push(entry.messageId);
  }
  for (const messageId of evicted) {
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    ids.push(messageId);
  }
  return ids;
}

/**
 * 删掉一条抢在处置落地之前发出来的广告（只用于频道马甲）。
 *
 * 频道身份的封禁走 banChatSenderChat，那个接口没有 revoke_messages（见
 * docs/04-invariants.md），逐条删除是这些消息唯一的清理路径；而判定命中到封禁
 * 真正落地之间还隔着回投主线程、黑名单 fsync、outbox 写前日志与 mailbox 屏障，
 * 这段空档里频道新发的广告不会再被判定第二次。fire-and-forget：与本流水线其余
 * 部分一样是尽力而为，不登记进停机 drain 的在途集合。
 */
export function deleteStragglerAdMessage(chatId: number, messageId: number): void {
  // 确证没有删消息权限就别打：这些请求与验证超时踢人共用一条限流队列，一场
  // 广告突袭能把几十个注定 400 的删除顶在真正的踢人前面。三态里只拦确证的
  // false，「没观测到」照常发（理由见 ../botPermissions.ts）。
  if (botCanDeleteIn(chatId) === false) return;
  void deleteMessage(chatId, messageId, joinVerificationApi);
}

/**
 * 执行一次广告处置的 Worker 半边：回投事件 + 删消息。两者都是尽力而为（失败
 * 只记日志）；真正不可丢的拉黑与封禁由主线程接管，因此这里不会因为删除失败
 * 就不回投事件。
 *
 * 群内播报**不在这里发**。它的文案要断言「在所有盯着的群里一起封掉了」，而
 * 那件事此刻还没发生：主线程可能因为 outbox 触顶、刚被撤管理员或 /init disable
 * 而一个群都登记不上。谁知道结果谁播报，因此挪到主线程的 disposeDetectedAd
 * （见 antiRaid/adCandidate.ts）。
 */
export async function disposeAdSender({ bundle, verdict, judged }: DisposeAdSenderParams): Promise<void> {
  const messageIds: number[] = disposalMessageIds(judged, bundle.entries, bundle.pendingDeleteIds);
  logger.log(
    `Ad detection flagged sender ${bundle.senderId} in chat ${bundle.chatId} ` +
    `on ${judged.length} judged message(s), deleting ${messageIds.length}: ` +
    `${verdict.reason || "no reason given"}.`
  );
  // 先回投主线程：拉黑落盘 + 各群封禁是这次处置里唯一不可丢的部分，不该排在
  // 删消息的网络往返后面。通道为空只发生在 Worker 已经停止的路径上。
  const publish: ((event: AdDetectedEvent) => void) | null = adDetectPublishHolder.current;
  if (publish === null) {
    // 通道已关（Worker 停止路径）：拉黑与各群封禁这半边永远不会发生了，播报
    // 自然也不会有——它跟着结果走，在主线程发。删消息照做。
    logger.error(
      `Ad detection could not report sender ${bundle.senderId} in chat ${bundle.chatId}: ` +
      "the main-thread channel is closed; deleting the messages without announcing a block."
    );
    await deleteAdMessages(bundle.chatId, messageIds);
    return;
  }
  publish({
    type: "adDetected",
    chatId: bundle.chatId,
    senderId: bundle.senderId,
    isChannel: bundle.isChannel,
    label: bundle.label,
    reason: verdict.reason,
    // 判定依据的整串原样带回主线程写进命中样本（见 diskIO/adSampleFile.ts）：
    // 判定看的是整串而不是某一条，只留触发那一条的话，人回头看到的是一句
    // 孤立的话，复现不出模型当时读到的东西。用送检那一刻定格的 judged 而不是
    // 活的 bundle.entries，否则写进样本的是模型没读过的内容。
    messages: judged.map((entry: AdCandidateEntry): AdSampleMessage => ({
      messageId: entry.messageId,
      text: entry.text,
      ...(entry.quote !== undefined ? { quote: entry.quote } : {}),
      ...(entry.replyTo !== undefined ? { replyTo: entry.replyTo } : {}),
    })),
  });

  // 一次删掉判定依据与此刻串里还剩的并集（见 disposalMessageIds）。封禁那边也带
  // revoke_messages，但它只覆盖「还在这个群里的成员」，频道马甲与已经自己退群的
  // 账号都不在其列；而这些正是本次判定的直接依据，无论如何都要清掉。
  //
  // 走批量接口而不是逐条 await：这些请求与验证超时踢人共用一条限流队列，而广告
  // 链路刻意不登记进在途任务集合，同时在跑多少条没有上界。逐条删会把一次处置
  // 放大成几十个往返顶在踢人前面，正是当初拆开 API 队列要避免的事。
  await deleteAdMessages(bundle.chatId, messageIds);
}

/**
 * 按 Telegram 的单次上限分片删除。并集含 pendingDeleteIds 之后可以远超 100
 * （见 AD_DETECT_MAX_PENDING_DELETE_IDS），而 deleteMessages 只有整体成败：
 * 一次带满整份 id 会让整批被拒，一条都删不掉——比不转存那些 id 还糟。
 *
 * 有分片失败时记一条明确指向权限的错误：机器人可以是「有 can_restrict_members、
 * 没有 can_delete_messages」的管理员，那种配置下这里每次都全军覆没，而统一错误
 * 边界记的是 Telegram 那句通用的 400。不额外重试——超过 48 小时的消息本来就删
 * 不掉，重试只是在共用队列上再堆一轮注定失败的请求。
 */
async function deleteAdMessages(chatId: number, messageIds: readonly number[]): Promise<void> {
  // 同 deleteStragglerAdMessage：确证没权限时一次分片都不必发。一次处置的并集
  // 可以远超 100 条，全打出去就是 ceil(N/100) 个注定失败的往返压在踢人前面。
  if (botCanDeleteIn(chatId) === false) {
    logger.error(
      `Ad disposal skipped deleting ${messageIds.length} message(s) in chat ${chatId}: ` +
      "the bot is known to lack can_delete_messages there."
    );
    return;
  }
  let failedBatches: number = 0;
  for (let start: number = 0; start < messageIds.length; start += TELEGRAM_DELETE_MESSAGES_BATCH_MAX) {
    const deleted: boolean = await deleteMessages(
      chatId,
      messageIds.slice(start, start + TELEGRAM_DELETE_MESSAGES_BATCH_MAX),
      joinVerificationApi
    );
    if (!deleted) failedBatches++;
  }
  if (failedBatches === 0) return;
  logger.error(
    `Ad disposal could not delete ${failedBatches} batch(es) of ${messageIds.length} message(s) ` +
    `in chat ${chatId}: the bot may lack can_delete_messages, or the messages are older than 48h.`
  );
}
