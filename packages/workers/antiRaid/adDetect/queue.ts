/**
 * 广告判定的排队与批处理（入群守卫线程侧）。
 *
 * 节奏由两道闸共同决定：
 * - 队列**只排发送者的键**（`chatId:userId`），消息串挂在 map 里。同一个人在
 *   等待期间新说的话直接并进他那一串，不在队列里占第二个位置；「已取得一个
 *   待派发位置」由 queuedAdDetectKeys 独家表达，与队列同步增删，出队即释放。
 *   送检期间的新消息仍并串，由 inFlight 阻止并发，结算后把未判水位恰好重排一次。
 * - 调度器每 AD_DETECT_QUEUE_TICK_MS 从队首取至多 AD_DETECT_BATCH_SIZE 个键，
 *   一起 Promise.allSettled。这道闸是**整条线程的总量、不按群分配**：队列只有
 *   一条，各群的键混排走 FIFO，取键时不看 chatId。
 * 一次判定看到的是该 key 派发前已经并入的完整批次，而不是逐条并发送检。
 *
 * **节拍不做任何全表扫描**：这一拍取到的键顺路裁一次已判上下文，处置抑制记录
 * 读到即回收、容量由 setBoundedMapValue 顶住，其余到期记录交给维护 sweep
 * （sweepAdDetect）。待派发所有权只由 queuedAdDetectKeys 与队列同步表达。
 *
 * AD_DETECT_JUDGED_RETENTION_WINDOW_MS 只约束处置抑制与已经消费的上下文：尚未判定的
 * 条目无论排队多久都不过期；已判过的上下文暂留一个窗口，与后续拆开发的
 * 「加我 / 微信 / xxx」合并。checkedSeq 记录已经消费到哪里，只有还有更大序号时才重新入队。
 *
 * **速率**：出队即释放待检位置、结算即补排，所以一个持续发言的人稳态是每
 * 「一个节拍 + 一次分类往返」判一次，而不是每个保留窗口一次。全线程的
 * 上界只由 AD_DETECT_MAX_IN_FLIGHT 与每拍 AD_DETECT_BATCH_SIZE 封顶；几百人同时刷屏时
 * 这两道闸会长期顶格。调 provider 配额看这两个常量，不看保留窗口。
 *
 * 判定失败（网络抖动、模型抽风、响应形状不对）一律当作「本次没判定」并把这
 * 一批记成已检：不猜 true，也不重试（判定与处置的编排本身在 verdict.ts）。
 *
 * 本文件是这条链路的入口与节拍：`enqueueAdCandidate` 收下一条消息，
 * `runAdDetectBatch` 每拍派发一批，其余是 quiesce、清群、维护 sweep 与启停。
 * 接纳侧的判定——排队认领、容量接纳、处置抑制读取、饱和边沿记账——收在
 * queueState.ts，本文件调用它；派发出队与 teardown 清表是队列自身的调度语义，
 * 在本文件直接操作那几张表。
 *
 * 状态全在 cache/workers/antiRaid/adDetect.ts，随 Worker isolate 生死；崩溃重建后队列
 * 清空，主线程不做镜像。
 */

