/** AI 闲聊主线程代理的在途请求等待类型。 */

import type { VoiceSynthesisResult } from "./voiceMessage";

/** teardown 收尾身份；durable 删除与当前 Worker 失效完成后才允许忘记 revision。 */
export interface AiMemoryTeardown {
  requestId: number | null;
  workerSettled: boolean;
}

/** 等待指定 AI 记忆删除 revision durable 的调用方。 */
export interface AiMemoryDeleteWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 等待心情查询或重抽回执的调用方。 */
export interface MoodRequestWaiter {
  chatId: number;
  expectedEventType: "moodQueried" | "moodSwitched";
  resolve: (moodName: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 等待 AI Worker 完成某次 chat invalidate 的调用方。 */
export interface AiChatInvalidateWaiter {
  chatId: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 等待 AI Worker 交回一次语音合成结果的调用方（aiChat/voiceSynthesis.ts）。结算一律经
 * resolve 交回结果联合，不走 reject；结算时清掉 timer 并摘下调用方 signal 的监听。
 */
export interface VoiceSynthesisWaiter {
  resolve: (result: VoiceSynthesisResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 调用方取消信号及其监听；调用方没给 signal 时两者均为 undefined。 */
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}
