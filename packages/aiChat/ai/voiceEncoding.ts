/**
 * 把供应商合成的语音转成 Telegram 语音消息，按 MIME 分三路：
 *
 * - OGG/Opus（OGG_OPUS_MIME_TYPE）与 MP3（MP3_MIME_TYPE）：Telegram sendVoice 直接接受，只经
 *   utils/voiceContainer.ts 校验容器并算出时长，字节复制成独占 buffer 后原样发送，不转码。
 * - WAV（见 consts/audio.ts 的 WAV_MIME_TYPES）：先由 utils/wavPcm.ts 取出单声道 PCM，再整段
 *   交给 @audio/encode-opus 一次编码并收尾。编码器内部把输入重采样到 48 kHz，并在 OpusHead 里
 *   写入原始采样率。整段一次编码，调用在 AI Worker 线程上同步占用的时长随音频时长增加；台词
 *   长度由 AI 工具和运维入口分别限制。
 * - 其余 MIME 返回 `unsupported speech mime type`。
 *
 * 失败一律返回带原因的结果，不抛错；编码器异常在这里记下原始错误，其余原因由
 * 调用方记日志。所属线程：AI 闲聊 Worker，
 * 本模块自身不持有缓存（WASM 模块由依赖在本 isolate 内首次编码时编译一次）。
 */

import opus from "@audio/encode-opus";
import type { StreamEncoder } from "@audio/encode-opus";
import { MP3_MIME_TYPE, OGG_OPUS_MIME_TYPE, WAV_MIME_TYPES } from "../../consts/audio";
import { logger } from "../../infra/logger";
import {
  VOICE_MP3_FILE_NAME,
  VOICE_OGG_FILE_NAME,
  VOICE_OPUS_APPLICATION,
  VOICE_OPUS_BITRATE_KBPS,
  VOICE_OPUS_COMPLEXITY,
} from "../../consts/aiChat/voiceMessage";
import { probeMp3, probeOggOpus } from "./utils/voiceContainer";
import { decodeWavPcm } from "./utils/wavPcm";
import type {
  SynthesizedSpeech,
  VoiceContainerProbeResult,
  VoiceEncodeResult,
  WavPcmDecodeResult,
} from "../../types/aiChat/voiceMessage";

/** 去掉 MIME 参数并统一小写，只比较类型本体。 */
function mimeEssence(mimeType: string): string {
  const separator: number = mimeType.indexOf(";");
  return (separator === -1 ? mimeType : mimeType.slice(0, separator)).trim().toLowerCase();
}

/**
 * 容器校验通过的直发语音：字节复制成独占 ArrayBuffer（主线程转交时整块转移），带上时长与
 * 与容器一致的文件名。
 */
function directVoice(bytes: Uint8Array, probe: VoiceContainerProbeResult, fileName: string): VoiceEncodeResult {
  if (!probe.ok) return probe;
  return { ok: true, voice: { bytes: bytes.slice(), durationSeconds: probe.durationSeconds, fileName } };
}

/**
 * 把一段合成语音转成可直接 sendVoice 的语音消息。
 * @param speech 供应商返回并已校验大小的合成语音。
 */
export async function encodeVoiceMessage(speech: SynthesizedSpeech): Promise<VoiceEncodeResult> {
  const mimeType: string = mimeEssence(speech.mimeType);
  if (mimeType === OGG_OPUS_MIME_TYPE) return directVoice(speech.bytes, probeOggOpus(speech.bytes), VOICE_OGG_FILE_NAME);
  if (mimeType === MP3_MIME_TYPE) return directVoice(speech.bytes, probeMp3(speech.bytes), VOICE_MP3_FILE_NAME);
  if (!WAV_MIME_TYPES.includes(mimeType)) return { ok: false, reason: "unsupported speech mime type" };
  const pcm: WavPcmDecodeResult = decodeWavPcm(speech.bytes);
  if (!pcm.ok) return pcm;
  let head: Uint8Array;
  let tail: Uint8Array;
  try {
    const encoder: StreamEncoder = await opus({
      sampleRate: pcm.sampleRate,
      channels: 1,
      bitrate: VOICE_OPUS_BITRATE_KBPS,
      application: VOICE_OPUS_APPLICATION,
      complexity: VOICE_OPUS_COMPLEXITY,
    });
    try {
      head = encoder.encode([pcm.samples]);
      // flush 写出末页并释放编码器；异常路径由 finally 的 free 兜底（重复 free 为空操作）。
      tail = encoder.flush();
    } finally {
      encoder.free();
    }
  } catch (error: unknown) {
    logger.error("Voice message Opus encoding failed:", error);
    return { ok: false, reason: "opus encoder failed" };
  }
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(head.byteLength + tail.byteLength);
  bytes.set(head);
  bytes.set(tail, head.byteLength);
  return {
    ok: true,
    voice: {
      bytes,
      durationSeconds: Math.ceil(pcm.samples.length / pcm.sampleRate),
      fileName: VOICE_OGG_FILE_NAME,
    },
  };
}
