import {
  AD_DETECT_MAX_IN_FLIGHT,
  AD_DETECT_MAX_PENDING_SENDERS,
} from "../consts/antiRaid/adDetect";
import type {
  AdBundleStorageDecision,
  AdBundleStorageInput,
  AdCandidateAdmissionInput,
  AdCandidateDecision,
  AdDispatchDecision,
  AdDispatchInput,
  AdRequeueDecision,
  AdRequeueInput,
} from "../types/states/adDetectAdmission";

/**
 * 广告检测待检队列的纯准入规则（不做任何 I/O、不持有计时器，也不碰
 * pendingAdMessages / adDetectQueue / recentlyEnqueuedAdKeys 这几张表）。
 *
 * 对应原先揉在 workers/antiRaid/adDetect/queue.ts 里的四道闸：
 *
 * - admitAdCandidate：投递闸，一条新消息该不该进这个人的消息串。
 * - admitAdRequeue：排队闸，这个键该不该（重新）排进队列。
 * - admitAdBundleStorage：容量闸，接不接纳一个**新**发送者。
 * - admitAdDispatch：在途闸，这一拍还能不能再起一次判定。
 *
 * 采用 states/replyAdmission.ts 的形态（一组吃标量的纯函数），而不是
 * verification/lockdown 那种 transition(state, event)：每个键的「状态」挂着
 * 一串没有固定上界的消息（AdMessageBundle），而三道容量闸算的都是**全局**
 * 数字（待检表键数、去重表键数、全局在途数），不按键分配。硬塞进单机形态，
 * 状态对象里会同时出现「我这一串」和「全线程一共多少」，两者的生命周期完全
 * 不同，反而比现在更难读。
 *
 * 抽出来的收益在另一处：`docs/04-invariants.md` 要求「待检所有权由
 * pendingAdMessages、adDetectQueue 与 queuedAdDetectKeys 共同表达，三者必须
 * 同步增删」，而那份一致性此前只靠注释和 25 处散落的 mutation 维持。判定集中
 * 到这里之后，「该不该动这三张表」有了唯一答案，运行时那边只剩「照着做」。
 */

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
 * blocked 走的是同一条例外，只是覆盖的窗口更长。recentlyDisposed 只活一个去重
 * 窗口，而「已拉黑但封禁还没落地」可以跨窗口存在（秒踢、补扫、上一个窗口的
 * 判定登记的封禁批次都会先写名单再等 outbox 落盘与 mailbox 屏障），而且不止
 * 由本次判定产生。用户身份不需要这条：banChatMember 带 revoke_messages，落地
 * 时会把这段窗口里的消息一起撤掉。两者都不进判定额度——名单里的人结局已定，
 * 再判一次只会换来一模一样的处置。
 */
export function admitAdCandidate(input: AdCandidateAdmissionInput): AdCandidateDecision {
  if (input.textLength === 0) return { action: "ignore" };
  if (!input.isChannel && input.knownAdmin) return { action: "ignore" };
  if (input.blocked || input.recentlyDisposed) {
    return input.isChannel ? { action: "deleteStraggler" } : { action: "ignore" };
  }
  return { action: "accept" };
}

/**
 * 排队闸：这个键该不该（重新）排进队列。
 *
 * recentlyEnqueued 就是「一个人一个窗口只判一次」那道闸：命中期间他说的话只
 * 并进消息串，等窗口轮换清表时连同上下文一起判（见 queue.ts 的
 * rotateAdDetectDedupWindow——那次补排是这些消息唯一的重排时机）。
 * @param input.hasUncheckedContent 由调用方比较 latestSeq 与 checkedSeq 得出；
 *   本函数不认识 bundle。
 */
export function admitAdRequeue(input: AdRequeueInput): AdRequeueDecision {
  if (!input.hasUncheckedContent) return { action: "skip" };
  if (input.queued || input.inFlight || input.recentlyEnqueued) return { action: "skip" };
  if (input.dedupWindowSize >= AD_DETECT_MAX_PENDING_SENDERS) return { action: "rejectAtCapacity" };
  return { action: "enqueue" };
}

/**
 * 容量闸：接不接纳一个新发送者。
 *
 * 已经入队的键必须留到至少一次判定尝试，因此满载时拒绝**新的不同键**而不是
 * 淘汰队首——FIFO 淘汰会让先到的人在从没被判过一次的情况下消失。已有键的后续
 * 消息不占新名额，照常合并。
 */
export function admitAdBundleStorage(input: AdBundleStorageInput): AdBundleStorageDecision {
  if (input.alreadyStored) return { action: "store" };
  if (
    input.pendingSize >= AD_DETECT_MAX_PENDING_SENDERS ||
    input.dedupWindowSize >= AD_DETECT_MAX_PENDING_SENDERS
  ) {
    return { action: "rejectAtCapacity" };
  }
  return { action: "store" };
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
  return input.inFlight >= AD_DETECT_MAX_IN_FLIGHT ? { action: "saturated" } : { action: "dispatch" };
}
