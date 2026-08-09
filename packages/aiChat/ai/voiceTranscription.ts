/**
 * 群聊语音消息的转写：下载 Telegram 的 voice note，原样把音频字节交给当前供应商
 * 的语音接口，产出一段尽量逐字的中文文本，供 workers/aiChat/mediaIngest.ts 把对话
 * 缓存里的占位文本替换掉。跑在 AI Worker 线程里（调用方就是它）。
 *
 * 与图片描述**共用同一条管线**（同一份 file_unique_id 去重缓存、同一个有界执行器、
 * 同样的占位→回填时序，见 aiChat/ai/imageDescription.ts），本文件只提供「这一种
 * 媒体怎么下载、喂给哪一项能力」这一段差异。
 *
 * 当前供应商没有语音能力时（`transcribeVoice` 缺席，例如切到 OpenAI）直接返回
 * 不可重采样的失败——**不换一家去转写**：那正是 aiChat/provider.ts 模块头注拒绝的
 * 静默漂移，而且群里会看到同一条语音时而识别、时而不识别，查不出原因。转录里留
 * 兜底占位是诚实的降级。
 */

import { logger } from "../../infra/logger";
import { mediaAiProvider } from "../provider";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import { VOICE_TRANSCRIPTION_PROMPT } from "../../consts/aiChat/prompts/media";
import {
  VOICE_TRANSCRIPT_MAX_CHARS,
  VOICE_TRANSCRIPTION_ERROR_LABEL,
} from "../../consts/aiChat/voice";
import { downloadTelegramVoice } from "./telegramAudio";
import type { AiMediaProvider, AiTextResult, AiVoiceRequest } from "../../types/aiChat/provider";
import type { VoiceClip } from "../../types/media";

/** transcribeVoiceUncached 的入参；三项都来自 recordMedia 协议载荷。 */
export interface TranscribeVoiceParams {
  fileId: string;
  /** Telegram 声明的 mime_type，交给下载侧按白名单归一。 */
  declaredMime: string | undefined;
  durationSeconds: number;
}

/**
 * 转写一条语音，不经任何缓存。
 *
 * 失败结果同时声明业务层能否重新采样：供应商 SDK 已耗尽 HTTP 重试时禁止再套一层
 * 完整请求（口径见 types/aiChat/provider.ts 的 AiTextResult）；下载失败或响应正文
 * 不可用则允许。这里没有重采样的调用方，但契约要保持一致——媒体那条管线共用同一个
 * 结果类型。
 */
export async function transcribeVoiceUncached({
  fileId,
  declaredMime,
  durationSeconds,
}: TranscribeVoiceParams): Promise<AiTextResult> {
  try {
    const provider: AiMediaProvider = mediaAiProvider();
    const transcribe: ((request: AiVoiceRequest) => Promise<AiTextResult>) | undefined = provider.transcribeVoice;
    if (transcribe === undefined) {
      // 不是故障，是这一家没有这项能力；记一行足以解释「为什么语音突然不识别了」，
      // 但不可重采样——再试一次仍然是同一个供应商。
      logger.error(`Voice transcription is unavailable: the ${provider.name} media provider does not implement it.`);
      return { ok: false, retryable: false, mediaFailure: "unsupported" };
    }
    const clip: VoiceClip | null = await downloadTelegramVoice({ fileId, declaredMime, durationSeconds });
    if (!clip) return { ok: false, retryable: true };
    return await transcribe({
      prompt: VOICE_TRANSCRIPTION_PROMPT,
      clip,
      errorLabel: VOICE_TRANSCRIPTION_ERROR_LABEL,
      normalize: (text: string): string => {
        const transcript: string = sanitizeInline(text);
        if (!transcript) return "";
        // 超限时收在子句边界而不是硬切：这一行会被当成群友说过的原话读，
        // 断在半个词上比少说一句更容易被误解（口径同媒体描述的截断）。
        return truncateAtClauseBoundary(transcript, VOICE_TRANSCRIPT_MAX_CHARS);
      },
    });
  } catch (error: unknown) {
    logger.error("Error transcribing chat voice:", error);
    return { ok: false, retryable: false };
  }
}
