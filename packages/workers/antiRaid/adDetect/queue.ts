/**
 * 广告判定的排队与批处理（入群守卫线程侧）。
 *
 * 节奏由两道闸共同决定：
 * - 队列**只排发送者的键**（`chatId:userId`），消息串挂在 map 里。同一个人在
 *   等待期间新说的话直接并进他那一串，不会在队列里占第二个位置——「已取得一个
 *   待派发位置」由 queuedAdDetectKeys 独家表达，与队列同步增删，出队即释放。
 *   送检期间的新消息仍并串，由 inFlight 阻止并发，结算后把未判水位恰好重排一次。
 * - 调度器每 AD_DETECT_QUEUE_TICK_MS 从队首取至多 AD_DETECT_BATCH_SIZE 个键，
 *   一起 Promise.allSettled。这道闸是**整条线程的总量、不按群分配**：队列只有
 *   一条，各群的键混排走 FIFO，取键时不看 chatId。
 * 两道闸叠起来的效果是：刷屏的人吃不光额度，正常聊天的人不必等在他后面，而
 * 一次判定看到的是该 key 派发前已经并入的完整批次，而不是逐条并发送检。
 *
 * **节拍不做任何全表扫描**：这一拍取到的键顺路裁一次已判上下文，处置抑制记录
 * 读到即回收、容量由 setBoundedMapValue 顶住，剩下的死记录交给 5 分钟一次的
 * sweepAdDetect。曾经另有一张与队列并行的 TTL 认领表，它和处置抑制表一起挂在
 * 每一拍上，撑满时每秒白扫两张 8,192 条的表——那张认领表已经删掉（它表达的
 * 「已排队」本就由 queuedAdDetectKeys 全覆盖），按秒扫的理由也随之消失。
 *
 * 90 秒只约束处置抑制与已经消费的上下文：尚未判定的条目无论排队多久都不能
 * 过期；已判过的上下文暂留一个窗口，与后续拆开发的「加我 / 微信 / xxx」合并。
 * checkedSeq 记录已经消费到哪里，只有还有更大序号时才值得重新入队。
 *
 * **速率**：出队即释放待检位置、结算即补排，所以一个持续发言的人稳态是每
 * 「1 秒节拍 + 一次分类往返」判一次（约 3~4 秒），不是每 90 秒一次。全线程的
 * 上界只由 AD_DETECT_MAX_IN_FLIGHT（95）与每拍 AD_DETECT_BATCH_SIZE（35）封顶，
 * 即最坏约 35 次/秒的新建请求、95 个并发在途；几百人同时刷屏时这两道闸会长期
 * 顶格，这是设计意图而不是故障。调 provider 配额看这两个数，不要看 90 秒窗口。
 *
 * 判定失败（网络抖动、模型抽风、响应形状不对）一律当作「本次没判定」并把这
 * 一批记成已检：绝不猜一个 true 出来，也绝不无限重试——后者在 provider 侧
 * 故障时会把上面那个 35 次/秒的新建上界一直顶满，等于把一次故障放大成持续
 * 的请求风暴。
 *
 * 状态全在 cache/workers/antiRaid/adDetect.ts，随 Worker isolate 生死；崩溃重建后队列
 * 清空，主线程不做镜像（判定是尽力而为的启发式，不构成安全边界）。
 */

