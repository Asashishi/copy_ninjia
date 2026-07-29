/**
 * 广告判定的排队与批处理（入群守卫线程侧）。
 *
 * 节奏由三道闸共同决定：
 * - 队列**只排发送者的键**（`chatId:userId`），消息串挂在 map 里。同一个人在
 *   等待期间新说的话直接并进他那一串，不会在队列里占第二个位置。
 * - 键级去重跨整个 AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS 窗口生效
 *   （recentlyEnqueuedAdKeys）：一个人在一个窗口里最多判一次，窗口内后续的话
 *   只进消息串。窗口到点整表清空，仍攒着未判定内容的键在那一刻重新排一次
 *   ——这是那些消息唯一的重排时机，清空后不补排就等于永远不判它们。
 * - 调度器每 AD_DETECT_QUEUE_TICK_MS 从队首取至多 AD_DETECT_BATCH_SIZE 个键，
 *   一起 Promise.allSettled。这道闸是**整条线程的总量、不按群分配**：队列只有
 *   一条，各群的键混排走 FIFO，取键时不看 chatId。
 * 三道闸叠起来的效果是：刷屏的人吃不光额度，正常聊天的人不必等在他后面，而
 * 一次判定看到的是他这个窗口里说过的全部内容，而不是逐条各判一次。
 *
 * 90 秒只约束入队去重与已经消费的上下文：尚未判定的条目无论排队多久都不能
 * 过期；已判过的上下文暂留一个窗口，与后续拆开发的「加我 / 微信 / xxx」合并。
 * checkedSeq 记录已经消费到哪里，只有还有更大序号时才值得重新入队。
 *
 * 判定失败（网络抖动、模型抽风、响应形状不对）一律当作「本次没判定」并把这
 * 一批记成已检：绝不猜一个 true 出来，也绝不无限重试——后者在 DeepSeek 侧
 * 故障时就是一场每秒 15 发的请求风暴。
 *
 * 状态全在 cache/antiRaid/adDetect.ts，随 Worker isolate 生死；崩溃重建后队列
 * 清空，主线程不做镜像（判定是尽力而为的启发式，不构成安全边界）。
 */

import { classifyAdText } from "./classifier";
import { deleteStragglerAdMessage, disposeAdSender } from "./disposal";
import { freshAdminIds, fetchAdminIds } from "../adminCache";
import { logger } from "../../../infra/logger";
import {
  adDetectCapacitySaturated,
  adDetectDedupTimer,
  adDetectPublishHolder,
  adDetectQueue,
  adDetectSaturated,
  adDetectStopping,
  adDetectTickTimer,
  inFlightAdDetectKeys,
  pendingAdMessages,
  queuedAdDetectKeys,
  recentlyDisposedAdKeys,
  recentlyEnqueuedAdKeys,
} from "../../../cache/antiRaid/adDetect";
import {
  AD_DETECT_BATCH_SIZE,
  AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS,
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_DETECT_QUEUE_TICK_MS,
} from "../../../consts/antiRaid/adDetect";
import { sanitizeInline } from "../../../libs/text";
import {
  admitAdBundleStorage,
  admitAdCandidate,
  admitAdDispatch,
  admitAdRequeue,
} from "../../../states/adDetectAdmission";
import {
  appendLinkUrls,
  boundSampleContext,
  enforceBundleCapacity,
  formatAdBundleText,
  latestSeq,
  pruneConsumedContext,
  selectAdBundleEntries,
} from "./bundle";
import type { AdBundleSelection } from "./bundle";
import { verificationKey } from "../../../libs/verificationKey";
import type { AdCandidateMessage, AdDetectedEvent } from "../../../types/antiRaid";
import type { AdCandidateEntry, AdMessageBundle, AdVerdict } from "../../../types/antiRaid/adDetect";
import type {
  AdBundleStorageDecision,
  AdCandidateDecision,
  AdRequeueDecision,
} from "../../../types/states/adDetectAdmission";

/**
 * 键已经不在队列里、且还有没判过的消息时排队；在途的键与本窗口已经排过的键
 * 都不再排——后者正是「一个人一个窗口只判一次」这道闸，他这期间说的话只会
 * 并进消息串，等窗口轮换时连同上下文一起判。
 */
function requeueIfUnchecked(key: string, bundle: AdMessageBundle): void {
  const decision: AdRequeueDecision = admitAdRequeue({
    hasUncheckedContent: latestSeq(bundle) > bundle.checkedSeq,
    queued: queuedAdDetectKeys.has(key),
    inFlight: inFlightAdDetectKeys.has(key),
    recentlyEnqueued: recentlyEnqueuedAdKeys.has(key),
    dedupWindowSize: recentlyEnqueuedAdKeys.size,
  });
  if (decision.action === "skip") return;
  if (decision.action === "rejectAtCapacity") {
    noteAdDetectCapacitySaturation(true);
    return;
  }
  // 三张表一起动，缺一张就会让「谁在待检」出现两个互相矛盾的答案，
  // 见 docs/04-invariants.md。
  recentlyEnqueuedAdKeys.add(key);
  queuedAdDetectKeys.add(key);
  adDetectQueue.push(key);
}

