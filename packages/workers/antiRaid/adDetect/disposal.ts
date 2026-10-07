/**
 * 判定命中后的处置副作用（入群守卫线程侧）：删掉这一串消息，并把「这个人该按
 * /block 处置」回投主线程。
 *
 * 拉黑名单与跨群封禁**不在这里做**：名单是主线程的同步安全边界、要落盘，
 * 封禁批次要进 durable outbox 才能跨进程重放（见 docs/cn/04-invariants.md）。
 * 主线程收到事件后走的正是 /block 那条路径，而封禁的业务顺序又会被投回本线程
 * 执行；每个 Telegram 能力请求最终仍经双工边界由主线程唯一客户端发起。群内
 * 播报同理跟着结果走，由主线程发（见 antiRaid/adDetect.ts 的 announceAdDisposal）。
 */

import { workerAtmosphere } from "../atmosphere";
import { formatUserLabel } from "../../../users/userLabel";
import type { AtmosphereTexts } from "../../../types/atmosphere";
import {
  deleteMessage,
  deleteMessages,
  telegramApi,
} from "../../../infra/telegram";
import { sendTemporaryMessageFromMain } from "../../../infra/telegram/workerClient";
import { logger } from "../../../infra/logger";
import {
  adDetectPublishHolder,
  inFlightReferencedAdCleanupTasks,
} from "../../../cache/workers/antiRaid/adDetect";
import { botCanDeleteIn } from "../botPermissions";
import {
  AD_DETECT_MAX_IN_FLIGHT,
} from "../../../consts/antiRaid/adDetect";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../../consts/commands";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../../consts/telegram";
import type {
  AdCandidateEntry,
  AdDetectedEvent,
  AdMessageBundle,
  AdSampleMessage,
  AdVerdict,
} from "../../../types/antiRaid/adDetect";
import type { TelegramWorkerTemporaryMessageResult } from "../../../types/telegramWorker";

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

export interface DeleteReferencedAdMessagesParams {
  readonly bundle: AdMessageBundle;
  readonly judged: readonly AdCandidateEntry[];
  /** 只清理不晚于公开警告的消息，之后的新消息必须留给升级判定。 */
  readonly messageIdThrough: number;
}

interface DisposalMessageIdsParams {
  readonly judged: readonly AdCandidateEntry[];
  readonly current: readonly AdCandidateEntry[];
  readonly evictedIds: readonly number[];
  readonly messageIdThrough?: number;
}

/**
 * 处置播报里的展示标签：按冻结的可见发送者元数据与本进程氛围现算，口径同
 * users/userLabel.ts 的 formatUserLabel（频道的 firstName 即频道标题）。
 */
function adSenderLabel(bundle: AdMessageBundle, atmosphere: AtmosphereTexts): string {
  return formatUserLabel({
    id: bundle.senderId,
    username: bundle.meta.username,
    first_name: bundle.meta.firstName,
    title: bundle.meta.firstName,
    isChannel: bundle.isChannel,
  }, atmosphere);
}

/**
 * 第一次引用类广告的公开警告。主线程在发出消息的同一成功回调里登记
 * COMMAND_MESSAGE_AUTO_DELETE_MS 后删除，返回成功即表示清理 owner 已接管。
 */
export function warnReferencedAdSender(
  bundle: AdMessageBundle
): Promise<TelegramWorkerTemporaryMessageResult | undefined> {
  const atmosphere: AtmosphereTexts = workerAtmosphere();
  return sendTemporaryMessageFromMain({
    purpose: "adWarning",
    chatId: bundle.chatId,
    identityId: bundle.senderId,
    text: atmosphere.NOTICE_TEXTS.adReferenceWarning(adSenderLabel(bundle, atmosphere)),
    deleteAfterMs: COMMAND_MESSAGE_AUTO_DELETE_MS,
  });
}

/**
 * 清理第一次警告覆盖的广告消息。删除是独立的尽力而为副作用，不占用分类
 * in-flight，不阻塞同一发送者警告后的再次判定。
 */
export function deleteReferencedAdMessages({
  bundle,
  judged,
  messageIdThrough,
}: DeleteReferencedAdMessagesParams): void {
  const messageIds: number[] = disposalMessageIds({
    judged,
    current: bundle.entries,
    evictedIds: bundle.pendingDeleteIds,
    messageIdThrough,
  });
  logger.log(
    `Ad detection warned sender ${bundle.senderId} in chat ${bundle.chatId} for referenced ad content, ` +
    `deleting ${messageIds.length} message(s).`
  );
  if (
    messageIds.length === 0 ||
    inFlightReferencedAdCleanupTasks.size >= AD_DETECT_MAX_IN_FLIGHT
  ) {
    if (messageIds.length > 0) {
      logger.error(
        `Ad detection skipped deleting ${messageIds.length} referenced-ad message(s) ` +
        `in chat ${bundle.chatId}: the cleanup task ceiling is full.`
      );
    }
    return;
  }
  const cleanup: Promise<void> = deleteAdMessages(
    bundle.chatId,
    messageIds
  ).catch((error: unknown): void => {
    logger.error(
      `Unexpected error while deleting referenced ad messages for sender ${bundle.senderId} ` +
      `in chat ${bundle.chatId}:`,
      error
    );
  });
  inFlightReferencedAdCleanupTasks.add(cleanup);
  void cleanup.then((): void => {
    inFlightReferencedAdCleanupTasks.delete(cleanup);
  });
}

