/**
 * OpenAI 实现包的语音合成：按 `agent.tts.speech_protocol` 分派到两种线协议。
 *
 * - `openai`：官方 SDK 的 audio/speech（`client.audio.speech.create`）。台词走 `input`，
 *   音色走 `voice`，配置的基础风格与朗读语言、本句语气由 ai/utils/speechStyle.ts 拼成
 *   `instructions`。响应格式钉为 OPENAI_SPEECH_RESPONSE_FORMAT（OGG/Opus），按
 *   OGG_OPUS_MIME_TYPE 交回，由编码侧校验容器后原样发送；兼容端点按同一请求形状发送，须支持
 *   该格式。
 *   SDK 的每次尝试超时与整次调用 deadline 都是 OPENAI_SPEECH_REQUEST_TIMEOUT_MS，
 *   重试次数按 OPENAI_SPEECH_REQUEST_ATTEMPTS 显式传入。响应不带用量，收到响应时按
 *   missing 记一次有界诊断。
 * - `xai`：xAI `POST /tts`，请求体与 SDK 不兼容，由 ./xaiSpeech.ts 以 fetch 发送；没有风格字段，
 *   朗读语言与语气都不发送，合成语言由配置的 `language` 决定。
 *
 * 模型、音色、风格与协议取自同一份 tts 配置快照。失败一律返回 null 并记一行英文错误
 * 日志；调用方 signal 已中止时静默返回 null，绝不抛错。新增协议必须扩展
 * OpenAiSpeechProtocol 与下方穷举 switch。
 * 所属线程：AI 闲聊 Worker；本模块不持有缓存。
 */

import { OGG_OPUS_MIME_TYPE } from "../../consts/audio";
import {
  OPENAI_SPEECH_ERROR_LABEL,
  OPENAI_SPEECH_REQUEST_ATTEMPTS,
  OPENAI_SPEECH_REQUEST_TIMEOUT_MS,
  OPENAI_SPEECH_RESPONSE_FORMAT,
} from "../../consts/aiChat/openai";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { warnAiUsageUnavailable } from "../../infra/aiCacheUsage";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { readSpeechBody, speechFromDecoded, speechRequestFailed } from "../ai/utils/speechPayload";
import { composeSpeechStyle } from "../ai/utils/speechStyle";
import { getOpenAiClient } from "./client";
import { synthesizeXAiSpeech } from "./xaiSpeech";
import type { AiSpeechRequest } from "../../types/aiChat/provider";
import type { SynthesizedSpeech, SynthesizedSpeechDecodeResult } from "../../types/aiChat/voiceMessage";
import type {
  AgentTtsCapabilityConfig,
  OpenAiAgentTtsCapabilityConfig,
  OpenAiSpeechProtocol,
  XAiAgentTtsCapabilityConfig,
} from "../../types/config";

/** 按 openai 协议（audio/speech）把一句台词合成为 OGG/Opus 语音。 */
async function synthesizeAudioSpeech(
  tts: OpenAiAgentTtsCapabilityConfig,
  { text, languageStyle, tone, signal }: AiSpeechRequest
): Promise<SynthesizedSpeech | null> {
  const requestSignal: AbortSignal = signalWithTimeout(signal, OPENAI_SPEECH_REQUEST_TIMEOUT_MS);
  let decoded: SynthesizedSpeechDecodeResult;
  try {
    requestSignal.throwIfAborted();
    const response: Response = await raceAbortOrThrow(
      getOpenAiClient("tts").audio.speech.create(
        {
          model: tts.model,
          voice: tts.voice,
          input: text,
          instructions: composeSpeechStyle(tts.style, languageStyle, tone),
          response_format: OPENAI_SPEECH_RESPONSE_FORMAT,
        },
        {
          signal: requestSignal,
          timeout: OPENAI_SPEECH_REQUEST_TIMEOUT_MS,
          maxRetries: OPENAI_SPEECH_REQUEST_ATTEMPTS - 1,
        }
      ).then((response: Response): Response => {
        warnAiUsageUnavailable("tts", "openai", "missing");
        return response;
      }),
      requestSignal
    );
    decoded = await readSpeechBody(response, OGG_OPUS_MIME_TYPE);
  } catch (error: unknown) {
    return speechRequestFailed(OPENAI_SPEECH_ERROR_LABEL, signal, error);
  }
  return speechFromDecoded(OPENAI_SPEECH_ERROR_LABEL, decoded);
}

/** 读取本次请求的 tts 配置快照；读取失败或未选 OpenAI 协议时记日志并返回 null。 */
function openAiTtsConfig(): OpenAiAgentTtsCapabilityConfig | XAiAgentTtsCapabilityConfig | null {
  let config: AgentTtsCapabilityConfig | undefined;
  try {
    config = getAgentDeploymentConfig().tts;
  } catch (error: unknown) {
    logger.error(`Error calling ${OPENAI_SPEECH_ERROR_LABEL}:`, error);
    return null;
  }
  if (config?.provider === "openai") return config;
  logger.error(`Error calling ${OPENAI_SPEECH_ERROR_LABEL}: agent capability "tts" is not configured for the OpenAI provider.`);
  return null;
}

/** 把一句台词合成为语音；配置不可用、请求失败或无可用载荷时返回 null。 */
export async function synthesizeOpenAiSpeech(request: AiSpeechRequest): Promise<SynthesizedSpeech | null> {
  // 协议与请求字段使用同一份配置快照。
  const tts: OpenAiAgentTtsCapabilityConfig | XAiAgentTtsCapabilityConfig | null = openAiTtsConfig();
  if (tts === null) return null;
  const protocol: OpenAiSpeechProtocol = tts.speechProtocol;
  switch (tts.speechProtocol) {
    case "openai": return synthesizeAudioSpeech(tts, request);
    case "xai": return synthesizeXAiSpeech(tts, request);
    default: {
      const unhandledConfig: never = tts;
      void unhandledConfig;
      logger.error(`Unsupported OpenAI speech protocol: ${String(protocol)}.`);
      return null;
    }
  }
}
