import { RATE_LIMIT_LONG_MAX_TRIGGERS, REPLY_ROUND_MAX_CONCURRENT, REPLY_TRIGGER_QUEUE_MAX } from "../consts/aiChat";

/**
 * AI 回复准入控制的纯决策规则（不做任何 I/O、不持有计时器，也不碰任何
 * Map/LinkedQueue/Date.now()）。对应原揉在 aiChatWorker.ts 里的两道闸：
 *
 * - admitTrigger：并发闸，触发到达时判定（原 generateAndSendReply）。
 * - admitRound：限频闸，真正开一轮前判定（原 startReplyRound 前半段）。
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

/** 触发的种类，决定并发闸打满时是丢弃还是排队，见 admitTrigger。 */
export type TriggerKind =
  /** 文字回复 / @ 机器人：真人在等，打满时排队补跑。 */
  | "direct"
  /** 无人叫机器人的随机插话：打满时直接丢弃，错过时机再补反而突兀。 */
  | "random"
  /** 拿媒体（贴纸/图片/GIF）回复机器人，或 caption 里 @ 机器人：语义同
   *  direct，真人在等，打满时排队补跑。 */
  | "mediaDirect"
  /** 解析完媒体后随机命中的评价（非直接触发）：语义同 random，打满时丢弃。 */
  | "mediaRandom";

export type AdmitDecision =
  /** 并发未满（或补跑腾出了空位）：立即开新轮。 */
  | { action: "startRound" }
  /** 并发已满、是真人在等的直接触发、队列还有空位：入队等补跑。 */
  | { action: "enqueue" }
  /** 并发已满、是随机插话/随机媒体评价：静默丢弃，不入队也不提示——没人
   *  在等那条回复，提示反而吵。 */
  | { action: "dropSilently" }
  /** 并发已满、是直接触发、但队列也满了：丢弃，且欠一条「太快了」提示
   *  （提示本身压到某轮收尾腾出空位时再发，见 replyQueue.ts）。 */
  | { action: "enqueueOverflow" };

/**
 * 并发闸判定：同群在途轮数达到上限时，能否再开一轮／要不要排队等。
 * @param input.activeRounds 该群当前在途的回复轮数。
 * @param input.queueSize 该群当前排队等待补跑的直接触发数。
 * @param input.kind 本次触发的种类。
 */
export function admitTrigger(input: { activeRounds: number; queueSize: number; kind: TriggerKind }): AdmitDecision {
  if (input.activeRounds < REPLY_ROUND_MAX_CONCURRENT) return { action: "startRound" };
  if (input.kind === "random" || input.kind === "mediaRandom") return { action: "dropSilently" };
  if (input.queueSize >= REPLY_TRIGGER_QUEUE_MAX) return { action: "enqueueOverflow" };
  return { action: "enqueue" };
}

export type RoundDecision =
  /** 窗口未满：调用方记账（push 时间戳 + activeRounds++）后执行。 */
  | { action: "run" }
  /** 窗口已满：通知（带自身冷却）+ 丢弃，不记账。 */
  | { action: "rateLimited" };

/**
 * 限频闸判定：该群 5 分钟滑动窗口内的触发数是否已达上限。调用方必须先把
 * 窗口外的旧触发挤掉再数 windowCount——本函数不掐时间，只比较数量。
 * @param input.windowCount 挤掉过期项之后，窗口内剩余的触发数。
 */
export function admitRound(input: { windowCount: number }): RoundDecision {
  if (input.windowCount >= RATE_LIMIT_LONG_MAX_TRIGGERS) return { action: "rateLimited" };
  return { action: "run" };
}
