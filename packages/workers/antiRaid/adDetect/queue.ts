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
 * 读到即回收、容量由 setBoundedMapValue 顶住，其余到期记录交给 5 分钟一次的
 * sweepAdDetect。待派发所有权只由 queuedAdDetectKeys 与队列同步表达。
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
 * 的请求风暴（判定与处置的编排本身在 verdict.ts）。
 *
 * 本文件是这条链路的入口与节拍：`enqueueAdCandidate` 收下一条消息，
 * `runAdDetectBatch` 每拍派发一批，其余是 quiesce、清群、维护 sweep 与启停。
 * 接纳侧的判定——排队认领、容量接纳、处置抑制读取、饱和边沿记账——收在
 * queueState.ts，本文件一律调用它，不自己重写那几条判据；派发出队与 teardown
 * 清表是队列自身的调度语义，仍在本文件直接操作那几张表。
 *
 * 状态全在 cache/workers/antiRaid/adDetect.ts，随 Worker isolate 生死；崩溃重建后队列
 * 清空，主线程不做镜像（判定是尽力而为的启发式，不构成安全边界）。
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
  adDetectCapacitySaturated,
  adDetectSaturated,
} from "../../../cache/workers/antiRaid/adDetect";
import {
  AD_DETECT_BATCH_SIZE,
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_DETECT_QUEUE_TICK_MS,
} from "../../../consts/antiRaid/adDetect";
import { sanitizeInline, truncateInline } from "../../../libs/text";
import { admitAdCandidate, admitAdDispatch } from "../../../states/adDetectAdmission";
import {
  appendLinkUrls,
  boundSampleContext,
  claimSampleContextParts,
  EMPTY_AD_CANDIDATE_ENTRIES,
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
  expireAdDetectDisposalMarkers,
  hasActiveAdDisposalMarker,
  noteAdDetectCapacitySaturation,
  noteAdDetectSaturation,
  refreshAdDetectCapacitySaturation,
  rejectNewAdBundleAtCapacity,
  requeueIfUnchecked,
  storeBundle,
} from "./queueState";
import { detectOne } from "./verdict";
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
  // 已知管理员（用户身份）在投递闸里恒判 ignore，与正文长短无关，而判据是纯
  // O(1) 的缓存查表。提到正文清洗之前，理由与上面那道容量闸完全相同——结论
  // 已经确定的消息不该先做 sanitize/truncate/URL 拼接/引文认领。频道马甲不适用
  // 本豁免：它没有「群成员」身份，判据是
  // isChannel 而不是 id 在不在表里，仍交给下面的投递闸按 blocked/处置抑制分派。
  //
  // 传本条消息的 now，让同一条消息的两处判定落在同一时刻（同
  // auto/message/index.ts 的「本条消息统一的『现在』」）。
  const knownAdmin: boolean =
    freshAdminIds(message.chatId, now)?.has(message.senderId) === true;
  if (knownAdmin && !message.isChannel) return;
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
      existing?.entries ?? EMPTY_AD_CANDIDATE_ENTRIES
    );
  const directText: string = message.isForwarded ? "" : textWithLinks;
  // 三道投递闸（没有可判定正文、已知管理员、自己的 TTL 内刚处置过）收在
  // states/adDetectAdmission.ts 里；这里只执行结论。
  const decision: AdCandidateDecision = admitAdCandidate({
    textLength: text.length,
    isChannel: message.isChannel,
    knownAdmin,
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
    quote: context?.quote,
    replyTo: context?.replyTo,
  };
  // 两段上下文已经并进上面的 text 参与判定；这里再留一份独立的，只服务命中
  // 样本——人回头查误判时要分得清哪一段是他自己写的、哪一段是引来的。
  bundle.entries.push(entry);
  enforceBundleCapacity(bundle);
  storeBundle(key, bundle);
  requeueIfUnchecked(key, bundle);
}

/**
 * 跑一个节拍：从队首取至多一批键并发送检。
 *
 * **刻意不登记进 Worker 的在途任务集合**（trackAntiRaidTask）：那个集合是停机
 * drain 的等待对象，而 drain 的预算是 ANTI_RAID_DRAIN_TIMEOUT_MS 这一档的秒级
 * 数值，一次判定请求却可以耗到分钟级——两个 provider 的 30 秒请求超时都是每次
 * SDK 尝试各自的期限，还要乘上各自的 SDK 尝试次数与空正文重试。登记进去的话，
 * 凡是停机时恰好有一次判定在途，drain 必然超时——生命周期据此拒绝确认 Telegram
 * offset 并以非零状态退出，等于每次撞上都换来一次脏退出加一批 update 重投。
 * 判定是尽力而为的启发式，本来就不该扣着停机不放；真正不可丢的那一半
 * （拉黑 + 各群封禁登记）在主线程，由 drainAntiRaid 每轮等待
 * inFlightAdDisposals 收口（见 antiRaid/adCandidate.ts）。
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
  for (const [key, bundle] of pendingAdMessages) {
    if (bundle.senderId === identityId) pendingAdMessages.delete(key);
  }
  for (const key of recentlyDisposedAdKeys.keys()) {
    if (belongsToIdentity(key)) recentlyDisposedAdKeys.delete(key);
  }
  clearIdentityReferencedAdWarnings(identityId);
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
export function startAdDetectQueue(
  publish: (event: AdDetectedEvent) => void,
  publishVerdictTrue?: (event: AdVerdictTrueEvent) => void
): void {
  adDetectStopping.current = false;
  adDetectPublishHolder.current = publish;
  adVerdictTruePublishHolder.current = publishVerdictTrue ?? null;
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
  pendingAdMessages.clear();
  inFlightAdDetectKeys.clear();
  inFlightReferencedAdCleanupTasks.clear();
  adDetectSaturated.current = false;
  adDetectCapacitySaturated.current = false;
  // stop 是「清掉全部状态」：quiesce 那面旗要留着挡迟到的判定，走到 stop 时
  // 状态已整体作废，旗一并归零，下一次 start 从干净状态起步。
  adDetectStopping.current = false;
}
