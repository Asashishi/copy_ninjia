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
  telegramBackpressured: boolean;
  /** 当前群与 Worker 的存活回复轮次均未耗尽容量。 */
  deliveryAvailable: boolean;
}

export type AdmitDecision =
  /** 模型与存活容量均允许且等待队列为空：立即开新轮。 */
  | { readonly action: "startRound" }
  /** 直接触发暂不能启动且队列有空位：入队等补跑。 */
  | { readonly action: "enqueue" }
  /** 随机触发因并发、容量、排队或出站压力受阻：静默丢弃。 */
  | { readonly action: "dropSilently" }
  /** 直接触发的等待队列已满：丢弃并登记溢出提示。 */
  | { readonly action: "enqueueOverflow" };

export interface AdmitRoundInput {
  windowCount: number;
}

export type RoundDecision =
  /** 窗口未满：调用方记账后执行。 */
  | { readonly action: "run" }
  /** 窗口已满：不记账，调用方按触发来源通知或保留队首。 */
  | { readonly action: "rateLimited" };
