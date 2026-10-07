/**
 * 一个待检 key 的判定编排与处置（入群守卫线程侧）。
 *
 * 送检前定格本次入选的条目与水位，判定回来后按四态归因分派：不是广告、没判出
 * 结论、直接发广告、只有引用内容是广告。判定失败一律只推进已检水位，不冒充确证。
 *
 * 判定期间新到的消息会并进同一个 bundle，由 inFlight 标记挡住第二次并发送检；
 * 结算后由 queueState.ts 的 requeueIfUnchecked 把未判水位恰好重排一次。
 * 派发节拍与生命周期在 queue.ts。
 */

import { classifyAdText } from "./classifier";
import {
  deleteReferencedAdMessages,
  disposeAdSender,
  warnReferencedAdSender,
} from "./disposal";
import { deleteMessage, telegramApi } from "../../../infra/telegram";
import { isChatAdmin } from "../adminCache";
import { logger } from "../../../infra/logger";
import {
  adVerdictTruePublishHolder,
  adDetectStopping,
  inFlightAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningStates,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_REFERENCE_WARNING_WINDOW_MS,
} from "../../../consts/antiRaid/adDetect";
import { setBoundedMapValue } from "../../../libs/boundedMap";
import {
  claimSampleContextParts,
  containsReferencedAdContent,
  formatAdBundleText,
  formatDirectAdBundleText,
  selectAdBundleEntries,
} from "./bundle";
import {
  beginReferencedAdWarning,
  cancelReferencedAdWarning,
  completeReferencedAdWarning,
} from "./referencePolicy";
import {
  deletePendingAdBundle,
  pendingAdBundle,
  refreshAdDetectCapacitySaturation,
  requeueIfUnchecked,
} from "./queueState";
import type {
  AdBundleSelection,
  AdCandidateEntry,
  AdMessageBundle,
  AdVerdict,
} from "../../../types/antiRaid/adDetect";
import type {
  TelegramWorkerTemporaryMessageResult,
  TelegramWorkerTemporaryMessageSentResult,
} from "../../../types/telegramWorker";

/**
 * 处置前的最后一道身份闸：这个发送者此刻是不是本群管理员。
 *
 * 判定命中才查，优先用缓存；缓存冷时现拉一次全量管理员。
 * @returns true=确认是管理员；false=确认不是；undefined=没查出来。
 */
async function isAdminSender(bundle: AdMessageBundle): Promise<boolean | undefined> {
  // 频道马甲没有「群成员」身份，直接返回 false；以当前群为身份的匿名管理员在主线程
  // 投递入口已被挡掉（见 antiRaid/adCandidate.ts）。三态查询共用 adminCache 的 isChatAdmin。
  if (bundle.isChannel) return false;
  return await isChatAdmin(bundle.chatId, bundle.senderId, "sender");
}

type AdDetectionOutcome =
  | { readonly kind: "notAd" }
  | { readonly kind: "unknown" }
  | { readonly kind: "directAd"; readonly verdict: AdVerdict }
  | { readonly kind: "referencedOnly"; readonly verdict: AdVerdict };

/**
 * 把整串命中进一步收敛成显式归因四态。第二次请求返回 null 或抛错都属于
 * unknown，不能冒充「已确证只有引用内容是广告」并开启升级状态。
 */
async function classifyAdBundle(
  bundle: AdMessageBundle,
  judged: readonly AdCandidateEntry[]
): Promise<AdDetectionOutcome> {
  let combinedVerdict: AdVerdict | null;
  try {
    combinedVerdict = await classifyAdText({
      text: formatAdBundleText(judged),
      justJoined: bundle.justJoined,
    });
  } catch (error: unknown) {
    logger.error(
      `Ad detection failed to classify sender ${bundle.senderId} in chat ${bundle.chatId}:`,
      error
    );
    return { kind: "unknown" };
  }
  if (combinedVerdict === null) return { kind: "unknown" };
  if (!combinedVerdict.isAd) return { kind: "notAd" };
  if (!containsReferencedAdContent(judged)) {
    return { kind: "directAd", verdict: combinedVerdict };
  }

  const directText: string = formatDirectAdBundleText(judged);
  if (directText.length === 0) {
    return { kind: "referencedOnly", verdict: combinedVerdict };
  }
  try {
    const directVerdict: AdVerdict | null = await classifyAdText({
      text: directText,
      justJoined: bundle.justJoined,
    });
    if (directVerdict === null) {
      logger.error(
        `Ad detection could not attribute referenced content for sender ${bundle.senderId} ` +
        `in chat ${bundle.chatId}: the direct-content classifier returned no verdict.`
      );
      return { kind: "unknown" };
    }
    return directVerdict.isAd
      ? { kind: "directAd", verdict: directVerdict }
      : { kind: "referencedOnly", verdict: combinedVerdict };
  } catch (error: unknown) {
    logger.error(
      `Ad detection failed to attribute referenced content for sender ${bundle.senderId} ` +
      `in chat ${bundle.chatId}:`,
      error
    );
    return { kind: "unknown" };
  }
}

