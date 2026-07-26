/** AI 回复轮对 Telegram chat action 心跳的控制协议。 */

export type ChatActionPhase = "typing" | "upload_photo" | "choose_sticker" | "idle";

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