/**
 * 按容量上界接纳一串新消息。已经入队的 key 必须留到至少一次判定尝试，满载时
 * 因此拒绝新的不同 key，而不是淘汰队首。返回 false 时调用方不得再写队列/Set。
 */
function storeBundle(key: string, bundle: AdMessageBundle): boolean {
  const decision: AdBundleStorageDecision = admitAdBundleStorage({
    alreadyStored: pendingAdMessages.has(key),
    pendingSize: pendingAdMessages.size,
    dedupWindowSize: recentlyEnqueuedAdKeys.size,
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
 * 轮换入队去重窗口：清空两张窗口表，并把仍攒着未判定内容的键重新排一次。
 *
 * 补排这一步不能省。窗口内的第二条及之后的消息都只是并进消息串、没有自己的
 * 入队机会，清空去重表是它们唯一的重排时机；只清表不补排，一个人只有窗口里
 * 的第一条会被判定，「加我 / 微信 xxx / 带你上岸」这种拆开发的广告就永远停在
 * 第一条的无害判定上。
 */
export function rotateAdDetectDedupWindow(): void {
  recentlyEnqueuedAdKeys.clear();
  recentlyDisposedAdKeys.clear();
  for (const [key, bundle] of pendingAdMessages) requeueIfUnchecked(key, bundle);
  refreshAdDetectCapacitySaturation();
}

/**
 * 收下一条待判定消息：并进该发送者的消息串，并保证他在队列里排着。
 * 判定本身是异步的，这里只做同步记账，不阻塞 mailbox。
 */
export function enqueueAdCandidate(message: AdCandidateMessage, now: number = Date.now()): void {
  const text: string = appendLinkUrls(
    sanitizeInline(message.text).slice(0, AD_DETECT_MESSAGE_MAX_CHARS),
    message.linkUrls
  );
  const key: string = verificationKey(message.chatId, message.senderId);
  // 三道投递闸（没有可判定正文、已知管理员、本窗口刚处置过）收在
  // states/adDetectAdmission.ts 里；这里只执行结论。
  const decision: AdCandidateDecision = admitAdCandidate({
    textLength: text.length,
    isChannel: message.isChannel,
    knownAdmin: freshAdminIds(message.chatId)?.has(message.senderId) === true,
    recentlyDisposed: recentlyDisposedAdKeys.has(key),
    blocked: message.blocked,
  });
  if (decision.action === "deleteStraggler") {
    deleteStragglerAdMessage(message.chatId, message.messageId);
    return;
  }
  if (decision.action === "ignore") return;

  const existing: AdMessageBundle | undefined = pendingAdMessages.get(key);
  const bundle: AdMessageBundle = existing ?? {
    chatId: message.chatId,
    senderId: message.senderId,
    label: message.label,
    isChannel: message.isChannel,
    justJoined: message.justJoined,
    entries: [],
    pendingDeleteIds: [],
    nextSeq: 1,
    checkedSeq: 0,
  };
  if (existing !== undefined) {
    pruneConsumedContext(bundle, now);
    // 昵称随时可改；播报要用最新的那个。
    bundle.label = message.label;
    // 取并集而不是覆盖：验证会在窗口内通过，先发广告后点验证的人不该洗白。
    bundle.justJoined ||= message.justJoined;
  }
  bundle.entries.push({
    messageId: message.messageId,
    seq: bundle.nextSeq++,
    text,
    receivedAt: now,
    // 只随命中样本落盘，判定读的始终只有 text（见 antiRaid/adDetect.ts 的
    // buildSampleContext）。长度在本线程再收一次，理由见 boundSampleContext。
    ...boundSampleContext(message.sampleContext),
  });
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
  // 管理员在主线程投递入口就已经挡掉了（见 antiRaid/adDetect.ts）。
  if (bundle.isChannel) return false;
  const cached: Set<number> | undefined = freshAdminIds(bundle.chatId);
  if (cached !== undefined) return cached.has(bundle.senderId);
  try {
    return (await fetchAdminIds(bundle.chatId)).has(bundle.senderId);
  } catch (error: unknown) {
    logger.error(`Failed to check admin exemption for sender ${bundle.senderId} in chat ${bundle.chatId}:`, error);
    return undefined;
  }
}

/**
 * 判定一个键并按结果处置。失败与「不是广告」都只推进 checkedSeq：前者是
 * 为了不在故障期间反复重试，后者是正常的放行。
 */
async function detectOne(key: string, bundle: AdMessageBundle): Promise<void> {
  let verdict: AdVerdict | null;
  // 管理员豁免：处置是不可逆的（永久黑名单 + 每个托管群封禁 + revoke_messages），
  // 恢复要人工 /unblock 再逐群解封，因此「拿不准」一律按不处置办——查不出身份
  // 时放过一条广告，代价远小于误封群主。
  let isAdmin: boolean | undefined;
  // 送检那一刻真正入选的条目与它对应的水位，**必须在 await 之前定格**：bundle 是
  // 活对象，这次往返期间新消息会并进同一个 entries 数组、裁剪也可能从头部去掉几条。
  // 拿处置时的现场当「判定依据」写进样本，复现出来的就是模型没读过的一串；水位同理
  // ——按结算时的 latestSeq 推进，就会把这期间新说的话一并记成判过。
  const selection: AdBundleSelection = selectAdBundleEntries(bundle);
  const judged: readonly AdCandidateEntry[] = selection.entries;
  try {
    verdict = await classifyAdText({ text: formatAdBundleText(judged), justJoined: bundle.justJoined });
    // 确证也要待在 in-flight 标记之内：标记一放，同一个键就可能被下一拍取走
    // 再判一次，两次判定各自跑完一整套处置。
    if (verdict?.isAd === true) isAdmin = await isAdminSender(bundle);
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
  // 只推到本次真正送检的最后一条。预算装不下的那部分仍是未判内容，requeueIfUnchecked
  // 会把这个键留到去重窗口轮换时再判一次（见 rotateAdDetectDedupWindow）。
  bundle.checkedSeq = Math.max(bundle.checkedSeq, selection.checkedToSeq);
  if (verdict?.isAd !== true) {
    requeueIfUnchecked(key, bundle);
    return;
  }
  // 这一串照常留着，下一条新消息会重新排队；缓存这时已经热了，届时在入队闸
  // 就挡得住。
  if (isAdmin !== false) {
    logger.error(
      `Ad detection flagged ${isAdmin === true ? "chat admin" : "unverified sender"} ${bundle.senderId} ` +
      `in chat ${bundle.chatId}; skipping disposal (${verdict.reason || "no reason given"}).`
    );
    // 确认是管理员就把整串丢掉：留着只会在下一个窗口把同样的内容再判一次。
    if (isAdmin === true) {
      pendingAdMessages.delete(key);
      refreshAdDetectCapacitySaturation();
    }
    return;
  }
  // 处置前先摘掉这一串，并把这个键记进本窗口的已处置表：处置期间以及封禁真正
  // 落地之前抢跑进来的消息，都属于「已经在被清算的人」，再判一次只会换来第二
  // 次完全相同的拉黑与各群封禁登记（每一次都要整份 outbox 落盘，见
  // docs/04-invariants.md）。窗口轮换时这条记录会随表清掉，那时主线程的黑名单
  // 门禁早已接管。
  pendingAdMessages.delete(key);
  refreshAdDetectCapacitySaturation();
  recentlyDisposedAdKeys.add(key);
  await disposeAdSender({ bundle, verdict, judged });
}

/**
 * 记录撞上/离开全局在途闸的边沿。只在翻转时记一行，撑满期间每拍记一次会让
 * 日志自己变成第二个刷屏源。已接纳 key 没有等待 TTL，被挡下时留在队首等容量
 * 恢复，因此这里只需要把持续积压的事实点名一次。
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

/** 按两张接纳所有权表的现场刷新容量状态。 */
function refreshAdDetectCapacitySaturation(): void {
  noteAdDetectCapacitySaturation(
    pendingAdMessages.size >= AD_DETECT_MAX_PENDING_SENDERS ||
    recentlyEnqueuedAdKeys.size >= AD_DETECT_MAX_PENDING_SENDERS
  );
}

/**
 * 跑一个节拍：从队首取至多一批键并发送检。
 *
 * **刻意不登记进 Worker 的在途任务集合**（trackAntiRaidTask）：那个集合是停机
 * drain 的等待对象，而 drain 的预算是 ANTI_RAID_BARRIER_TIMEOUT_MS 这一档的秒级
 * 数值，一次判定请求却可以耗到 DEEPSEEK_REQUEST_TIMEOUT_MS（20 秒，还要乘上
 * 空正文重试）。登记进去的话，凡是停机时恰好有一次判定在途，drain 必然超时
 * ——生命周期据此拒绝确认 Telegram offset 并以非零状态退出，等于每次撞上都
 * 换来一次脏退出加一批 update 重投。判定是尽力而为的启发式，本来就不该扣着
 * 停机不放；真正不可丢的那一半（拉黑 + 各群封禁登记）在主线程，由
 * drainAntiRaid 每轮等待 inFlightAdDisposals 收口（见 antiRaid/adDetect.ts）。
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
    queuedAdDetectKeys.delete(key);
    const bundle: AdMessageBundle | undefined = pendingAdMessages.get(key);
    if (bundle === undefined) continue;
    pruneConsumedContext(bundle, now);
    if (bundle.entries.length === 0) {
      pendingAdMessages.delete(key);
      refreshAdDetectCapacitySaturation();
      continue;
    }
    // 上一次判定还没回来（上一个节拍的请求超时了）：让它自己收尾并重新入队，
    // 同一个人不并发送检两次。
    if (inFlightAdDetectKeys.has(key)) continue;
    if (latestSeq(bundle) <= bundle.checkedSeq) continue;
    inFlightAdDetectKeys.add(key);
    tasks.push(detectOne(key, bundle));
  }
  noteAdDetectSaturation(saturated);
  if (tasks.length === 0) return Promise.resolve();
  return Promise.allSettled(tasks).then((): void => undefined);
}

/**
 * 停机 quiesce：停掉两个 timer，不再开始新的判定。在途的那一次照常自己收尾，
 * 但没有登记进在途任务集合，因此不会拖住 drain（理由见 runAdDetectBatch）。
 * 队列与消息串原样保留——它们随 isolate 一起消失，没必要在退出路径上多做清理。
 */
export function quiesceAdDetectQueue(): void {
  adDetectStopping.current = true;
  if (adDetectTickTimer.current !== null) {
    clearInterval(adDetectTickTimer.current);
    adDetectTickTimer.current = null;
  }
  if (adDetectDedupTimer.current !== null) {
    clearInterval(adDetectDedupTimer.current);
    adDetectDedupTimer.current = null;
  }
}

/**
 * 丢掉某个群尚未送检的消息串；在途的那一次由同一性检查自行作废。两张窗口表里
 * 属于这个群的键一并摘掉：留着只会让重新开启开关后的头一个窗口白白哑火。
 */
export function clearChatAdDetect(chatId: number): void {
  const prefix: string = `${chatId}:`;
  adDetectQueue.removeWhere((key: string): boolean => key.startsWith(prefix));
  for (const key of queuedAdDetectKeys) {
    if (key.startsWith(prefix)) queuedAdDetectKeys.delete(key);
  }
  for (const [key, bundle] of pendingAdMessages) {
    if (bundle.chatId !== chatId) continue;
    pendingAdMessages.delete(key);
  }
  for (const key of recentlyEnqueuedAdKeys) {
    if (key.startsWith(prefix)) recentlyEnqueuedAdKeys.delete(key);
  }
  for (const key of recentlyDisposedAdKeys) {
    if (key.startsWith(prefix)) recentlyDisposedAdKeys.delete(key);
  }
  refreshAdDetectCapacitySaturation();
}

/**
 * 回收去重窗口外已经消费完的上下文。未消费条目没有等待 TTL；只有整串已经
 * 判过、又不在排队/在途时才能把空 bundle 删除。
 */
export function sweepAdDetect(now: number = Date.now()): void {
  for (const [key, bundle] of pendingAdMessages) {
    pruneConsumedContext(bundle, now);
    if (
      bundle.entries.length === 0 &&
      !queuedAdDetectKeys.has(key) &&
      !inFlightAdDetectKeys.has(key)
    ) {
      pendingAdMessages.delete(key);
    }
  }
  refreshAdDetectCapacitySaturation();
}

/** Worker 启动入口：登记回投通道并挂上批处理节拍与去重窗口轮换。 */
export function startAdDetectQueue(publish: (event: AdDetectedEvent) => void): void {
  adDetectStopping.current = false;
  adDetectPublishHolder.current = publish;
  if (adDetectTickTimer.current !== null) return;
  adDetectTickTimer.current = setInterval((): void => {
    void runAdDetectBatch();
  }, AD_DETECT_QUEUE_TICK_MS);
  adDetectTickTimer.current.unref();
  adDetectDedupTimer.current = setInterval(rotateAdDetectDedupWindow, AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS);
  adDetectDedupTimer.current.unref();
}

/** 协作式停止：清掉两个 timer 与全部队列状态；强制 terminate 时随 isolate 一起没。 */
export function stopAdDetectQueue(): void {
  quiesceAdDetectQueue();
  adDetectPublishHolder.current = null;
  adDetectQueue.clear();
  queuedAdDetectKeys.clear();
  recentlyEnqueuedAdKeys.clear();
  recentlyDisposedAdKeys.clear();
  pendingAdMessages.clear();
  inFlightAdDetectKeys.clear();
  adDetectSaturated.current = false;
  adDetectCapacitySaturated.current = false;
  // stop 是「清掉全部状态」：quiesce 那面旗要留着挡迟到的判定，走到 stop 时
  // 状态已整体作废，旗一并归零，下一次 start 从干净状态起步。
  adDetectStopping.current = false;
}
