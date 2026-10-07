/**
 * 主线程借用 AI Worker 的语音合成公共实现（aiChat/ai/voiceSynthesis.ts）：`/send`
 * 代发的 TTS 与 cron `send_voice` 都经这里把「文本 + 语气」交给 Worker，拿回可直接
 * sendVoice 的语音（OGG/Opus 或 MP3，带上传文件名），再由各自的发送边界发出。
 *
 * 一次请求经 aiChat/workerJob.ts 在 cache/main/aiChat.ts 的 voiceSynthesisRequests 登记一个等待者
 * 再投递 synthesizeVoice，等待上限为 VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS；超时与取消会再投一条
 * cancelVoiceSynthesis 让 Worker 中止在途合成。结算一律交回 VoiceSynthesisResult，不抛错。投递函数
 * 由 aiChat/workerBridge.ts 注入，本模块不反向导入 bridge；voiceSynthesized 回执与 Worker 失效时的
 * 整表失败结算也在 bridge 里直接对等待表执行。
 */

import { agentTtsConfig } from "../config/agent";
import { VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS } from "../consts/aiChat/voiceMessage";
import { voiceSynthesisRequests } from "../cache/main/aiChat";
import type { AiChatWorkerMessage } from "../types/aiChat/protocol";
import type { VoiceSynthesisResult } from "../types/aiChat/voiceMessage";
import type { AiWorkerJobTransport } from "../types/aiChat/workerJob";
import { requestAiWorkerJob } from "./workerJob";

/** 交给 AI Worker 合成的一句台词；台词与语气已由调用方清洗并校验长度。 */
export interface VoiceSynthesisRequest {
  readonly text: string;
  /** 拼在基础朗读风格之后的本句语气；未给出时为 undefined。 */
  readonly tone: string | undefined;
  /** 调用方取消信号；中止时立即按 aborted 结算并撤回 Worker 侧合成。 */
  readonly signal: AbortSignal | undefined;
}

/**
 * 请 AI Worker 合成一句台词。`agent.tts` 缺省时直接返回「tts unconfigured」，Worker
 * 不可用时返回「worker unavailable」，都不投递。
 */
export function requestVoiceSynthesis(
  request: VoiceSynthesisRequest,
  transport: AiWorkerJobTransport
): Promise<VoiceSynthesisResult> {
  if (agentTtsConfig() === undefined) return Promise.resolve({ ok: false, reason: "tts unconfigured" });
  return requestAiWorkerJob<VoiceSynthesisResult>({
    table: voiceSynthesisRequests,
    timeoutMs: VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS,
    transport,
    signal: request.signal,
    start: (requestId: number): AiChatWorkerMessage => ({ type: "synthesizeVoice", requestId, text: request.text, tone: request.tone }),
    cancel: (requestId: number): AiChatWorkerMessage => ({ type: "cancelVoiceSynthesis", requestId }),
  });
}
