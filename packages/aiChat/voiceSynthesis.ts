/**
 * 主线程借用 AI Worker 的语音合成公共实现（aiChat/ai/voiceSynthesis.ts）：`/send`
 * 代发的 TTS 与 cron `send_voice` 都经这里把「文本 + 语气」交给 Worker，拿回编码好的
 * OGG/Opus 语音，再由各自的发送边界发出。
 *
 * 一次请求登记一个等待者（cache/main/aiChat.ts 的 voiceSynthesisWaiters）再投递
 * synthesizeVoice；结算只有五条路：回执、等待超时（VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS）、
 * 调用方取消、投递被拒、Worker 崩溃重建 / 放弃 / 终止。超时与取消会再投一条
 * cancelVoiceSynthesis 让 Worker 中止在途合成。结算一律交回 VoiceSynthesisResult，
 * 不抛错。投递函数由 aiChat/workerBridge.ts 注入，本模块不反向导入 bridge。
 */

import { agentTtsConfig } from "../config/agent";
import { VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS } from "../consts/aiChat/voiceMessage";
import { voiceSynthesisRequestCounter, voiceSynthesisWaiters } from "../cache/main/aiChat";
import type { AiChatWorkerMessage, AiVoiceSynthesizedEvent } from "../types/aiChat/protocol";
import type { VoiceSynthesisResult } from "../types/aiChat/voiceMessage";
import type { VoiceSynthesisWaiter } from "../types/aiChat/waiters";

/** 交给 AI Worker 合成的一句台词；台词与语气已由调用方清洗并校验长度。 */
export interface VoiceSynthesisRequest {
  readonly text: string;
  /** 拼在基础朗读风格之后的本句语气；未给出时为 undefined。 */
  readonly tone: string | undefined;
  /** 调用方取消信号；中止时立即按 aborted 结算并撤回 Worker 侧合成。 */
  readonly signal: AbortSignal | undefined;
}

/** requestVoiceSynthesis 的注入项：投递函数与 Worker 此刻是否可用。 */
export interface VoiceSynthesisTransport {
  /** 向当前 AI Worker 投递；返回 false 表示同步拒绝。 */
  readonly post: (message: AiChatWorkerMessage) => boolean;
  readonly workerAvailable: boolean;
}

/** 摘除并收尾一个等待者；返回它以便调用方结算，已结算时返回 undefined。 */
function takeWaiter(requestId: number): VoiceSynthesisWaiter | undefined {
  const waiter: VoiceSynthesisWaiter | undefined = voiceSynthesisWaiters.get(requestId);
  if (waiter === undefined) return undefined;
  voiceSynthesisWaiters.delete(requestId);
  clearTimeout(waiter.timer);
  if (waiter.onAbort !== undefined) waiter.signal?.removeEventListener("abort", waiter.onAbort);
  return waiter;
}

/** 超时或取消：结算等待者并通知 Worker 撤回这次合成。 */
function withdraw(
  requestId: number,
  post: (message: AiChatWorkerMessage) => boolean,
  reason: "timed out" | "aborted"
): void {
  const waiter: VoiceSynthesisWaiter | undefined = takeWaiter(requestId);
  if (waiter === undefined) return;
  post({ type: "cancelVoiceSynthesis", requestId });
  waiter.resolve({ ok: false, reason });
}

/**
 * 请 AI Worker 合成一句台词。`agent.tts` 缺省时直接返回「tts unconfigured」，Worker
 * 不可用时返回「worker unavailable」，都不投递。
 */
export function requestVoiceSynthesis(
  request: VoiceSynthesisRequest,
  { post, workerAvailable }: VoiceSynthesisTransport
): Promise<VoiceSynthesisResult> {
  if (agentTtsConfig() === undefined) return Promise.resolve({ ok: false, reason: "tts unconfigured" });
  if (!workerAvailable) return Promise.resolve({ ok: false, reason: "worker unavailable" });
  const signal: AbortSignal | undefined = request.signal;
  if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: "aborted" });
  return new Promise((resolve: (result: VoiceSynthesisResult) => void): void => {
    const requestId: number = ++voiceSynthesisRequestCounter.current;
    const onAbort: (() => void) | undefined = signal === undefined
      ? undefined
      : (): void => withdraw(requestId, post, "aborted");
    const waiter: VoiceSynthesisWaiter = {
      resolve,
      timer: setTimeout((): void => withdraw(requestId, post, "timed out"), VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS),
      signal,
      onAbort,
    };
    // 等待者在投递之前登记，同步回执也不会丢（同 libs/flushBarrier.ts 的顺序约定）。
    voiceSynthesisWaiters.set(requestId, waiter);
    if (onAbort !== undefined) signal?.addEventListener("abort", onAbort, { once: true });
    if (!post({ type: "synthesizeVoice", requestId, text: request.text, tone: request.tone })) {
      takeWaiter(requestId)?.resolve({ ok: false, reason: "worker unavailable" });
    }
  });
}

/** voiceSynthesized 回执：按 requestId 结算；已超时、已取消或未知的回执直接丢弃。 */
export function settleVoiceSynthesis(event: AiVoiceSynthesizedEvent): void {
  takeWaiter(event.requestId)?.resolve(event.result);
}

/** Worker 崩溃重建、放弃或终止：旧实例的回执不可能再到达，全部按不可用结算。 */
export function failAllVoiceSynthesisWaiters(): void {
  for (const requestId of [...voiceSynthesisWaiters.keys()]) {
    takeWaiter(requestId)?.resolve({ ok: false, reason: "worker unavailable" });
  }
}
