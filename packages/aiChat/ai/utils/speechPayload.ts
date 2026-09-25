/**
 * 语音合成结果载荷的校验与解码。
 *
 * 这里只认 `audio/*` 且体积在上限内；容器是否可解析由 aiChat/ai/voiceEncoding.ts
 * 按 MIME 判定。规范性判定与两道大小上限复用 ./base64Payload.ts 的公共解码闸，
 * 上限按语音自己的常量传入。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  VOICE_SPEECH_MAX_BYTES,
  VOICE_SPEECH_MAX_ENCODED_CHARS,
} from "../../../consts/aiChat/voiceMessage";
import type { Base64PayloadDecodeResult } from "../../../types/aiChat/payload";
import type { SynthesizedSpeechDecodeResult } from "../../../types/aiChat/voiceMessage";
import { decodeBase64Payload } from "./base64Payload";

/**
 * 把一段模型返回的 base64 音频收窄成合成语音。
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
