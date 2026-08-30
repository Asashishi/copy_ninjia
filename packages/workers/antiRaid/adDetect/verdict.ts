/**
 * 一个待检 key 的判定编排与处置（入群守卫线程侧）。
 *
 * 送检前定格本次入选的条目与水位，判定回来后按四态归因分派：不是广告、没判出
 * 结论、直接发广告、只有引用内容是广告。四态之外不猜——判定失败一律只推进
 * 已检水位，绝不冒充确证。
 *
 * 判定期间新到的消息会并进同一个 bundle，由 inFlight 标记挡住第二次并发送检；
 * 结算后由 queueState.ts 的 requeueIfUnchecked 把未判水位恰好重排一次。
 * 派发节拍与生命周期在 queue.ts。
 */

import { classifyAdText } from "./classifier";
import {
  deleteReferencedAdMessages,
  deleteStaleReferencedAdWarning,
  disposeAdSender,
  warnReferencedAdSender,
} from "./disposal";
import { isChatAdmin } from "../adminCache";
import { logger } from "../../../infra/logger";
import {
  adVerdictTruePublishHolder,
  adDetectStopping,
  inFlightAdDetectKeys,
  pendingAdMessages,
  recentlyDisposedAdKeys,
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
  clearReferencedAdWarning,
  completeReferencedAdWarning,
} from "./referencePolicy";
import {
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
 * 判定命中才查，且优先用缓存——绝大多数命中都是普通刷屏号，缓存在入群守卫
 * 那边本来就热。缓存冷时现拉一次全量管理员：一次判定命中换一次
 * getChatAdministrators 是值得的，处置本身不可逆。
 * @returns true=确认是管理员；false=确认不是；undefined=没查出来。
 */
async function isAdminSender(bundle: AdMessageBundle): Promise<boolean | undefined> {
  // 频道马甲没有「群成员」身份，管理员表里不会有它；拿当前群当皮套的匿名
  // 管理员在主线程投递入口就已经挡掉了（见 antiRaid/adCandidate.ts）。这一条
  // 是广告链路独有的前置，三态查询本身共用 adminCache 的 isChatAdmin。
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

/** 本次真正推进水位的最后一条消息在入队时冻结的警告窗口事实。 */
function selectedWithinReferencedWarning(
  selection: AdBundleSelection,
  previousCheckedSeq: number
): boolean {
  for (let index: number = selection.entries.length - 1; index >= 0; index--) {
    const entry: AdCandidateEntry | undefined = selection.entries[index];
    if (entry !== undefined && entry.seq > previousCheckedSeq) {
      return entry.withinReferencedWarning;
    }
  }
  return false;
}

/**
 * 警告成功后只保留同群内 message_id 晚于公开提示的消息。发送回执与 Worker
 * mailbox 存在短暂交错窗口，本机 receivedAt 可能早于回执时钟；Telegram 的群内
 * 消息序列才是「用户是否已经看得到警告」的权威顺序。保留下来的内容立即排队，
 * 同时按实际到达时刻冻结是否仍在五分钟内。
 */
function retainPostWarningContent(
  key: string,
  bundle: AdMessageBundle,
  warning: TelegramWorkerTemporaryMessageSentResult
): void {
  const retainedEntries: AdCandidateEntry[] = [];
  for (const entry of bundle.entries) {
    if (entry.messageId <= warning.messageId) continue;
    // 入队时的跨条引文去重可能由一条即将被移除的警告前消息认领。拆串之后必须
    // 用保留下来的新前缀重新认领，否则连续回复同一条广告时，警告后的 entry
    // 会只剩「看看」之类正文，模型再也读不到被回复广告。
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
    pendingAdMessages.delete(key);
    refreshAdDetectCapacitySaturation();
  }
}

/**
 * 判定一个键并按结果处置。失败与「不是广告」都只推进 checkedSeq：前者是
 * 为了不在故障期间反复重试，后者是正常的放行。
 */
export async function detectOne(
  key: string,
  bundle: AdMessageBundle
): Promise<void> {
  // 送检那一刻真正入选的条目与它对应的水位，**必须在 await 之前定格**：bundle 是
  // 活对象，这次往返期间新消息会并进同一个 entries 数组、裁剪也可能从头部去掉几条。
  // 拿处置时的现场当「判定依据」写进样本，复现出来的就是模型没读过的一串；水位同理
  // ——按结算时的 latestSeq 推进，就会把这期间新说的话一并记成判过。
  const previousCheckedSeq: number = bundle.checkedSeq;
  const selection: AdBundleSelection = selectAdBundleEntries(bundle);
  const judged: readonly AdCandidateEntry[] = selection.entries;
  const withinReferencedWarning: boolean =
    selectedWithinReferencedWarning(selection, previousCheckedSeq);
  let outcome: AdDetectionOutcome;
  let isAdmin: boolean | undefined;
  try {
    outcome = await classifyAdBundle(bundle, judged);
    // 确证也要待在 in-flight 标记之内：标记一放，同一个键就可能被下一拍取走
    // 再判一次，两次判定各自跑完一整套处置。
    if (
      outcome.kind === "directAd" ||
      outcome.kind === "referencedOnly"
    ) isAdmin = await isAdminSender(bundle);
  } finally {
    inFlightAdDetectKeys.delete(key);
  }
  // 关灯之后才回来的判定：处置的后半截（拉黑落盘 + 各群封禁）在主线程，而那边
  // 的 drainAdDisposals 早已放行、落盘线程可能已 terminate。照常处置换来的是
  // 一条「已在所有群封掉」的播报配一条根本没落盘的黑名单。判定本就是尽力而为，
  // 停机时丢一次不构成安全边界失守。
  if (adDetectStopping.current) return;
  if (outcome.kind === "directAd" || outcome.kind === "referencedOnly") {
    adVerdictTruePublishHolder.current?.({
      type: "adVerdictTrue",
      chatId: bundle.chatId,
      senderId: bundle.senderId,
    });
  }
  // 期间这个群可能被停管/关开关，整串已被丢弃或换成了新对象；旧引用对不上就
  // 放弃（同本线程其余异步回调的「状态对象同一性」惯例）。
  if (pendingAdMessages.get(key) !== bundle) return;
  // 只推到本次真正送检的最后一条。预算装不下的那部分仍是未判内容，当前批结算后
  // requeueIfUnchecked 会立即把它排成下一批。
  bundle.checkedSeq = Math.max(bundle.checkedSeq, selection.checkedToSeq);
  if (outcome.kind === "notAd" || outcome.kind === "unknown") {
    // 在途期间到达的新内容此刻才取得下一次入队认领，TTL 必须从结算时刻起算，
    // 不能把 provider 往返时间从新一代认领里扣掉。
    requeueIfUnchecked(key, bundle);
    return;
  }
  // 这一串照常留着，下一条新消息会重新排队；缓存这时已经热了，届时在入队闸
  // 就挡得住。
  if (isAdmin !== false) {
    logger.error(
      `Ad detection flagged ${isAdmin === true ? "chat admin" : "unverified sender"} ${bundle.senderId} ` +
      `in chat ${bundle.chatId}; skipping disposal (${outcome.verdict.reason || "no reason given"}).`
    );
    // 确认是管理员就把整串丢掉：留着只会把同样的内容再判一次。查询失败则只把
    // 本批记成已检，期间新到的未判内容仍须重新排队。
    if (isAdmin === true) {
      pendingAdMessages.delete(key);
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
    // 判定已经离开上面的 finally，但警告尚未取得 message_id；这段网络往返仍是
    // 同一个键的处置临界区。它只覆盖发送本身；广告消息删除已经拆成独立任务，
    // 不再拿分类并发槽等待 deleteMessages 的 429 退避。
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
        if (pendingAdMessages.get(key) === bundle) {
          pendingAdMessages.delete(key);
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
          pendingAdMessages.get(key) === bundle
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
        pendingAdMessages.get(key) !== bundle ||
        !completeReferencedAdWarning(
          key,
          warningGeneration,
          warning.sentAt
        )
      ) {
        cancelReferencedAdWarning(key, warningGeneration);
        deleteStaleReferencedAdWarning(bundle.chatId, warning.messageId);
        return;
      }
      deleteReferencedAdMessages({
        bundle,
        judged,
        messageIdThrough: warning.messageId,
      });
      retainPostWarningContent(key, bundle, warning);
    } finally {
      inFlightAdDetectKeys.delete(key);
      if (!adDetectStopping.current) {
        // message_id 晚于警告的新消息已经从旧串里保留下来，但在发送临界区里不会排队；
        // 警告结算后立刻补排。发送失败时旧 bundle 仍在，但本批水位已经推进，
        // 只有期间真有未检内容才会排，避免把 Telegram 故障放大成警告重试风暴。
        const current: AdMessageBundle | undefined = pendingAdMessages.get(key);
        if (current !== undefined) {
          requeueIfUnchecked(key, current);
        }
      }
    }
    return;
  }
  // 处置前先摘掉这一串，并把这个键记进逐 key TTL 已处置表：处置期间以及封禁真正
  // 落地之前抢跑进来的消息，都属于「已经在被清算的人」，再判一次只会换来第二
  // 次完全相同的拉黑与各群封禁登记（每一次都要整份 outbox 落盘，见
  // docs/cn/04-invariants.md）。该 key TTL 到期时记录会删除，那时主线程黑名单
  // 门禁早已接管。
  pendingAdMessages.delete(key);
  refreshAdDetectCapacitySaturation();
  // 硬顶与待检 key 同源：这张表只由处置路径写入，没有独立入口闸，因此写入时
  // 直接限制容量；撑满时淘汰最早处置的键，其后续消息由主线程黑名单门禁接管。
  setBoundedMapValue({
    map: recentlyDisposedAdKeys,
    key,
    value: Date.now(),
    maxEntries: AD_DETECT_MAX_PENDING_SENDERS,
  });
  clearReferencedAdWarning(key);
  await disposeAdSender({ bundle, verdict: outcome.verdict, judged });
}