/**
 * 本次真正推进水位的最后一条消息在入队时冻结的警告窗口事实。送检前已确认至少有一条未判消息，
 * selectAdBundleEntries 把未判消息排在已判上下文之后，因此清单末尾就是这条消息。
 */
function selectedWithinReferencedWarning(selection: AdBundleSelection): boolean {
  return selection.entries.at(-1)?.withinReferencedWarning === true;
}

/**
 * 警告成功后只保留同群内 message_id 晚于公开提示的消息（以 Telegram 群内消息序列为准，
 * 不比较 receivedAt）。保留下来的内容立即排队，并按实际到达时刻冻结是否仍在警告窗口
 * （AD_REFERENCE_WARNING_WINDOW_MS）内。
 */
function retainPostWarningContent(
  bundle: AdMessageBundle,
  warning: TelegramWorkerTemporaryMessageSentResult
): void {
  const retainedEntries: AdCandidateEntry[] = [];
  for (const entry of bundle.entries) {
    if (entry.messageId <= warning.messageId) continue;
    // 入队时的跨条引文去重可能由一条即将被移除的警告前消息认领；拆串之后用
    // 保留下来的新前缀重新认领。
    if (entry.quote !== undefined || entry.replyTo !== undefined) {
      entry.text = claimSampleContextParts(
        entry.directText,
        entry,
        retainedEntries
      );
    }
    entry.withinReferencedWarning =
      entry.receivedAt - warning.sentAt < AD_REFERENCE_WARNING_WINDOW_MS;
    retainedEntries.push(entry);
  }
  bundle.entries = retainedEntries;

  let pendingIdWriteIndex: number = 0;
  for (const messageId of bundle.pendingDeleteIds) {
    if (messageId <= warning.messageId) continue;
    bundle.pendingDeleteIds[pendingIdWriteIndex] = messageId;
    pendingIdWriteIndex++;
  }
  bundle.pendingDeleteIds.length = pendingIdWriteIndex;

  if (
    bundle.entries.length === 0 &&
    bundle.pendingDeleteIds.length === 0
  ) {
    deletePendingAdBundle(bundle.chatId, bundle.senderId);
    refreshAdDetectCapacitySaturation();
  }
}

/**
 * 判定一个键并按结果处置。失败与「不是广告」都只推进 checkedSeq。
 */