import { deleteStragglerAdMessage } from "./disposal";
import { freshAdminIds } from "../adminCache";
import {
  adDetectPublishHolder,
  adVerdictTruePublishHolder,
  adDetectQueue,
  adDetectStopping,
  adDetectTickTimer,
  inFlightAdDetectKeys,
  inFlightReferencedAdCleanupTasks,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
  referencedAdWarningStates,
  adDetectCapacitySaturated,
  adDetectSaturated,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_BATCH_SIZE,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_DETECT_QUEUE_TICK_MS,
  EMPTY_AD_CANDIDATE_ENTRIES,
} from "../../../consts/antiRaid/adDetect";
import { truncateInline } from "../../../libs/text";
import {
  admitAdCandidate,
  isAdDispatchSaturated,
  isKnownAdminCandidate,
} from "../../../states/adDetectAdmission";
import {
  appendLinkUrls,
  boundSampleContext,
  claimSampleContextParts,
  enforceBundleCapacity,
  latestSeq,
  pruneConsumedContext,
} from "./bundle";
import {
  clearChatReferencedAdWarnings,
  clearIdentityReferencedAdWarnings,
  hasActiveReferencedAdWarning,
  resetReferencedAdWarnings,
  sweepReferencedAdWarnings,
} from "./referencePolicy";
import {
  clearPendingAdBundles,
  deletePendingAdBundle,
  deletePendingAdBundlesInChat,
  deletePendingAdBundlesOfSender,
  expireAdDetectDisposalMarkers,
  hasActiveAdDisposalMarker,
  noteAdDetectSaturation,
  pendingAdBundle,
  pendingAdBundleForKey,
  refreshAdDetectCapacitySaturation,
  rejectNewAdBundleAtCapacity,
  requeueIfUnchecked,
  storeBundle,
} from "./queueState";
import { detectOne } from "./verdict";
import { formatAdSenderName } from "./senderName";
import type {
  AdCandidateEntry,
  AdCandidateMessage,
  AdDetectedEvent,
  AdVerdictTrueEvent,
  AdMessageBundle,
  AdSampleContext,
} from "../../../types/antiRaid/adDetect";
import {
  parseVerificationKey,
  verificationKey,
  verificationKeyPrefix,
} from "../../../libs/verificationKey";
import type { AdCandidateDecision } from "../../../types/states/adDetectAdmission";
import type { TelegramIdentityMetadata } from "../../../types/identityPolicy";

/** 把候选平铺的发送者元数据组装成消息串与处置事件共用的元数据对象。 */
function candidateIdentityMetadata(
  message: AdCandidateMessage
): Readonly<TelegramIdentityMetadata> {
  return {
    firstName: message.firstName,
    lastName: message.lastName,
    username: message.username,
  };
}

/**
 * 收下一条待判定消息：并进该发送者的消息串，并保证他在队列里排着。
 * 判定本身是异步的，这里只做同步记账，不阻塞 mailbox。
 *
 * @param now 缺省取候选自带的主线程观测时刻（见 AdCandidateMessage.observedAt）；
 *   本线程不为每条候选另读一次墙钟。只有基准与单测显式覆盖它。
 */
