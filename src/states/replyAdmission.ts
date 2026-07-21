import { RATE_LIMIT_LONG_MAX_TRIGGERS, REPLY_ROUND_MAX_CONCURRENT, REPLY_TRIGGER_QUEUE_MAX } from "../consts/aiChat/rateLimit";
import type {
  AdmitDecision,
  AdmitRoundInput,
  AdmitTriggerInput,
  RoundDecision,
} from "../types/states/replyAdmission";

/**
 * AI 回复准入控制的纯决策规则（不做任何 I/O、不持有计时器，也不碰任何
 * Map/LinkedQueue/Date.now()）。对应原揉在 aiChatWorker.ts 里的两道闸：
 *
 * - admitTrigger：并发闸，在触发到达时判定。
 * - admitRound：限频闸，在真正开始一轮前判定。
 *
 * 两道闸不是同一个状态对象的两次转移——之间隔着「入队等待补跑」这个
 * 不定时长的中间态（补跑时才会走到 admitRound，见 replyQueue.ts），且
 * 没有一个有意义的离散状态集合可以枚举（不像
 * verification/lockdown 那样有 PENDING/ACTIVE 这类需要持久化在 Map 里、
 * 会被后续事件引用的状态），本质是两次独立的阈值判定，各自只吃调用方
 * 算好的标量。因此这里不采用 transition(state, event) 的单机形态，而是
 * 两个独立的纯函数——滑动窗口（longTriggerTimes）、队列
 * （pendingReplyTriggers）、在途计数（activeReplyCounts）、提示冷却
 * （rateLimitNoticeTimes）这些内存容器与计时留在 replyState/replyQueue/
 * replyRound 三个运行时模块里，只把已经算好的数字喂进来。
 */

/**
 * 并发闸判定：同群在途轮数达到上限时，能否再开一轮／要不要排队等。
 * @param input.activeRounds 该群当前在途的回复轮数。
 * @param input.queueSize 该群当前排队等待补跑的直接触发数。
 * @param input.kind 本次触发的种类。
 */
export function admitTrigger(input: AdmitTriggerInput): AdmitDecision {
  if (input.activeRounds < REPLY_ROUND_MAX_CONCURRENT) return { action: "startRound" };
  if (input.kind === "random" || input.kind === "mediaRandom") return { action: "dropSilently" };
  if (input.queueSize >= REPLY_TRIGGER_QUEUE_MAX) return { action: "enqueueOverflow" };
  return { action: "enqueue" };
}

/**
 * 限频闸判定：该群 5 分钟滑动窗口内的触发数是否已达上限。调用方必须先把
 * 窗口外的旧触发挤掉再数 windowCount——本函数不掐时间，只比较数量。
 * @param input.windowCount 挤掉过期项之后，窗口内剩余的触发数。
 */
export function admitRound(input: AdmitRoundInput): RoundDecision {
  if (input.windowCount >= RATE_LIMIT_LONG_MAX_TRIGGERS) return { action: "rateLimited" };
  return { action: "run" };
}
