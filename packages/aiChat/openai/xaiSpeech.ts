/**
 * xai 语音协议：以 Bun 原生 fetch 调 xAI `POST <base_url>/tts`，把一句台词合成为 MP3。
 *
 * xAI TTS 的请求体与 OpenAI audio/speech 不兼容（`text`、`voice_id`、`language`、
 * `output_format`，没有模型名与风格指令），因此不经 OpenAI SDK，认证只用 api_key 的
 * Bearer 头。部署配置在 xai 协议下不接受 model 与 style（见 config/agentCapability.ts），
 * 本句语气（tone）没有对应字段，不发送。`output_format` 钉为 XAI_SPEECH_CODEC（MP3）、
 * XAI_SPEECH_SAMPLE_RATE 与 XAI_SPEECH_BIT_RATE；响应体按 MP3_MIME_TYPE 交回，由编码侧校验帧
 * 结构后原样发送。
 *
 * 整次调用受 OPENAI_SPEECH_REQUEST_TIMEOUT_MS 的 deadline 约束：网络错误与 408/429/5xx
 * 在 deadline 内最多尝试 OPENAI_SPEECH_REQUEST_ATTEMPTS 次，退避从
 * XAI_SPEECH_RETRY_BASE_DELAY_MS 起逐次翻倍；其余非 2xx（含 3xx）直接失败。请求不跟随
 * 重定向（`redirect: "manual"`），Authorization 头只发往配置的端点。非 2xx 的响应体按
 * XAI_SPEECH_ERROR_BODY_MAX_BYTES 有界读入错误日志。响应不带用量或费用，收到 2xx 时按
 * missing 记一次有界诊断。
 *
 * 失败返回 null 并记一行英文错误日志；调用方 signal 已中止时静默返回 null，绝不抛错。
 * 所属线程：AI 闲聊 Worker；本模块不持有缓存。
 */

import { MP3_MIME_TYPE } from "../../consts/audio";
import {
  OPENAI_SPEECH_REQUEST_ATTEMPTS,
  OPENAI_SPEECH_REQUEST_TIMEOUT_MS,
  XAI_API_BASE_URL,
  XAI_SPEECH_BIT_RATE,
  XAI_SPEECH_CODEC,
  XAI_SPEECH_ENDPOINT_PATH,
  XAI_SPEECH_ERROR_BODY_MAX_BYTES,
  XAI_SPEECH_ERROR_LABEL,
  XAI_SPEECH_RETRY_BASE_DELAY_MS,
  XAI_SPEECH_SAMPLE_RATE,
} from "../../consts/aiChat/openai";
import { warnAiUsageUnavailable } from "../../infra/aiCacheUsage";
import { signalWithTimeout } from "../../libs/abortSignal";
import { discardResponseBody, readBoundedResponseText } from "../../libs/boundedResponse";
import { sleep } from "../../libs/sleep";
import { readSpeechBody, speechFromDecoded, speechRequestFailed } from "../ai/utils/speechPayload";
import type { AiSpeechRequest } from "../../types/aiChat/provider";
import type { SynthesizedSpeech, SynthesizedSpeechDecodeResult } from "../../types/aiChat/voiceMessage";
import type { XAiAgentTtsCapabilityConfig } from "../../types/config";

/** 按 base_url 拼出 `/tts` 端点；base_url 缺省时走 XAI_API_BASE_URL。 */
function xAiSpeechUrl(baseUrl: string | undefined): URL {
  const base: string = baseUrl ?? XAI_API_BASE_URL;
  return new URL(XAI_SPEECH_ENDPOINT_PATH, base.endsWith("/") ? base : `${base}/`);
}

/** 值得在 deadline 内重试的响应状态：408、429 与 5xx。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 第 attempt 次尝试失败后的退避（ms）。 */
function retryDelayMs(attempt: number): number {
  return XAI_SPEECH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

/** 非 2xx 响应归一成带状态码与有界响应体的错误。 */
async function httpStatusError(response: Response): Promise<Error> {
  const detail: string | null = await readBoundedResponseText(response, XAI_SPEECH_ERROR_BODY_MAX_BYTES);
  return new Error(`HTTP ${response.status}: ${detail ?? `error body exceeds ${XAI_SPEECH_ERROR_BODY_MAX_BYTES} bytes`}`);
}

/**
 * 发送 `/tts` 请求直到拿到 2xx；重试口径见模块头注。signal 中止、尝试用尽或不可重试的
 * 状态码时抛错。
 */
async function requestXAiSpeech(
  tts: XAiAgentTtsCapabilityConfig,
  text: string,
  signal: AbortSignal
): Promise<Response> {
  const url: URL = xAiSpeechUrl(tts.baseUrl);
  const body: string = JSON.stringify({
    text,
    voice_id: tts.voice,
    language: tts.language,
    output_format: { codec: XAI_SPEECH_CODEC, sample_rate: XAI_SPEECH_SAMPLE_RATE, bit_rate: XAI_SPEECH_BIT_RATE },
  });
  for (let attempt: number = 1; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${tts.apiKey}`, "content-type": "application/json" },
        body,
        redirect: "manual",
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted || attempt >= OPENAI_SPEECH_REQUEST_ATTEMPTS) throw error;
      await sleep(retryDelayMs(attempt), signal);
      continue;
    }
    if (response.ok) return response;
    if (!isRetryableStatus(response.status) || attempt >= OPENAI_SPEECH_REQUEST_ATTEMPTS) {
      throw await httpStatusError(response);
    }
    await discardResponseBody(response);
    await sleep(retryDelayMs(attempt), signal);
  }
}

/**
 * 按 xai 协议把一句台词合成为 MP3 语音；请求失败或响应体超限时返回 null。
 * @param tts 调用方从同一份配置快照取出的 xai 协议配置。
 * @param request 台词与调用方 signal；tone 在本协议下不发送。
 */
export async function synthesizeXAiSpeech(
  tts: XAiAgentTtsCapabilityConfig,
  { text, signal }: AiSpeechRequest
): Promise<SynthesizedSpeech | null> {
  const requestSignal: AbortSignal = signalWithTimeout(signal, OPENAI_SPEECH_REQUEST_TIMEOUT_MS);
  let decoded: SynthesizedSpeechDecodeResult;
  try {
    const response: Response = await requestXAiSpeech(tts, text, requestSignal);
    warnAiUsageUnavailable("tts", "openai", "missing");
    decoded = await readSpeechBody(response, MP3_MIME_TYPE);
  } catch (error: unknown) {
    return speechRequestFailed(XAI_SPEECH_ERROR_LABEL, signal, error);
  }
  return speechFromDecoded(XAI_SPEECH_ERROR_LABEL, decoded);
}