import { classifyAdText } from "./classifier";
import {
  deleteReferencedAdMessages,
  deleteStaleReferencedAdWarning,
  deleteStragglerAdMessage,
  disposeAdSender,
  warnReferencedAdSender,
} from "./disposal";
import { freshAdminIds, isChatAdmin } from "../adminCache";
import { logger } from "../../../infra/logger";
import {
  adDetectCapacitySaturated,
  adDetectPublishHolder,
  adDetectQueue,
  adDetectSaturated,
  adDetectStopping,
  adDetectTickTimer,
  inFlightAdDetectKeys,
  inFlightReferencedAdCleanupTasks,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_BATCH_SIZE,
  AD_DETECT_JUDGED_RETENTION_WINDOW_MS,
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_DETECT_QUEUE_TICK_MS,
  AD_REFERENCE_WARNING_WINDOW_MS,
} from "../../../consts/antiRaid/adDetect";
import { setBoundedMapValue } from "../../../libs/boundedMap";
import { sanitizeInline, truncateInline } from "../../../libs/text";
import {
  admitAdBundleStorage,
  admitAdCandidate,
  admitAdDispatch,
  admitAdRequeue,
  isNewAdBundleAtCapacity,
} from "../../../states/adDetectAdmission";
import {
  appendLinkUrls,
  boundSampleContext,
  claimSampleContextParts,
  containsReferencedAdContent,
  enforceBundleCapacity,
  formatAdBundleText,
  formatDirectAdBundleText,
  latestSeq,
  pruneConsumedContext,
  selectAdBundleEntries,
} from "./bundle";
import {
  beginReferencedAdWarning,
  cancelReferencedAdWarning,
  clearChatReferencedAdWarnings,
  clearReferencedAdWarning,
  completeReferencedAdWarning,
  hasActiveReferencedAdWarning,
  resetReferencedAdWarnings,
  sweepReferencedAdWarnings,
} from "./referencePolicy";
import type { AdBundleSelection } from "../../../types/antiRaid/adDetect";
import { verificationKey, verificationKeyPrefix } from "../../../libs/verificationKey";
import type { AdCandidateMessage, AdDetectedEvent, AdSampleContext } from "../../../types/antiRaid";
import type { AdCandidateEntry, AdMessageBundle, AdVerdict } from "../../../types/antiRaid/adDetect";
import type { TelegramWorkerTemporaryMessageResult } from "../../../types/telegramWorker";
import type {
  AdBundleStorageDecision,
  AdCandidateDecision,
  AdRequeueDecision,
} from "../../../types/states/adDetectAdmission";

/**
 * 键已经不在队列里、且还有没判过的消息时排队；已经排队或在途的键都不重复排。
 * 判据是纯标量的，与时钟无关——待检位置没有 TTL，排多久都不会自己过期。
 */
function requeueIfUnchecked(key: string, bundle: AdMessageBundle): void {
  const decision: AdRequeueDecision = admitAdRequeue({
    hasUncheckedContent: latestSeq(bundle) > bundle.checkedSeq,
    queued: queuedAdDetectKeys.has(key),
    inFlight: inFlightAdDetectKeys.has(key),
  });
  if (decision.action === "skip") return;
  // 两张表一起动，缺一张就会让「谁在待检」出现两个互相矛盾的答案，
  // 见 docs/cn/04-invariants.md。
  queuedAdDetectKeys.add(key);
  adDetectQueue.push(key);
}

/**
 * 按容量上界接纳一串新消息。已经入队的 key 必须留到至少一次判定尝试，满载时
 * 因此拒绝新的不同 key，而不是淘汰队首。返回 false 时调用方不得再写队列/Set。
 */
function storeBundle(
  key: string,
  bundle: AdMessageBundle
): boolean {
  const decision: AdBundleStorageDecision = admitAdBundleStorage({
    alreadyStored: pendingAdMessages.has(key),
    pendingSize: pendingAdMessages.size,
  });
  if (decision.action === "rejectAtCapacity") {
    noteAdDetectCapacitySaturation(true);
    return false;
  }
  pendingAdMessages.set(key, bundle);
  refreshAdDetectCapacitySaturation();
  return true;
}

/**
 * 处置抑制记录是否仍在自己的窗口内。
 *
 * 表里存的是**处置时刻**而不是失效时刻：窗口本来就是常量，少存一个字段就少
 * 一次每键分配，更要紧的是这样才判得出墙钟回拨——`now` 落在处置时刻之前只
 * 可能是时钟往回走了，继续按失效时刻比较会把抑制拉长到「回拨幅度 + 窗口」，
 * 那段时间里这些人的每条消息都被 ignore，判定对他们整体静默停摆。同
 * referencePolicy.ts 的 hasActiveReferencedAdWarning 与 sweepReferencedAdWarnings。
 */
