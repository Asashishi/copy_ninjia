/**
 * 主线程转交的语音合成（`/send` 代发的 TTS 与 cron `send_voice`）在 AI Worker 侧的
 * 执行：经公共实现 aiChat/ai/voiceSynthesis.ts 按 `operator` 预留额度
 * （`agent.tts.daily_reserve_quota`）合成并编码，以同 requestId 的 voiceSynthesized 回执带回结果，成功时
 * 转移语音字节的底层 buffer。请求不带朗读语言要求：合成风格只有基础风格与调用方给的语气，
 * 不随 `agent.tts.bot_language` 变化。
 *
 * 登记、生命周期信号与排空期间的拒收见 ./workerJob.ts；在途表见
 * cache/workers/aiChat/voiceSynthesis.ts。
 */

import { voiceSynthesisRequests } from "../../cache/workers/aiChat/voiceSynthesis";
import { logger } from "../../infra/logger";
import { resolveSpeechSynthesizer, synthesizeVoiceMessage } from "../../aiChat/ai/voiceSynthesis";
import type {
  AiCancelVoiceSynthesisMessage,
  AiSynthesizeVoiceMessage,
  AiVoiceSynthesizedEvent,
} from "../../types/aiChat/protocol";
import type { SpeechSynthesizerLookup, VoiceSynthesisResult } from "../../types/aiChat/voiceMessage";
import { runAiWorkerJob } from "./workerJob";

declare const self: Worker;

/**
 * 取入口并合成；能力缺席时直接返回失败原因。取入口与合成的意外异常都按合成失败
 * 结算：前者在这里记日志，后者由 synthesizeVoiceMessage 记，回执因此一定发出。
 */
async function synthesize(msg: AiSynthesizeVoiceMessage, signal: AbortSignal): Promise<VoiceSynthesisResult> {
  let synthesizer: SpeechSynthesizerLookup;
  try {
    synthesizer = resolveSpeechSynthesizer();
  } catch (error: unknown) {
    logger.error(`Speech synthesizer lookup for main-thread request ${msg.requestId} threw:`, error);
    return { ok: false, reason: "synthesis failed" };
  }
  if (!synthesizer.ok) return { ok: false, reason: synthesizer.reason };
  return await synthesizeVoiceMessage(
    synthesizer.synthesize,
    { text: msg.text, tone: msg.tone, quota: "operator", signal },
    `main-thread request ${msg.requestId}`
  );
}

/** 接纳一次合成请求；结算后回执，成功时转移语音字节的底层 buffer。 */
export function handleSynthesizeVoice(msg: AiSynthesizeVoiceMessage): void {
  runAiWorkerJob<VoiceSynthesisResult>({
    jobs: voiceSynthesisRequests,
    requestId: msg.requestId,
    run: (signal: AbortSignal): Promise<VoiceSynthesisResult> => synthesize(msg, signal),
    publish: (result: VoiceSynthesisResult): void => {
      const event: AiVoiceSynthesizedEvent = { type: "voiceSynthesized", requestId: msg.requestId, result };
      if (result.ok) self.postMessage(event, [result.voice.bytes.buffer]);
      else self.postMessage(event);
    },
  });
}

/** 撤回一次在途合成；已结算或未知的 requestId 不做任何事。 */
export function handleCancelVoiceSynthesis(msg: AiCancelVoiceSynthesisMessage): void {
  voiceSynthesisRequests.get(msg.requestId)?.abort();
}
