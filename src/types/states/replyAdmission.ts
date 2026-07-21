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

export interface AdmitTriggerInput {
  activeRounds: number;
  queueSize: number;
  kind: TriggerKind;
}

export type AdmitDecision =
  /** 并发未满（或补跑腾出了空位）：立即开新轮。 */
  | { action: "startRound" }
  /** 并发已满、是真人在等的直接触发、队列还有空位：入队等补跑。 */
  | { action: "enqueue" }
  /** 并发已满、是随机插话/随机媒体评价：静默丢弃，不入队也不提示。 */
  | { action: "dropSilently" }
  /** 并发已满、是直接触发、但队列也满了：丢弃并欠一条限频提示。 */
  | { action: "enqueueOverflow" };

export interface AdmitRoundInput {
  windowCount: number;
}

export type RoundDecision =
  /** 窗口未满：调用方记账后执行。 */
  | { action: "run" }
  /** 窗口已满：通知（带自身冷却）并丢弃，不记账。 */
  | { action: "rateLimited" };
