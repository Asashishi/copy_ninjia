/**
 * 语音合成结果载荷的校验与解码，两种来源各一个入口：
 *
 * - base64 容器（Gemini）：只认 `audio/*` 且体积在上限内；容器是否可解析由
 *   aiChat/ai/voiceEncoding.ts 按 MIME 判定。规范性判定与两道大小上限复用 ./base64Payload.ts
 *   的公共解码闸，上限按语音自己的常量传入。
 * - 二进制音频响应体（OpenAI audio/speech 的 OGG/Opus 与 xAI `/tts` 的 MP3）：经
 *   libs/boundedResponse.ts 流式读取，超过 VOICE_SPEECH_MAX_BYTES 即拒绝，不保留部分响应体；
 *   容器结构由 aiChat/ai/voiceEncoding.ts 按 MIME 校验。
 *
 * 另有两条三家实现共用的失败收尾（请求失败与载荷不可用），日志统一经 logger。
 *
 * 不持有缓存，不接触 SDK 类型。
 */

import {
  VOICE_SPEECH_MAX_BYTES,
  VOICE_SPEECH_MAX_ENCODED_CHARS,
} from "../../../consts/aiChat/voiceMessage";
import { logger } from "../../../infra/logger";
import { readBoundedResponseBytes } from "../../../libs/boundedResponse";
import type { BoundedResponseResult } from "../../../libs/boundedResponse";
import type { Base64PayloadDecodeResult } from "../../../types/aiChat/payload";
import type { SynthesizedSpeech, SynthesizedSpeechDecodeResult } from "../../../types/aiChat/voiceMessage";
import { decodeBase64Payload } from "./base64Payload";

/**
 * 把一段模型返回的 base64 音频收窄成容器形态的合成语音。
 * @param encoded 标准 base64（无换行）。
 * @param mimeType 供应商声明的音频 MIME；必须以 `audio/` 开头。
 */
export function decodeSynthesizedSpeech(
  encoded: string,
  mimeType: string | undefined
): SynthesizedSpeechDecodeResult {
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/")) {
    return { ok: false, reason: "missing audio mime type" };
  }
  const decoded: Base64PayloadDecodeResult = decodeBase64Payload({
    encoded,
    maxEncodedChars: VOICE_SPEECH_MAX_ENCODED_CHARS,
    maxBytes: VOICE_SPEECH_MAX_BYTES,
  });
  if (!decoded.ok) return decoded;
  return { ok: true, speech: { bytes: decoded.bytes, mimeType } };
}

/**
 * 有界读取一段二进制音频响应体，按请求时指定的格式标上 MIME；容器是否可用由编码侧校验。
 * @param response 已确认 2xx 的响应；本函数负责读完或取消其响应体。
 * @param mimeType 请求时指定格式对应的 MIME（不取响应头，兼容端点的声明不可靠）。
 */
export async function readSpeechBody(response: Response, mimeType: string): Promise<SynthesizedSpeechDecodeResult> {
  const body: BoundedResponseResult = await readBoundedResponseBytes(response, VOICE_SPEECH_MAX_BYTES);
  if (!body.ok) return { ok: false, reason: "audio body exceeds the size limit" };
  return { ok: true, speech: { bytes: body.bytes, mimeType } };
}

/**
 * 合成请求失败的统一收尾：调用方 signal 已中止表示本轮作废，静默收尾；其余失败（含合成
 * 超时）记一行 `Error calling <label>` 日志。恒返回 null。
 * @param label 日志里的供应商接口名。
 */
export function speechRequestFailed(label: string, signal: AbortSignal | undefined, error: unknown): null {
  if (signal?.aborted !== true) logger.error(`Error calling ${label}:`, error);
  return null;
}

/** 载荷解码结果的统一收尾：不可用时记一行日志并返回 null，否则返回合成语音。 */
export function speechFromDecoded(label: string, decoded: SynthesizedSpeechDecodeResult): SynthesizedSpeech | null {
  if (decoded.ok) return decoded.speech;
  logger.error(`${label} returned an unusable audio payload: ${decoded.reason}.`);
  return null;
}
