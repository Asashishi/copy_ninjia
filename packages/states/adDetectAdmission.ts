import { ACCEPT_CANDIDATE, IGNORE_CANDIDATE, DELETE_STRAGGLER, ENQUEUE_KEY, SKIP_ENQUEUE, DISPATCH, SATURATED } from "../consts/antiRaid/admission";
import {
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../consts/antiRaid/adDetect";
import type {
  AdCandidateAdmissionInput,
  AdCandidateDecision,
  AdDispatchDecision,
  AdDispatchInput,
  AdRequeueDecision,
  AdRequeueInput,
} from "../types/states/adDetectAdmission";

/**
 * 投递闸：一条新到的候选消息该不该并进这个发送者的消息串。
 *
 * 管理员只在缓存**明确**认得时挡（knownAdmin）：缓存冷时照常送检，判定命中后
 * 还有一道以 getChatAdministrators 为准的确证闸兜底，这里只是把已知管理员的
 * 消息挡在额度之外。
 *
 * recentlyDisposed 命中时通常直接忽略——处置已经发出，主线程正在把人写进黑
 * 名单，再攒一串重判只会换来第二次完全相同的处置。**频道马甲是例外**：
 * banChatSenderChat 没有 revoke_messages，这段跨线程空档里频道新发的广告既不
 * 会被那次封禁带走，也不会再有第二次判定来删它，不顺手删掉就永久留在群里。
 *
 * blocked 走的是同一条例外。recentlyDisposed 按每个 key 各自的去重 TTL 存活；
 * blocked 覆盖的「已拉黑但封禁还没落地」可以跨多个 TTL 存在（秒踢、补扫、
 * 更早判定登记的封禁批次都会先写名单再等 outbox 落盘与 mailbox 屏障），而且不止
 * 由本次判定产生。用户身份不需要这条：banChatMember 带 revoke_messages，落地
 * 时会把这段 TTL 内的消息一起撤掉。两者都不进判定额度——名单里的人结局已定，
 * 再判一次只会换来一模一样的处置。
 */
export function admitAdCandidate(input: AdCandidateAdmissionInput): AdCandidateDecision {
  if (input.textLength === 0) return IGNORE_CANDIDATE;
  if (!input.isChannel && input.knownAdmin) return IGNORE_CANDIDATE;
  if (input.blocked || input.recentlyDisposed) {
    return input.isChannel ? DELETE_STRAGGLER : IGNORE_CANDIDATE;
  }
  return ACCEPT_CANDIDATE;
}

/**
 * 排队闸：这个键该不该（重新）排进队列。
 *
 * 「这个 key 已取得一个待派发位置」由 queuedAdDetectKeys 独家表达：它随
 * adDetectQueue 同步增删，排着的人再说什么都只并进消息串。判定在途期间由
 * inFlight 单独防止并发送检，派发到结算之间的空档因此也是封住的。
 *
 * 这里不需要容量闸：能走到这一步的键必定已经在 pendingAdMessages 里（容量在
 * 那道闸就判完了），而每个键在队列里最多占一个位置，队列长度因此天然被待检
 * 表的硬顶兜住。
 * @param input.hasUncheckedContent 由调用方比较 latestSeq 与 checkedSeq 得出；
 *   本函数不认识 bundle。
 */
export function admitAdRequeue(input: AdRequeueInput): AdRequeueDecision {
  if (!input.hasUncheckedContent) return SKIP_ENQUEUE;
  if (input.queued || input.inFlight) return SKIP_ENQUEUE;
  return ENQUEUE_KEY;
}

/**
 * 容量闸：新发送者是否已撞上全局硬顶。
 *
 * 已经入队的键必须留到至少一次判定尝试，因此满载时拒绝**新的不同键**而不是
 * 淘汰队首——FIFO 淘汰会让先到的人在从没被判过一次的情况下消失。已有键的后续
 * 消息不占新名额，由调用方按 `existing !== undefined` 直接跳过本闸。
 *
 * 只读标量、不构造决策对象：判定跑在每条开着广告检测的群消息上，要能在清洗
 * 正文、URL 和引用上下文之前零载荷分配早退。全线程只有 enqueueAdCandidate
 * 一处问它（见 workers/antiRaid/adDetect/queue.ts），问完即已决定去留，
 * storeBundle 不再重复判一次。
 */
export function isNewAdBundleAtCapacity(pendingSize: number): boolean {
  return pendingSize >= AD_DETECT_MAX_PENDING_SENDERS;
}

/**
 * 在途闸：这一拍还能不能再起一次判定。
 *
 * 批大小只限每拍**起**多少个，拦不住「上一批还没回来就再起一批」，因此这道闸
 * 按全局在途数算、不按群分配。调用方必须在把键从队列里取出**之前**问：先取
 * 出来再发现发不掉，那个键就从队列里消失了，而它未必还有下一条新消息把自己
 * 重新排进来。
 */
export function admitAdDispatch(input: AdDispatchInput): AdDispatchDecision {
  return input.inFlight >= AD_DETECT_MAX_IN_FLIGHT ? SATURATED : DISPATCH;
}