function adDisposalMarkerActive(disposedAt: number, now: number): boolean {
  const elapsedMs: number = now - disposedAt;
  return elapsedMs >= 0 && elapsedMs < AD_DETECT_JUDGED_RETENTION_WINDOW_MS;
}

/**
 * 读取一个 key 的处置抑制状态；失效记录就地删除，避免逻辑过期但 Map 仍增长。
 * 每个 key 独立到期，读到即回收，因此不依赖任何周期扫描保证正确性。
 */
function hasActiveAdDisposalMarker(key: string, now: number): boolean {
  const disposedAt: number | undefined = recentlyDisposedAdKeys.get(key);
  if (disposedAt === undefined) return false;
  if (adDisposalMarkerActive(disposedAt, now)) return true;
  recentlyDisposedAdKeys.delete(key);
  return false;
}

/**
 * 回收已经过期的处置抑制记录。
 *
 * **不挂在 1 秒节拍上**：正确性由 hasActiveAdDisposalMarker 的读时回收保证，
 * 容量由 setBoundedMapValue 的硬顶保证，这里只是把「判过之后再没来过消息」
 * 的死记录从内存里清掉，5 分钟一次的维护 sweep 足够。过去它和一张并行的入队
 * 认领表一起挂在每一拍上，撑满时每秒要白扫两张 8,192 条的表——那张认领表已经
 * 删掉，剩下这一张也没有理由再按秒扫。
 */
export function expireAdDetectDisposalMarkers(now: number = Date.now()): void {
  for (const [key, disposedAt] of recentlyDisposedAdKeys) {
    if (!adDisposalMarkerActive(disposedAt, now)) recentlyDisposedAdKeys.delete(key);
  }
}

/**
 * 新发送者是否要被容量闸挡下。**纯 O(1)**：消息热路径上不做任何表扫描。
 */
function rejectNewAdBundleAtCapacity(): boolean {
  if (!isNewAdBundleAtCapacity(pendingAdMessages.size)) return false;
  noteAdDetectCapacitySaturation(true);
  return true;
}

/**
 * 收下一条待判定消息：并进该发送者的消息串，并保证他在队列里排着。
 * 判定本身是异步的，这里只做同步记账，不阻塞 mailbox。
 */
