/**
 * 主线程借用 AI Worker 的语音合成公共实现（aiChat/ai/voiceSynthesis.ts）：`/send`
 * 代发的 TTS 与 cron `send_voice` 都经这里把「文本 + 语气」交给 Worker，拿回可直接
 * sendVoice 的语音（OGG/Opus 或 MP3，带上传文件名），再由各自的发送边界发出。
 *
 * 一次请求在 cache/main/aiChat.ts 的 voiceSynthesisRequests 登记一个等待者再投递
 * synthesizeVoice；等待与结算见 libs/workerRequestTable.ts，等待上限为
 * VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS。超时与取消会再投一条 cancelVoiceSynthesis 让 Worker
 * 中止在途合成。结算一律交回 VoiceSynthesisResult，不抛错。投递函数由 aiChat/workerBridge.ts
 * 注入，本模块不反向导入 bridge。
 */

import { agentTtsConfig } from "../config/agent";
import { VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS } from "../consts/aiChat/voiceMessage";
import { voiceSynthesisRequests } from "../cache/main/aiChat";
import { beginWorkerRequest, failAllWorkerRequests, settleWorkerRequest } from "../libs/workerRequestTable";
import type { AiChatWorkerMessage, AiVoiceSynthesizedEvent } from "../types/aiChat/protocol";
import type { VoiceSynthesisResult } from "../types/aiChat/voiceMessage";

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
  if (request.signal?.aborted === true) return Promise.resolve({ ok: false, reason: "aborted" });
  return beginWorkerRequest<VoiceSynthesisResult>({
    table: voiceSynthesisRequests,
    timeoutMs: VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS,
    post: (requestId: number): boolean =>
      post({ type: "synthesizeVoice", requestId, text: request.text, tone: request.tone }),
    cancel: (requestId: number): void => {
      post({ type: "cancelVoiceSynthesis", requestId });
    },
    abort: { signal: request.signal, result: { ok: false, reason: "aborted" } },
    timedOut: { ok: false, reason: "timed out" },
    rejected: { ok: false, reason: "worker unavailable" },
  });
}

/** voiceSynthesized 回执：按 requestId 结算；已超时、已取消或未知的回执直接丢弃。 */
export function settleVoiceSynthesis(event: AiVoiceSynthesizedEvent): void {
  settleWorkerRequest(voiceSynthesisRequests, event.requestId, event.result);
}

/** Worker 崩溃重建、放弃或终止：旧实例的回执不可能再到达，全部按不可用结算。 */
export function failAllVoiceSynthesisWaiters(): void {
  failAllWorkerRequests<VoiceSynthesisResult>(voiceSynthesisRequests, { ok: false, reason: "worker unavailable" });
}