export function enqueueAdCandidate(
  message: AdCandidateMessage,
  now: number = message.observedAt
): void {
  const existing: AdMessageBundle | undefined = pendingAdBundle(message.chatId, message.senderId);
  // pending 已满时普通账号接不进新 bundle，先于处置抑制表查询返回；频道马甲仍须
  // 查 recentlyDisposed，命中时删除这条抢跑广告。
  if (
    existing === undefined &&
    !message.blocked &&
    !message.isChannel &&
    rejectNewAdBundleAtCapacity()
  ) return;
  // 键只在用得到时拼：已有串直接取 bundle.key；处置抑制表与引用警告表空着时（常态）
  // 不必查，新发送者也只在建串时拼一次。
  let key: string | undefined = existing?.key;
  const recentlyDisposed: boolean = recentlyDisposedAdKeys.size > 0 &&
    hasActiveAdDisposalMarker(key ??= verificationKey(message.chatId, message.senderId));
  // 新普通 key 满载时不分配清洗正文、URL 串和引用上下文；
  // blocked/recentlyDisposed 的频道马甲例外，继续读正文，非空时删掉尾随广告。
  if (
    existing === undefined &&
    !message.blocked &&
    !recentlyDisposed &&
    rejectNewAdBundleAtCapacity()
  ) return;
  // 裁剪在接纳判定之前：下面的引文去重按裁完之后串里剩下的条目计算。
  if (existing !== undefined) pruneConsumedContext(existing, now);
  // 管理员闸排在正文清洗之前（判据见 states/adDetectAdmission.ts 的
  // isKnownAdminCandidate）。传本条消息的 now，让同一条消息的两处判定落在同一
  // 时刻（同 auto/message/index.ts 的「本条消息统一的『现在』」）。
  if (isKnownAdminCandidate(
    message.isChannel,
    freshAdminIds(message.chatId, now)?.has(message.senderId) === true
  )) return;
  // 被引用段/被回复原文与正文一起送检
  // （详见 bundle.ts 的 claimSampleContextParts，归因边界与跨条去重也写在那里）。
  const context: AdSampleContext | undefined =
    boundSampleContext(message.sampleQuote, message.sampleReplyTo);
  // truncateInline 按代理对安全截断，与同管线的 classifier.ts 一致。
  const textWithLinks: string = appendLinkUrls(
    truncateInline(message.text, AD_DETECT_MESSAGE_MAX_CHARS),
    message.linkUrls
  );
  // 已有串且姓与名都没变时为串里已算好的送检姓名，否则为 undefined。
  const knownSenderName: string | undefined =
    existing?.meta.firstName === message.firstName && existing.meta.lastName === message.lastName
      ? existing.senderName
      : undefined;
  const senderName: string = message.isChannel ? "" : knownSenderName ?? formatAdSenderName(message);
  const senderText: string = senderName.length === 0
    ? textWithLinks
    : textWithLinks.length === 0 ? senderName : `${senderName} ${textWithLinks}`;
  const text: string = context === undefined
    ? senderText
    : claimSampleContextParts(
      senderText,
      context,
      existing?.entries ?? EMPTY_AD_CANDIDATE_ENTRIES
    );
  const directText: string = message.isForwarded ? senderName : senderText;
  // 只重复已认领引文且姓名未变时没有新内容；改名则必须留下当次姓名重新送检。
  const onlyKnownName: boolean = text === senderName && knownSenderName !== undefined && (existing?.entries.length ?? 0) > 0;
  // 投递闸（没有可判定正文、已拉黑或自己的 TTL 内刚处置过）收在
  // states/adDetectAdmission.ts 里；这里只执行结论。
  const decision: AdCandidateDecision = admitAdCandidate({
    textLength: onlyKnownName ? 0 : text.length,
    isChannel: message.isChannel,
    recentlyDisposed,
    blocked: message.blocked,
  });
  if (decision === "deleteStraggler") {
    deleteStragglerAdMessage(message.chatId, message.messageId);
    return;
  }
  if (decision === "ignore") return;

  const bundle: AdMessageBundle = existing ?? {
    key: key ?? verificationKey(message.chatId, message.senderId),
    chatId: message.chatId,
    senderId: message.senderId,
    meta: candidateIdentityMetadata(message),
    senderName,
    isChannel: message.isChannel,
    justJoined: message.justJoined,
    entries: [],
    pendingDeleteIds: [],
    pendingDeleteOverflowed: false,
    uncheckedEvicted: false,
    nextSeq: 1,
    checkedSeq: 0,
  };
  if (existing !== undefined) {
    // 元数据取最新昵称，只在变化时重新组装；送检姓名随之换成本条算出的那个。
    if (knownSenderName === undefined || bundle.meta.username !== message.username) {
      bundle.meta = candidateIdentityMetadata(message);
      bundle.senderName = senderName;
    }
    // justJoined 取并集。
    bundle.justJoined ||= message.justJoined;
  }
  const entry: AdCandidateEntry = {
    messageId: message.messageId,
    seq: bundle.nextSeq++,
    text,
    directText,
    receivedAt: now,
    withinReferencedWarning: referencedAdWarningStates.size > 0 &&
      hasActiveReferencedAdWarning(bundle.key, now),
    quote: context?.quote,
    replyTo: context?.replyTo,
  };
  // 两段上下文已并进 text 参与判定；独立留一份，只服务命中样本。
  bundle.entries.push(entry);
  enforceBundleCapacity(bundle);
  if (existing === undefined) storeBundle(bundle);
  requeueIfUnchecked(bundle.key, bundle);
}

