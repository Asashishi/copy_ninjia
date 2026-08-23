/** AI 回复轮对 Telegram chat action 心跳的控制协议。 */

import type { TelegramChatAction } from "../telegram";

/** 心跳挡位：真正会发出去的那几个状态，加上「什么都不显示」。取值不在这里
 *  重写一遍——发送侧与本侧各持一份联合类型的话，新增状态漏改一处照样编译。 */
export type ChatActionPhase = TelegramChatAction | "idle";

export interface ChatActionControl {
  current(): ChatActionPhase;
  set(phase: ChatActionPhase): void;
  settle(): Promise<void>;
}

/** 单个群共享的聊天状态心跳运行态。 */
export interface ChatActionHeartbeatEntry {
  timer: ReturnType<typeof setInterval>;
  /** 拥有本条目的 AI generation；新 generation 会替换旧条目并中止旧请求。 */
  signal?: AbortSignal;
  refCount: number;
  action: ChatActionPhase;
  /**
   * 当前挡位持有轮所在的论坛话题；idle 与非论坛群为 undefined。
   *
   * 与 owner 一起由「后切非 idle 挡的轮」写入：Telegram 一个聊天同时只显示一种
   * 状态，因此并发轮里显示的本来就是最后切挡那一轮的状态，话题跟着它才自洽。
   */
  messageThreadId: number | undefined;
  owner: object | null;
  sendChain: Promise<void>;
  pendingSend: boolean;
  pendingSendDeduplicate: boolean;
  lastSentPhase: ChatActionPhase;
  lastSentAt: number;
  inflight: Set<Promise<unknown>>;
  consecutiveFailures: number;
}

/** 一轮回复持有的完整心跳句柄。 */
export interface ChatActionHeartbeatControl extends ChatActionControl {
  stop(): Promise<void>;
}
