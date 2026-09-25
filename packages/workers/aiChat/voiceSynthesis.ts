/**
 * 主线程转交的语音合成（`/send` 代发的 TTS 与 cron `send_voice`）在 AI Worker 侧的
 * 执行：经公共实现 aiChat/ai/voiceSynthesis.ts 合成并编码，以同 requestId 的
 * voiceSynthesized 回执带回结果，成功时转移语音字节的底层 buffer。
 *
 * 每次请求的取消信号合入 Worker 的统一生命周期信号：Worker 停止或进入排空时在途合成
 * 一并中止；排空开始后到达的请求直接回「worker unavailable」。在途表见
 * cache/workers/aiChat/voiceSynthesis.ts。
 */

import { aiChatWorkerAbortController, aiChatWorkerQuiescing } from "../../cache/workers/aiChat/worker";
import { voiceSynthesisRequests } from "../../cache/workers/aiChat/voiceSynthesis";
import { logger } from "../../infra/logger";
import { resolveSpeechSynthesizer, synthesizeVoiceMessage } from "../../aiChat/ai/voiceSynthesis";
import type {
  AiCancelVoiceSynthesisMessage,
  AiSynthesizeVoiceMessage,
  AiVoiceSynthesizedEvent,
} from "../../types/aiChat/protocol";
import type { SpeechSynthesizerLookup, VoiceSynthesisResult } from "../../types/aiChat/voiceMessage";

declare const self: Worker;

/** 取入口并合成；能力缺席与排空期间直接返回失败原因，意外异常记日志后按合成失败结算。 */
async function synthesize(
  msg: AiSynthesizeVoiceMessage,
  controller: AbortController
): Promise<VoiceSynthesisResult> {
  if (aiChatWorkerQuiescing.current) return { ok: false, reason: "worker unavailable" };
  const synthesizer: SpeechSynthesizerLookup = resolveSpeechSynthesizer();
  if (!synthesizer.ok) return { ok: false, reason: synthesizer.reason };
  try {
    return await synthesizeVoiceMessage(
      synthesizer.synthesize,
      {
        text: msg.text,
        tone: msg.tone,
        signal: AbortSignal.any([controller.signal, aiChatWorkerAbortController.current.signal]),
      },
      `main-thread request ${msg.requestId}`
    );
  } catch (error: unknown) {
    logger.error(`Voice synthesis for main-thread request ${msg.requestId} threw:`, error);
    return { ok: false, reason: "synthesis failed" };
  }
}

/** 接纳一次合成请求；结算后回执并摘除在途条目。 */
export function handleSynthesizeVoice(msg: AiSynthesizeVoiceMessage): void {
  const controller: AbortController = new AbortController();
  voiceSynthesisRequests.set(msg.requestId, controller);
  void synthesize(msg, controller).then((result: VoiceSynthesisResult): void => {
    if (voiceSynthesisRequests.get(msg.requestId) === controller) voiceSynthesisRequests.delete(msg.requestId);
    const event: AiVoiceSynthesizedEvent = { type: "voiceSynthesized", requestId: msg.requestId, result };
    if (result.ok) self.postMessage(event, [result.voice.bytes.buffer]);
    else self.postMessage(event);
  });
}

/** 撤回一次在途合成；已结算或未知的 requestId 不做任何事。 */
export function handleCancelVoiceSynthesis(msg: AiCancelVoiceSynthesisMessage): void {
  voiceSynthesisRequests.get(msg.requestId)?.abort();
}