/**
 * 跑一个节拍：从队首取至多一批键并发送检。
 *
 * **不登记进 Worker 的在途任务集合**（trackAntiRaidTask）：该集合是停机 drain 的
 * 等待对象，在途判定不拖住 drain。判定是尽力而为的启发式；不可丢的那一半
 * （拉黑 + 各群封禁登记）在主线程，由 drainAntiRaid 每轮经 drainAdDisposals 等待
 * inFlightAdDisposals 收口（见 antiRaid/durableDelivery.ts、antiRaid/adDetect.ts）。
 * @returns 本批全部结算的 Promise；调用方（节拍与测试）自行决定要不要等。
 */
export function runAdDetectBatch(now: number = Date.now()): Promise<void> {
  const tasks: Promise<void>[] = [];
  let saturated: boolean = false;
  for (let taken: number = 0; taken < AD_DETECT_BATCH_SIZE; taken++) {
    // 全局在途闸（判定见 states/adDetectAdmission.ts）排在 shift 之前，闸满时键留在队列里。
    if (isAdDispatchSaturated(inFlightAdDetectKeys.size)) {
      saturated = true;
      break;
    }
    const key: string | undefined = adDetectQueue.shift();
    if (key === undefined) break;
    // 出队即释放待检位置，与上面的 shift 成对（见 docs/cn/04-invariants.md）。
    queuedAdDetectKeys.delete(key);
    const bundle: AdMessageBundle | undefined = pendingAdBundleForKey(key);
    if (bundle === undefined) continue;
    // 顺手裁掉窗口外的已判上下文；未取到的键等轮到自己或维护 sweep。
    pruneConsumedContext(bundle, now);
    if (bundle.entries.length === 0) {
      deletePendingAdBundle(bundle.chatId, bundle.senderId);
      refreshAdDetectCapacitySaturation();
      continue;
    }
    // 复核：requeueIfUnchecked 保证在途的键不会同时排在队列里，正常路径不会走到
    // 这里；走到时由在途的那次自己收尾并重新入队，同一个人不并发送检。
    if (inFlightAdDetectKeys.has(key)) continue;
    // 整串都判过：这一拍没有要送检的内容。已判上下文留给 sweep 按窗口回收，
    // 期间新消息会自己重新排队。
    if (latestSeq(bundle) <= bundle.checkedSeq) continue;
    // 占住 inFlight 再送检：后续消息会并入 bundle，由 inFlight 挡住第二次
    // 并发送检，直到 detectOne 结算。
    inFlightAdDetectKeys.add(key);
    tasks.push(detectOne(key, bundle));
  }
  noteAdDetectSaturation(saturated);
  if (tasks.length === 0) return Promise.resolve();
  return Promise.allSettled(tasks).then((): void => undefined);
}

/**
 * 停机 quiesce：停掉批处理 timer，不再开始新的判定。在途的那一次照常自己收尾，
 * 但没有登记进在途任务集合，不会拖住 drain（见 runAdDetectBatch）。
 * 队列与消息串原样保留。
 */
export function quiesceAdDetectQueue(): void {
  adDetectStopping.current = true;
  if (adDetectTickTimer.current !== null) {
    clearInterval(adDetectTickTimer.current);
    adDetectTickTimer.current = null;
  }
}

/**
 * 丢掉某个群尚未送检的消息串；在途的那一次由同一性检查自行作废。两张 TTL 表里
 * 属于这个群的键一并摘掉。
 */
export function clearChatAdDetect(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  adDetectQueue.removeWhere((key: string): boolean => key.startsWith(prefix));
  for (const key of queuedAdDetectKeys) {
    if (key.startsWith(prefix)) queuedAdDetectKeys.delete(key);
  }
  deletePendingAdBundlesInChat(chatId);
  for (const key of recentlyDisposedAdKeys.keys()) {
    if (key.startsWith(prefix)) recentlyDisposedAdKeys.delete(key);
  }
  clearChatReferencedAdWarnings(chatId);
  refreshAdDetectCapacitySaturation();
}

