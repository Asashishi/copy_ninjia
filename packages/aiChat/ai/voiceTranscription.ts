/**
 * 群聊语音消息的转写：下载 Telegram 的 voice note，原样把音频字节交给当前供应商
 * 的语音接口，产出一段尽量逐字的中文文本，供 workers/aiChat/mediaIngest.ts 把对话
 * 缓存里的占位文本替换掉。跑在 AI Worker 线程里（调用方就是它）。
 *
 * 与图片描述共用同一条管线（同一份 file_unique_id 去重缓存、同一个有界执行器、
 * 同样的占位→回填时序，见 aiChat/ai/imageDescription.ts），本文件只提供语音的下载
 * 与转写调用。
 *
 * 当前供应商没有语音能力时（`transcribeVoice` 成员缺席）直接返回不可重采样的失败，
 * 不切换到其它供应商（见 aiChat/provider.ts 模块头注）；转录里保留兜底占位。
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

/** transcribeVoiceUncached 的入参；fileId 与 declaredMime 来自 recordMedia 协议载荷。 */
export interface TranscribeVoiceParams {
  fileId: string;
  /** Telegram 声明的 mime_type，交给下载侧按白名单归一。 */
  declaredMime: string | undefined;
  signal?: AbortSignal;
}

/**
 * 转写一条语音，不经任何缓存。
 *
 * 失败结果同时声明业务层能否重新采样（口径见 types/aiChat/provider.ts 的 AiTextResult）；
 * 下载失败返回可重采样。
 */
export async function transcribeVoiceUncached({
  fileId,
  declaredMime,
  signal,
}: TranscribeVoiceParams): Promise<AiTextResult> {
  try {
    const provider: AiMediaProvider = mediaAiProvider();
    const transcribe: ((request: AiVoiceRequest) => Promise<AiTextResult>) | undefined = provider.transcribeVoice;
    if (transcribe === undefined) {
      // 当前供应商没有这项能力：记一行日志，不可重采样。
      logger.error(`Voice transcription is unavailable: the ${provider.name} media provider does not implement it.`);
      return { ok: false, retryable: false, mediaFailure: "unsupported" };
    }
    const clip: VoiceClip | null = await downloadTelegramVoice({
      fileId,
      declaredMime,
      signal,
    });
    if (!clip) return { ok: false, retryable: true };
    return await transcribe({
      prompt: VOICE_TRANSCRIPTION_PROMPT,
      clip,
      signal,
      errorLabel: VOICE_TRANSCRIPTION_ERROR_LABEL,
      normalize: (text: string): string => {
        const transcript: string = sanitizeInline(text);
        if (!transcript) return "";
        // 超限时收在子句边界（口径同媒体描述的截断）。
        return truncateAtClauseBoundary(transcript, VOICE_TRANSCRIPT_MAX_CHARS);
      },
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) return { ok: false, retryable: false };
    logger.error("Error transcribing chat voice:", error);
    return { ok: false, retryable: false };
  }
}