export function enqueueAdCandidate(message: AdCandidateMessage, now: number = Date.now()): void {
  const key: string = verificationKey(message.chatId, message.senderId);
  const existing: AdMessageBundle | undefined = pendingAdMessages.get(key);
  // 普通账号没有频道尾随消息要删：pending 已满时接不进新 bundle，先于处置抑制
  // 表查询返回。频道马甲仍须继续查 recentlyDisposed，命中时要删除这条抢跑广告。
  if (
    existing === undefined &&
    !message.blocked &&
    !message.isChannel &&
    pendingAdMessages.size >= AD_DETECT_MAX_PENDING_SENDERS
  ) {
    noteAdDetectCapacitySaturation(true);
    return;
  }
  const recentlyDisposed: boolean = hasActiveAdDisposalMarker(key, now);
  // 新普通 key 满载时不可以先分配清洗正文、URL 串和引用上下文。
  // blocked/recentlyDisposed 的频道马甲例外必须继续读正文，非空时要删掉尾随广告。
  if (
    existing === undefined &&
    !message.blocked &&
    !recentlyDisposed &&
    rejectNewAdBundleAtCapacity()
  ) return;
  // 裁剪提到接纳判定之前：下面那道引文去重要按「裁完之后这一串还剩哪些条目」算，
  // 否则会把一段引文认领给本次就要被回收的 entry，新来的这条跟着丢掉它。
  if (existing !== undefined) pruneConsumedContext(existing, now);
  // 被引用段/被回复原文与正文一起送检：广告的主流形态是「先发正常消息 → 隔一段
  // 时间编辑成广告 → 用回复/引用把它顶上来」，广告正文永远不在新消息的 text 里
  // （详见 bundle.ts 的 claimSampleContextParts，归因边界与跨条去重也写在那里）。
  const context: AdSampleContext | undefined =
    boundSampleContext(message.sampleContext);
  // 按码元硬切会把切点落在代理对中间：留下的孤立高位代理进模型提示词时
  // 被 UTF-8 编码换成 U+FFFD，还会原样写进 memory/ 的命中样本，运维复核误判时
  // 看到的是乱码而不是对方真正发的那个字。与同管线的 classifier.ts 用同一个
  // 代理对安全截断。
  const textWithLinks: string = appendLinkUrls(
    truncateInline(sanitizeInline(message.text), AD_DETECT_MESSAGE_MAX_CHARS),
    message.linkUrls
  );
  const text: string = context === undefined
    ? textWithLinks
    : claimSampleContextParts(
      textWithLinks,
      context,
      existing?.entries ?? []
    );
  const directText: string = message.isForwarded ? "" : textWithLinks;
  // 三道投递闸（没有可判定正文、已知管理员、自己的 TTL 内刚处置过）收在
  // states/adDetectAdmission.ts 里；这里只执行结论。
  const decision: AdCandidateDecision = admitAdCandidate({
    textLength: text.length,
    isChannel: message.isChannel,
    knownAdmin: freshAdminIds(message.chatId)?.has(message.senderId) === true,
    recentlyDisposed,
    blocked: message.blocked,
  });
  if (decision.action === "deleteStraggler") {
    deleteStragglerAdMessage(message.chatId, message.messageId);
    return;
  }
  if (decision.action === "ignore") return;

  const bundle: AdMessageBundle = existing ?? {
    chatId: message.chatId,
    senderId: message.senderId,
    label: message.label,
    meta: message.meta,
    isChannel: message.isChannel,
    justJoined: message.justJoined,
    entries: [],
    pendingDeleteIds: [],
    nextSeq: 1,
    checkedSeq: 0,
  };
  if (existing !== undefined) {
    // 昵称随时可改；播报要用最新的那个。
    bundle.label = message.label;
    bundle.meta = message.meta;
    // 取并集而不是覆盖：验证会在窗口内通过，先发广告后点验证的人不该洗白。
    bundle.justJoined ||= message.justJoined;
  }
  const entry: AdCandidateEntry = {
    messageId: message.messageId,
    seq: bundle.nextSeq++,
    text,
    directText,
    receivedAt: now,
    withinReferencedWarning: hasActiveReferencedAdWarning(key, now),
  };
  // 两段上下文已经并进上面的 text 参与判定；这里再留一份独立的，只服务命中
  // 样本——人回头查误判时要分得清哪一段是他自己写的、哪一段是引来的。
  if (context?.quote !== undefined) entry.quote = context.quote;
  if (context?.replyTo !== undefined) entry.replyTo = context.replyTo;
  bundle.entries.push(entry);
  enforceBundleCapacity(bundle);
  if (!storeBundle(key, bundle)) return;
  requeueIfUnchecked(key, bundle);
}

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
  warning: TelegramWorkerTemporaryMessageResult
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
async function detectOne(
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
      let warning: TelegramWorkerTemporaryMessageResult | undefined;
      try {
        warning = await warnReferencedAdSender(bundle);
      } catch (error: unknown) {
        logger.error(
          `Ad detection failed to send referenced-ad warning for sender ${bundle.senderId} ` +
          `in chat ${bundle.chatId}:`,
          error
        );
      }
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
  // 硬顶与待检 key 同源：这张表只由处置路径写入，没有任何入口闸替它把关，
  // 而节拍停掉（quiesce）或处置快过回收时它就是唯一一张会无限长的表。撑满时
  // 淘汰最早处置的那个——它的封禁早已落地，主线程黑名单门禁接管得了。
  setBoundedMapValue({
    map: recentlyDisposedAdKeys,
    key,
    value: Date.now(),
    maxEntries: AD_DETECT_MAX_PENDING_SENDERS,
  });
  clearReferencedAdWarning(key);
  await disposeAdSender({ bundle, verdict: outcome.verdict, judged });
}

/**
 * 封禁已在 Telegram 取得确定结果后立即释放该发送者的处置 TTL 记录。
 * 入队认领早在派发时释放；主线程黑名单已在封禁批次投递前落定，后续消息由
 * blocked 门禁接管。
 */
