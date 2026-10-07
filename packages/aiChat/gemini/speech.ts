/**
 * Gemini 侧的语音合成：调 TTS 模型把一句台词念成语音。
 *
 * 走 Interactions API（`ai.interactions.create`），不经 client.ts 的
 * generateContent 封装。请求体为：
 * `input` 是一个 user_input 步骤，唯一的文本块携带台词，并用 `speech_metadata`
 * 注解给出朗读风格（`<基础风格>[; <朗读语言>]; 细节: <本句语气>`）；`response_format` 只声明要音频，
 * 响应音频的 MIME 取自载荷声明，容器由 aiChat/ai/voiceEncoding.ts 按 MIME 处理；
 * `generation_config` 指定音色与采样温度。
 * 音色取自 config/dynamic/agent.json 的 `agent.tts.voice`，经 `speech_config[].voice` 原样
 * 传入；基础风格取同一配置快照的 style，与朗读语言、本句语气由 ai/utils/speechStyle.ts 拼接，
 * 温度取自 consts/aiChat/gemini.ts。
 *
 * 超时与重试逐次显式传参：重试次数按 GEMINI_SPEECH_REQUEST_ATTEMPTS 声明（`maxRetries`
 * 为其减一）；调用方 signal 与独立超时经 libs/abortSignal.ts 的 signalWithTimeout 合成一个
 * signal 传下去，同时传入 `timeout`。
 *
 * 失败一律返回 null 并记一行英文错误日志，不抛错；调用方（aiChat/provider.ts 的
 * tts 门面）据此结算为 `synthesis failed`。
 */

import type { GoogleGenAI, Interactions } from "@google/genai";
import {
  GEMINI_SPEECH_ERROR_LABEL,
  GEMINI_SPEECH_REQUEST_ATTEMPTS,
  GEMINI_SPEECH_REQUEST_TIMEOUT_MS,
  GEMINI_SPEECH_TEMPERATURE,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { reportGeminiInteractionUsage } from "../../infra/aiCacheUsage";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { decodeSynthesizedSpeech, speechFromDecoded, speechRequestFailed } from "../ai/utils/speechPayload";
import { composeSpeechStyle } from "../ai/utils/speechStyle";
import { getGeminiClient } from "./client";
import type { AiSpeechRequest } from "../../types/aiChat/provider";
import type { SynthesizedSpeech } from "../../types/aiChat/voiceMessage";
import type { AgentTtsCapabilityConfig } from "../../types/config";

/**
 * 语音合成的 generation_config。服务端接受 `temperature`，已安装 SDK 的
 * `Interactions.GenerationConfig` 未收录该字段，因此在构造请求体的唯一位置转换。
 */
interface SpeechGenerationConfig {
  readonly speech_config: readonly { readonly voice: string }[];
  readonly temperature: number;
}

/** 本次合成使用的音色（部署配置）与采样温度。 */
function speechGenerationConfig(voice: string): Interactions.GenerationConfig {
  const config: SpeechGenerationConfig = {
    speech_config: [{ voice }],
    temperature: GEMINI_SPEECH_TEMPERATURE,
  };
  return config as unknown as Interactions.GenerationConfig;
}

/** `interactions.create` 返回的音频与本次请求用量；SDK 返回时上报，调用方取消不丢弃迟到用量。 */
interface SpeechInteractionOutput {
  readonly output_audio?: { readonly data?: string | undefined; readonly mime_type?: string | undefined } | undefined;
  readonly usage?: Interactions.Usage | undefined;
}

/**
 * 构造携带台词与朗读风格的文本块。
 * @param text 要念出来的台词。
 * @param style 基础风格与本句语气拼好的风格说明（见 ai/utils/speechStyle.ts）。
 */
function speechTextContent(text: string, style: string): Interactions.TextContent {
  return { type: "text", text, annotations: [{ type: "speech_metadata", style }] };
}

/** 把一句台词合成为语音；无可用音频载荷时返回 null。 */
export async function synthesizeGeminiSpeech({
  text,
  languageStyle,
  tone,
  signal,
}: AiSpeechRequest): Promise<SynthesizedSpeech | null> {
  let interaction: SpeechInteractionOutput;
  const requestSignal: AbortSignal = signalWithTimeout(signal, GEMINI_SPEECH_REQUEST_TIMEOUT_MS);
  try {
    requestSignal.throwIfAborted();
    const client: GoogleGenAI = getGeminiClient("tts");
    // 模型、音色与风格使用同一份配置快照，配置读取失败归一成一次普通失败。
    const tts: AgentTtsCapabilityConfig | undefined = getAgentDeploymentConfig().tts;
    if (tts?.provider !== "google") throw new Error('Agent capability "tts" is not configured for the Google provider.');
    interaction = await raceAbortOrThrow(
      client.interactions.create(
        {
          model: tts.model,
          input: [{
            type: "user_input",
            content: [speechTextContent(text, composeSpeechStyle(tts.style, languageStyle, tone))],
          }],
          response_format: { type: "audio" },
          generation_config: speechGenerationConfig(tts.voice),
        },
        {
          timeout: GEMINI_SPEECH_REQUEST_TIMEOUT_MS,
          maxRetries: GEMINI_SPEECH_REQUEST_ATTEMPTS - 1,
          signal: requestSignal,
        }
      ).then((response: SpeechInteractionOutput): SpeechInteractionOutput => {
        reportGeminiInteractionUsage({ capability: "tts", model: tts.model, usage: response.usage });
        return response;
      }),
      requestSignal
    );
  } catch (error: unknown) {
    return speechRequestFailed(GEMINI_SPEECH_ERROR_LABEL, signal, error);
  }

  const encoded: string | undefined = interaction.output_audio?.data;
  if (encoded === undefined) {
    logger.error(`${GEMINI_SPEECH_ERROR_LABEL} returned no audio payload.`);
    return null;
  }
  return speechFromDecoded(
    GEMINI_SPEECH_ERROR_LABEL,
    decodeSynthesizedSpeech(encoded, interaction.output_audio?.mime_type)
  );
}
