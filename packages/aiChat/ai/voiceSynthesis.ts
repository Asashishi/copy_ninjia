/**
 * 语音合成的公共实现：把一句台词按可选语气合成并编码成可直接 sendVoice 的
 * OGG/Opus 语音。
 *
 * 三个调用方共用这一条链：AI 语音工具（tools/replyToolset/voiceMessage.ts），以及
 * 主线程经 AI Worker 转交的 `/send` 代发 TTS 与 cron `send_voice`（见
 * workers/aiChat/voiceSynthesis.ts）。工具声明、参数口径、限额、挂回复与发送都归各
 * 调用方，这里只管「入口在不在」与「文本 + 语气 → 语音」。语气拼在基础朗读风格之后，
 * 由供应商实现处理（见 aiChat/gemini/speech.ts）；合成经 aiChat/provider.ts 的 tts
 * 门面，受交互优先的配额闸门约束。
 *
 * 所属线程：AI 闲聊 Worker；本模块不持有缓存。
 */

import { logger } from "../../infra/logger";
import { ttsAiProvider } from "../provider";
import { encodeVoiceMessage } from "./voiceEncoding";
import type { AiSpeechProvider, AiSpeechRequest } from "../../types/aiChat/provider";
import type {
  SpeechSynthesizer,
  SpeechSynthesizerLookup,
  SynthesizedSpeech,
  VoiceEncodeResult,
  VoiceSynthesisResult,
} from "../../types/aiChat/voiceMessage";

/** 按当前 agent 配置取语音合成入口；`agent.tts` 缺省或所选实现不支持时返回原因。 */
export function resolveSpeechSynthesizer(): SpeechSynthesizerLookup {
  const provider: AiSpeechProvider | null = ttsAiProvider();
  if (provider === null) return { ok: false, reason: "tts unconfigured", providerName: undefined };
  const synthesize: SpeechSynthesizer | undefined = provider.synthesizeSpeech;
  if (synthesize === undefined) return { ok: false, reason: "tts unsupported", providerName: provider.name };
  return { ok: true, synthesize };
}

/**
 * 合成一句台词并编码成 Telegram 语音消息。合成返回时 signal 已中止则不再编码；
 * 编码失败原因在这里记一行英文日志。不抛错。
 * @param synthesize resolveSpeechSynthesizer 取得的入口。
 * @param request 台词、可选语气与取消信号；台词与语气的清洗与长度口径由调用方负责。
 * @param logContext 编码失败日志里标明来源的英文片段（如 `chat -100123`）。
 */
export async function synthesizeVoiceMessage(
  synthesize: SpeechSynthesizer,
  request: AiSpeechRequest,
  logContext: string
): Promise<VoiceSynthesisResult> {
  const speech: SynthesizedSpeech | null = await synthesize(request);
  if (request.signal?.aborted === true) return { ok: false, reason: "aborted" };
  if (speech === null) return { ok: false, reason: "synthesis failed" };
  const encoded: VoiceEncodeResult = await encodeVoiceMessage(speech);
  if (!encoded.ok) logger.error(`Voice message encoding failed (${logContext}): ${encoded.reason}.`);
  return encoded;
}