export function releaseAdDetectDedupKey(chatId: number, senderId: number): void {
  const key: string = verificationKey(chatId, senderId);
  // 非探测封禁批次也可能来自手工 /block 或入群秒踢；只有 direct-ad 处置
  // 写下的标记能证明这个 key 属于本链路，不能误拆仍在待检的普通 bundle。
  if (!recentlyDisposedAdKeys.delete(key)) return;
  refreshAdDetectCapacitySaturation();
}

/**
 * 记录撞上/离开全局在途闸的边沿。只在翻转时记一行，撑满期间每拍记一次会让
 * 日志自己变成第二个刷屏源。已接纳 key 的待检内容没有等待 TTL，被挡下时留在
 * 队首等容量恢复，因此这里只需要把持续积压的事实点名一次。
 */
function noteAdDetectSaturation(saturated: boolean): void {
  if (saturated === adDetectSaturated.current) return;
  adDetectSaturated.current = saturated;
  logger.error(saturated
    ? `Ad detection reached its ${AD_DETECT_MAX_IN_FLIGHT} in-flight ceiling; ` +
      `${adDetectQueue.size} accepted key(s) remain queued.`
    : "Ad detection dropped back below its in-flight ceiling."
  );
}

/** 记录待检 key 容量撞满/恢复的边沿，避免每条被拒消息都刷一行日志。 */
function noteAdDetectCapacitySaturation(saturated: boolean): void {
  if (saturated === adDetectCapacitySaturated.current) return;
  adDetectCapacitySaturated.current = saturated;
  logger.error(saturated
    ? `Ad detection reached its ${AD_DETECT_MAX_PENDING_SENDERS} pending-key ceiling; ` +
      "new distinct senders will be rejected until capacity recovers."
    : "Ad detection pending-key capacity recovered below its ceiling."
  );
}

/** 按待检表的现场刷新容量状态；它是唯一一张会撞上接纳硬顶的表。 */
function refreshAdDetectCapacitySaturation(): void {
  noteAdDetectCapacitySaturation(
    pendingAdMessages.size >= AD_DETECT_MAX_PENDING_SENDERS
  );
}

/**
 * 跑一个节拍：从队首取至多一批键并发送检。
 *
 * **刻意不登记进 Worker 的在途任务集合**（trackAntiRaidTask）：那个集合是停机
 * drain 的等待对象，而 drain 的预算是 ANTI_RAID_DRAIN_TIMEOUT_MS 这一档的秒级
 * 数值，一次判定请求却可以耗到广告检测 provider 的 30 秒请求超时（还要乘上
 * 空正文重试）。登记进去的话，凡是停机时恰好有一次判定在途，drain 必然超时
 * ——生命周期据此拒绝确认 Telegram offset 并以非零状态退出，等于每次撞上都
 * 换来一次脏退出加一批 update 重投。判定是尽力而为的启发式，本来就不该扣着
 * 停机不放；真正不可丢的那一半（拉黑 + 各群封禁登记）在主线程，由
 * drainAntiRaid 每轮等待 inFlightAdDisposals 收口（见 antiRaid/adCandidate.ts）。
 * @returns 本批全部结算的 Promise；调用方（节拍与测试）自行决定要不要等。
 */