export async function detectOne(
  key: string,
  bundle: AdMessageBundle
): Promise<void> {
  // 送检那一刻真正入选的条目与它对应的水位，**在 await 之前定格**：bundle 是活对象，
  // 往返期间新消息会并进 entries，裁剪也可能从头部去掉几条；样本与水位都取定格值，
  // 不按结算时的 latestSeq 推进。
  const selection: AdBundleSelection = selectAdBundleEntries(bundle);
  const judged: readonly AdCandidateEntry[] = selection.entries;
  const withinReferencedWarning: boolean = selectedWithinReferencedWarning(selection);
  let outcome: AdDetectionOutcome;
  let isAdmin: boolean | undefined;
  try {
    outcome = await classifyAdBundle(bundle, judged);
    // 管理员确证也在 in-flight 标记之内，标记释放前同一个键不会被下一拍取走。
    if (
      outcome.kind === "directAd" ||
      outcome.kind === "referencedOnly"
    ) isAdmin = await isAdminSender(bundle);
  } finally {
    inFlightAdDetectKeys.delete(key);
  }
  // 停机（adDetectStopping）之后才回来的判定直接丢弃：处置的后半截（拉黑落盘 + 各群
  // 封禁）在主线程，其 drainAdDisposals 已放行。
  if (adDetectStopping.current) return;
  if (outcome.kind === "directAd" || outcome.kind === "referencedOnly") {
    adVerdictTruePublishHolder.current?.({
      type: "adVerdictTrue",
      chatId: bundle.chatId,
      senderId: bundle.senderId,
    });
  }
  // 期间这个群可能被停管/关开关，整串已被丢弃或换成新对象；旧引用对不上就
  // 放弃本次判定（同本线程其余异步回调的「状态对象同一性」惯例）。判定在途时新串
  // 不会排队，这里替它补排一次。
  const current: AdMessageBundle | undefined = pendingAdBundle(bundle.chatId, bundle.senderId);
  if (current !== bundle) {
    if (current !== undefined) requeueIfUnchecked(key, current);
    return;
  }
  // 只推到本次真正送检的最后一条。预算装不下的那部分仍是未判内容，当前批结算后
  // requeueIfUnchecked 会立即把它排成下一批。
  bundle.checkedSeq = Math.max(bundle.checkedSeq, selection.checkedToSeq);
  if (outcome.kind === "notAd" || outcome.kind === "unknown") {
    // 在途期间到达的新内容此刻才取得入队认领：水位推进后，有未判内容才会排队。
    requeueIfUnchecked(key, bundle);
    return;
  }
  // 这一串照常留着，下一条新消息会重新排队，届时入队闸按已热的管理员缓存拦截。
  if (isAdmin !== false) {
    logger.error(
      `Ad detection flagged ${isAdmin === true ? "chat admin" : "unverified sender"} ${bundle.senderId} ` +
      `in chat ${bundle.chatId}; skipping disposal (${outcome.verdict.reason || "no reason given"}).`
    );
    // 确认是管理员就把整串丢掉；查询失败则只把本批记成已检，期间新到的未判内容
    // 重新排队。
    if (isAdmin === true) {
      deletePendingAdBundle(bundle.chatId, bundle.senderId);
      refreshAdDetectCapacitySaturation();
    } else {
      requeueIfUnchecked(key, bundle);
    }
    return;
  }
  if (outcome.kind === "referencedOnly" && !withinReferencedWarning) {
    const warningGeneration: number | undefined =
      beginReferencedAdWarning(key);
    if (warningGeneration === undefined) return;
    // 判定已经离开上面的 finally，警告取得 message_id 之前这段网络往返仍是同一个键的
    // 处置临界区，只覆盖发送本身；广告消息删除是独立任务（见 deleteReferencedAdMessages），
    // 不占分类并发槽。
    inFlightAdDetectKeys.add(key);
    try {
      let warningResult: TelegramWorkerTemporaryMessageResult | undefined;
      try {
        warningResult = await warnReferencedAdSender(bundle);
      } catch (error: unknown) {
        logger.error(
          `Ad detection failed to send referenced-ad warning for sender ${bundle.senderId} ` +
          `in chat ${bundle.chatId}:`,
          error
        );
      }
      if (
        warningResult !== undefined &&
        "suppressed" in warningResult
      ) {
        cancelReferencedAdWarning(key, warningGeneration);
        if (pendingAdBundle(bundle.chatId, bundle.senderId) === bundle) {
          deletePendingAdBundle(bundle.chatId, bundle.senderId);
          refreshAdDetectCapacitySaturation();
        }
        return;
      }
      const warning: TelegramWorkerTemporaryMessageSentResult | undefined =
        warningResult;
      if (warning === undefined) {
        cancelReferencedAdWarning(key, warningGeneration);
        if (
          !adDetectStopping.current &&
          pendingAdBundle(bundle.chatId, bundle.senderId) === bundle
        ) {
          deleteReferencedAdMessages({
            bundle,
            judged,
            messageIdThrough: Number.POSITIVE_INFINITY,
          });
        }
        return;
      }
      if (
        adDetectStopping.current ||
        pendingAdBundle(bundle.chatId, bundle.senderId) !== bundle ||
        !completeReferencedAdWarning(
          key,
          warningGeneration,
          warning.sentAt
        )
      ) {
        cancelReferencedAdWarning(key, warningGeneration);
        // 清群或停机使警告回执过期：立即撤掉已经发出的迟到提示，不再动用户消息。
        void deleteMessage(bundle.chatId, warning.messageId, telegramApi);
        return;
      }
      deleteReferencedAdMessages({
        bundle,
        judged,
        messageIdThrough: warning.messageId,
      });
      retainPostWarningContent(bundle, warning);
    } finally {
      inFlightAdDetectKeys.delete(key);
      if (!adDetectStopping.current) {
        // message_id 晚于警告的新消息已从旧串里保留下来，但发送临界区内不排队；
        // 警告结算后立刻补排。发送失败时旧 bundle 仍在，本批水位已推进，
        // 只有期间真有未检内容才会排。
        const current: AdMessageBundle | undefined = pendingAdBundle(bundle.chatId, bundle.senderId);
        if (current !== undefined) {
          requeueIfUnchecked(key, current);
        }
      }
    }
    return;
  }
  // 处置前先摘掉这一串，并把这个键记进逐 key TTL 已处置表：处置期间以及封禁真正
  // 落地之前抢跑进来的消息不再判定（见 docs/cn/04-invariants.md）。该 key TTL 到期时
  // 记录删除，之后由主线程黑名单门禁接管。
  deletePendingAdBundle(bundle.chatId, bundle.senderId);
  refreshAdDetectCapacitySaturation();
  // 硬顶与待检 key 同源（AD_DETECT_MAX_PENDING_SENDERS）：这张表只由处置路径写入，
  // 写入时直接限制容量；撑满时淘汰最早处置的键，其后续消息由主线程黑名单门禁接管。
  setBoundedMapValue({
    map: recentlyDisposedAdKeys,
    key,
    value: performance.now(),
    maxEntries: AD_DETECT_MAX_PENDING_SENDERS,
  });
  // 升级为 block 后旧警告失去用途，不再占着容量。
  referencedAdWarningStates.delete(key);
  await disposeAdSender({ bundle, verdict: outcome.verdict, judged });
}