/**
 * 这次处置要删的消息 id：判定依据 ∪ 此刻串里还剩的 ∪ 挤出去时转存的。三份分别
 * 覆盖送检时的入选条目、往返期间并进串里的后续消息、被条数/字符预算挤出串且未赶上
 * 判定的消息（见 AdMessageBundle.pendingDeleteIds）。
 */
function disposalMessageIds({
  judged,
  current,
  evictedIds,
  messageIdThrough = Number.POSITIVE_INFINITY,
}: DisposalMessageIdsParams): number[] {
  const ids: number[] = [];
  const seen: Set<number> = new Set<number>();
  for (const entry of [...judged, ...current]) {
    if (entry.messageId > messageIdThrough) continue;
    if (seen.has(entry.messageId)) continue;
    seen.add(entry.messageId);
    ids.push(entry.messageId);
  }
  for (const messageId of evictedIds) {
    if (messageId > messageIdThrough || seen.has(messageId)) continue;
    seen.add(messageId);
    ids.push(messageId);
  }
  return ids;
}

/**
 * 删掉一条抢在处置落地之前发出来的广告（只用于频道马甲）。
 *
 * 频道身份的封禁走 banChatSenderChat，该接口没有 revoke_messages（见
 * docs/cn/04-invariants.md），这些消息逐条删除；处置落地前频道新发的消息不会被再次
 * 判定。fire-and-forget：尽力而为，不登记进停机 drain 的在途集合。
 */
export function deleteStragglerAdMessage(chatId: number, messageId: number): void {
  // 确证没有删消息权限时不发请求；三态里只拦确证的 false，「没观测到」照常发（见
  // ../botPermissions.ts）。
  if (botCanDeleteIn(chatId) === false) return;
  void deleteMessage(chatId, messageId, telegramApi);
}

/**
 * 执行一次广告处置的 Worker 半边：回投事件 + 删消息。两者都是尽力而为（失败
 * 只记日志），删除失败不影响事件回投；拉黑与封禁由主线程接管。
 *
 * 群内播报**不在这里发**，由主线程按处置结果发出（见 antiRaid/adDetect.ts 的
 * announceAdDisposal）。
 */
export async function disposeAdSender({ bundle, verdict, judged }: DisposeAdSenderParams): Promise<void> {
  const messageIds: number[] = disposalMessageIds({
    judged,
    current: bundle.entries,
    evictedIds: bundle.pendingDeleteIds,
  });
  logger.log(
    `Ad detection flagged sender ${bundle.senderId} in chat ${bundle.chatId} ` +
    `on ${judged.length} judged message(s), deleting ${messageIds.length}: ` +
    `${verdict.reason || "no reason given"}.`
  );
  // 先回投主线程，再删消息。通道为空只发生在 Worker 已经停止的路径上。
  const publish: ((event: AdDetectedEvent) => void) | null = adDetectPublishHolder.current;
  if (publish === null) {
    // 通道已关（Worker 停止路径）：不回投事件，也就没有拉黑、封禁与播报；删消息照做。
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
    label: adSenderLabel(bundle, workerAtmosphere()),
    meta: bundle.meta,
    reason: verdict.reason,
    // 判定依据的整串原样带回主线程写进命中样本（见 diskIO/adSampleFile.ts），
    // 取送检时定格的 judged，不取活的 bundle.entries。
    messages: judged.map((entry: AdCandidateEntry): AdSampleMessage => ({
      messageId: entry.messageId,
      text: entry.text,
      ...(entry.quote !== undefined ? { quote: entry.quote } : {}),
      ...(entry.replyTo !== undefined ? { replyTo: entry.replyTo } : {}),
    })),
  });

  // 一次删掉判定依据与此刻串里还剩的并集（见 disposalMessageIds）。封禁带
  // revoke_messages 只覆盖仍在群里的成员，频道马甲与已退群账号的消息由这里清掉。
  // 走批量接口，每 TELEGRAM_DELETE_MESSAGES_BATCH_MAX 条占一个请求。
  await deleteAdMessages(bundle.chatId, messageIds);
}

/**
 * 按 TELEGRAM_DELETE_MESSAGES_BATCH_MAX 分片删除：并集含 pendingDeleteIds 后可超过
 * 单次上限（见 AD_DETECT_MAX_PENDING_DELETE_IDS），而 deleteMessages 只有整体成败。
 *
 * 有分片失败时记一条指向权限的错误，不额外重试。
 */
async function deleteAdMessages(chatId: number, messageIds: readonly number[]): Promise<void> {
  // 同 deleteStragglerAdMessage：确证没权限时不发分片。
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
      telegramApi
    );
    if (!deleted) failedBatches++;
  }
  if (failedBatches === 0) return;
  logger.error(
    `Ad disposal could not delete ${failedBatches} batch(es) of ${messageIds.length} message(s) ` +
    `in chat ${chatId}: the bot may lack can_delete_messages, or the messages are older than 48h.`
  );
}