export function runAdDetectBatch(now: number = Date.now()): Promise<void> {
  const tasks: Promise<void>[] = [];
  let saturated: boolean = false;
  for (let taken: number = 0; taken < AD_DETECT_BATCH_SIZE; taken++) {
    // 全局在途闸（判定见 states/adDetectAdmission.ts）：判断排在 shift 之前——
    // 先取出来再发现发不掉，那个键就从队列里消失了，而它未必还有下一条新消息
    // 把自己重新排进来。
    if (admitAdDispatch({ inFlight: inFlightAdDetectKeys.size }).action === "saturated") {
      saturated = true;
      break;
    }
    const key: string | undefined = adDetectQueue.shift();
    if (key === undefined) break;
    // 出队即释放待检位置：这一行和上面的 shift 是同一件事的两半，缺一半就会
    // 让「谁在待检」出现两个互相矛盾的答案（见 docs/cn/04-invariants.md）。
    queuedAdDetectKeys.delete(key);
    const bundle: AdMessageBundle | undefined = pendingAdMessages.get(key);
    if (bundle === undefined) continue;
    // 顺手裁掉窗口外的已判上下文。这一拍取到的键都在这里过一遍，因此不需要
    // 任何按秒跑的全表回收；排在 35 名之后的键等轮到自己或 5 分钟 sweep。
    pruneConsumedContext(bundle, now);
    if (bundle.entries.length === 0) {
      pendingAdMessages.delete(key);
      refreshAdDetectCapacitySaturation();
      continue;
    }
    // 上一次判定还没回来（上一个节拍的请求超时了）：让它自己收尾并重新入队，
    // 同一个人不并发送检两次。
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
 * 但没有登记进在途任务集合，因此不会拖住 drain（理由见 runAdDetectBatch）。
 * 队列与消息串原样保留——它们随 isolate 一起消失，没必要在退出路径上多做清理。
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
 * 属于这个群的键一并摘掉：留着只会让重新开启开关后的头一个 TTL 白白哑火。
 */
export function clearChatAdDetect(chatId: number): void {
  const prefix: string = verificationKeyPrefix(chatId);
  adDetectQueue.removeWhere((key: string): boolean => key.startsWith(prefix));
  for (const key of queuedAdDetectKeys) {
    if (key.startsWith(prefix)) queuedAdDetectKeys.delete(key);
  }
  for (const [key, bundle] of pendingAdMessages) {
    if (bundle.chatId !== chatId) continue;
    pendingAdMessages.delete(key);
  }
  for (const key of recentlyDisposedAdKeys.keys()) {
    if (key.startsWith(prefix)) recentlyDisposedAdKeys.delete(key);
  }
  clearChatReferencedAdWarnings(chatId);
  refreshAdDetectCapacitySaturation();
}

/**
 * 5 分钟一次的维护回收：裁掉窗口外已经消费完的上下文，删掉整串判完又不在
 * 排队/在途的空 bundle，并清理过期的处置抑制记录。未消费条目没有等待 TTL。
 *
 * 还留着未判内容的消息串在这里补排一次。既不在队列、也不在途的 bundle 没有
 * 任何其它力量会把它排回去——旧的 rotateAdDetectDedupWindow 靠每 90 秒清空
 * 整张认领表把所有未判串重排一遍，那张表删掉之后这条自愈职责落在这里。
 * requeueIfUnchecked 自己会跳过已排队和在途的键，所以无条件调用是安全的；
 * 它兜的是异常态，不是常规调度路径——常规路径上补排由 detectOne 结算时发起。
 */
export function sweepAdDetect(now: number = Date.now()): void {
  expireAdDetectDisposalMarkers(now);
  for (const [key, bundle] of pendingAdMessages) {
    pruneConsumedContext(bundle, now);
    if (
      bundle.entries.length === 0 &&
      !queuedAdDetectKeys.has(key) &&
      !inFlightAdDetectKeys.has(key)
    ) {
      pendingAdMessages.delete(key);
      continue;
    }
    requeueIfUnchecked(key, bundle);
  }
  sweepReferencedAdWarnings(now);
  refreshAdDetectCapacitySaturation();
}

/** Worker 启动入口：登记回投通道并挂上唯一批处理节拍。 */
export function startAdDetectQueue(publish: (event: AdDetectedEvent) => void): void {
  adDetectStopping.current = false;
  adDetectPublishHolder.current = publish;
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
  adDetectQueue.clear();
  queuedAdDetectKeys.clear();
  recentlyDisposedAdKeys.clear();
  resetReferencedAdWarnings();
  pendingAdMessages.clear();
  inFlightAdDetectKeys.clear();
  inFlightReferencedAdCleanupTasks.clear();
  adDetectSaturated.current = false;
  adDetectCapacitySaturated.current = false;
  // stop 是「清掉全部状态」：quiesce 那面旗要留着挡迟到的判定，走到 stop 时
  // 状态已整体作废，旗一并归零，下一次 start 从干净状态起步。
  adDetectStopping.current = false;
}
