import {
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../consts/antiRaid/adDetect";
import type {
  AdCandidateAdmissionInput,
  AdCandidateDecision,
  AdRequeueDecision,
  AdRequeueInput,
} from "../types/states/adDetectAdmission";

/**
 * 管理员闸：发送者是否为本群已知管理员，其消息不参与广告判定。
 *
 * 仅当 Worker 侧管理员缓存明确认得该发送者时拦截；缓存冷时照常送检，判定命中后由以
 * getChatAdministrators 为准的确证闸处理。频道马甲不适用，交给投递闸按 blocked/处置抑制分派。
 *
 * 判据只读两个标量，排在正文清洗之前（调用方见 workers/antiRaid/adDetect/queue.ts 的 enqueueAdCandidate）。
 * @param knownAdmin Worker 侧管理员缓存明确认得这个发送者；缓存冷时为 false。
 */
export function isKnownAdminCandidate(isChannel: boolean, knownAdmin: boolean): boolean {
  return !isChannel && knownAdmin;
}

/**
 * 投递闸：一条已过管理员闸（isKnownAdminCandidate）的候选消息是否并进这个
 * 发送者的消息串。
 *
 * recentlyDisposed 命中时忽略该消息：处置已经发出，主线程正在把人写进黑名单。
 * 频道马甲例外：banChatSenderChat 没有 revoke_messages，处置后频道新发的广告需要单独删除，
 * 返回 deleteStraggler。
 *
 * blocked 走同一条例外。recentlyDisposed 按每个 key 各自的去重 TTL 存活；blocked 覆盖
 * 「已拉黑但封禁还没落地」，可以跨多个 TTL 存在（秒踢、补扫、更早判定登记的封禁批次都会先写名单
 * 再等 outbox 落盘与 mailbox 屏障），且不止由本次判定产生。用户身份不走例外：banChatMember
 * 带 revoke_messages，落地时撤掉这段时间内的消息。两者都不进判定额度。
 */
export function admitAdCandidate(input: AdCandidateAdmissionInput): AdCandidateDecision {
  if (input.textLength === 0) return "ignore";
  if (input.blocked || input.recentlyDisposed) {
    return input.isChannel ? "deleteStraggler" : "ignore";
  }
  return "accept";
}

/**
 * 排队闸：这个键该不该（重新）排进队列。
 *
 * 「这个 key 已取得一个待派发位置」由 queuedAdDetectKeys 表达：它随
 * adDetectQueue 同步增删，排着的人再说的话只并进消息串。判定在途期间由
 * inFlight 单独拦截并发送检，派发到结算之间也被覆盖。
 *
 * 不设容量闸：能走到这一步的键已在 pendingAdMessages 里（容量在那道闸判定），
 * 每个键在队列里最多占一个位置，队列长度被待检表的硬顶兜住。
 * @param input.hasUncheckedContent 由调用方比较 latestSeq 与 checkedSeq 得出；
 *   本函数不认识 bundle。
 */
export function admitAdRequeue(input: AdRequeueInput): AdRequeueDecision {
  if (!input.hasUncheckedContent) return "skip";
  if (input.queued || input.inFlight) return "skip";
  return "enqueue";
}

/**
 * 容量闸：新发送者是否已撞上全局硬顶 AD_DETECT_MAX_PENDING_SENDERS。
 *
 * 已经入队的键至少保留到一次判定尝试，满载时拒绝新的不同键，不淘汰队首。
 * 已有键的后续消息不占新名额，由调用方按 `existing !== undefined` 直接跳过本闸。
 *
 * 只读标量、不构造决策对象：跑在每条开着广告检测的群消息上，在清洗正文、URL 和引用上下文之前
 * 零载荷分配早退。本判据只由 workers/antiRaid/adDetect/queueState.ts 调用：
 * rejectNewAdBundleAtCapacity 供 enqueueAdCandidate 的两道入队闸接纳新 key，
 * refreshAdDetectCapacitySaturation 记饱和边沿；storeBundle 不重复判定。
 */
export function isNewAdBundleAtCapacity(pendingSize: number): boolean {
  return pendingSize >= AD_DETECT_MAX_PENDING_SENDERS;
}

/**
 * 在途闸：这一拍是否已不能再起判定。
 *
 * 批大小只限每拍起多少个，本闸按全局在途数 AD_DETECT_MAX_IN_FLIGHT 判定，不按群分配。
 * 调用方在把键从队列里取出之前询问：键取出后未发出时不会再被排回队列。
 * @param inFlight 此刻正在等广告检测 provider 回话的键数。
 */
export function isAdDispatchSaturated(inFlight: number): boolean {
  return inFlight >= AD_DETECT_MAX_IN_FLIGHT;
}