/**
 * 某身份获得临时广告检测豁免时，丢掉它在各群尚未结算的广告状态。
 * 在途判定由 pendingAdMessages 的对象同一性复查作废。
 */
export function clearIdentityAdDetect(identityId: number): void {
  const belongsToIdentity = (key: string): boolean =>
    parseVerificationKey(key)?.userId === identityId;
  adDetectQueue.removeWhere(belongsToIdentity);
  for (const key of queuedAdDetectKeys) {
    if (belongsToIdentity(key)) queuedAdDetectKeys.delete(key);
  }
  deletePendingAdBundlesOfSender(identityId);
  for (const key of recentlyDisposedAdKeys.keys()) {
    if (belongsToIdentity(key)) recentlyDisposedAdKeys.delete(key);
  }
  clearIdentityReferencedAdWarnings(identityId);
  refreshAdDetectCapacitySaturation();
}

/**
 * 维护回收（挂在 Worker 的统一 sweep 节拍上）：裁掉窗口外已经消费完的上下文，
 * 删掉整串判完又不在排队/在途的空 bundle，并清理过期的处置抑制记录。未消费条目没有等待 TTL。
 *
 * 还留着未判内容、既不在队列也不在途的消息串在这里补排一次。
 * requeueIfUnchecked 自己会跳过已排队和在途的键，所以无条件调用是安全的；
 * 这里兜异常态，常规路径上的补排由 detectOne 结算时发起。补排按待检表的
 * 遍历顺序进队：群按首次建表顺序，群内按发送者首次入表顺序。
 */
export function sweepAdDetect(now: number = Date.now()): void {
  expireAdDetectDisposalMarkers();
  for (const bundles of pendingAdMessages.values()) {
    for (const bundle of bundles.values()) {
      pruneConsumedContext(bundle, now);
      if (
        bundle.entries.length === 0 &&
        !queuedAdDetectKeys.has(bundle.key) &&
        !inFlightAdDetectKeys.has(bundle.key)
      ) {
        deletePendingAdBundle(bundle.chatId, bundle.senderId);
        continue;
      }
      requeueIfUnchecked(bundle.key, bundle);
    }
  }
  sweepReferencedAdWarnings(now);
  refreshAdDetectCapacitySaturation();
}

/** Worker 启动入口：登记回投通道并挂上唯一批处理节拍。 */
export function startAdDetectQueue(
  publish: (event: AdDetectedEvent) => void,
  publishVerdictTrue: (event: AdVerdictTrueEvent) => void
): void {
  adDetectStopping.current = false;
  adDetectPublishHolder.current = publish;
  adVerdictTruePublishHolder.current = publishVerdictTrue;
  if (adDetectTickTimer.current !== null) return;
  adDetectTickTimer.current = setInterval((): void => {
    void runAdDetectBatch();
  }, AD_DETECT_QUEUE_TICK_MS);
  adDetectTickTimer.current.unref();
}

/** 协作式停止：清掉 timer 与全部队列状态；强制 terminate 时随 isolate 一起没。 */
export function stopAdDetectQueue(): void {
  quiesceAdDetectQueue();
  adDetectPublishHolder.current = null;
  adVerdictTruePublishHolder.current = null;
  adDetectQueue.clear();
  queuedAdDetectKeys.clear();
  recentlyDisposedAdKeys.clear();
  resetReferencedAdWarnings();
  clearPendingAdBundles();
  inFlightAdDetectKeys.clear();
  inFlightReferencedAdCleanupTasks.clear();
  adDetectSaturated.current = false;
  adDetectCapacitySaturated.current = false;
  // stop 清掉全部状态，quiesce 置位的 adDetectStopping 一并归零，下一次 start 从干净状态起步。
  adDetectStopping.current = false;
}
