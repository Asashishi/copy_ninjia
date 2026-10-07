/**
 * 把供应商合成的语音转成 Telegram 语音消息，按 MIME 分三路：
 *
 * - OGG/Opus（OGG_OPUS_MIME_TYPE）与 MP3（MP3_MIME_TYPE）：Telegram sendVoice 直接接受，只经
 *   utils/voiceContainer.ts 校验容器并算出时长，字节复制成独占 buffer 后原样发送，不转码。
 * - WAV（见 consts/audio.ts 的 WAV_MIME_TYPES）：先由 utils/wavPcm.ts 取出单声道 PCM，再按
 *   VOICE_OPUS_ENCODE_CHUNK_SECONDS 分块重采样到 OPUS_RATE、交给 @audio/encode-opus 编码，块间让出
 *   AI Worker 事件循环，最后收尾。编码器按 OPUS_RATE 输入建立，OpusHead 的输入采样率字段因此为
 *   OPUS_RATE。单块同步占用与音频总时长无关；台词长度由 AI 工具和运维入口分别限制。
 * - 其余 MIME 返回 `unsupported speech mime type`。
 *
 * 失败一律返回带原因的结果，不抛错；编码器异常在这里记下原始错误，其余原因由
 * 调用方记日志。所属线程：AI 闲聊 Worker，
 * 本模块自身不持有缓存（WASM 模块由依赖在本 isolate 内首次编码时编译一次）。
 */

import opus from "@audio/encode-opus";
import type { StreamEncoder } from "@audio/encode-opus";
import { OPUS_RATE, toOpusRate } from "@audio/encode-opus/core";
import { MP3_MIME_TYPE, OGG_OPUS_MIME_TYPE, WAV_MIME_TYPES } from "../../consts/audio";
import { logger } from "../../infra/logger";
import {
  VOICE_MP3_FILE_NAME,
  VOICE_OGG_FILE_NAME,
  VOICE_OPUS_APPLICATION,
  VOICE_OPUS_BITRATE_KBPS,
  VOICE_OPUS_COMPLEXITY,
  VOICE_OPUS_ENCODE_CHUNK_SECONDS,
  VOICE_OPUS_RESAMPLE_CONTEXT_SAMPLES,
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

/** 最大公约数；用来求重采样比的既约分子分母。 */
function greatestCommonDivisor(left: number, right: number): number {
  let a: number = left;
  let b: number = right;
  while (b !== 0) {
    const remainder: number = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

/**
 * 把单声道 PCM 分块重采样到 OPUS_RATE 并逐块编码，块间让出事件循环，返回各块产出的 OGG 页。
 *
 * 编码器按 OPUS_RATE 输入建立，重采样由依赖导出的 toOpusRate 逐块完成：每块前后各带
 * VOICE_OPUS_RESAMPLE_CONTEXT_SAMPLES 个输入样本的上下文，只取本块对应的输出，拼起来与整段一次
 * 重采样相同。块起点与上下文长度都取重采样比既约分母的倍数，保证本块输出在整段输出中的起点是
 * 整数下标。
 */
async function encodePcmInChunks(
  encoder: StreamEncoder,
  samples: Float32Array,
  sampleRate: number
): Promise<Uint8Array[]> {
  const divisor: number = greatestCommonDivisor(OPUS_RATE, sampleRate);
  const numerator: number = OPUS_RATE / divisor;
  const denominator: number = sampleRate / divisor;
  const step: number =
    Math.max(1, Math.round(sampleRate * VOICE_OPUS_ENCODE_CHUNK_SECONDS / denominator)) * denominator;
  const context: number = Math.ceil(VOICE_OPUS_RESAMPLE_CONTEXT_SAMPLES / denominator) * denominator;
  const pages: Uint8Array[] = [];
  for (let start: number = 0; start < samples.length; start += step) {
    const end: number = Math.min(samples.length, start + step);
    const windowStart: number = Math.max(0, start - context);
    const resampled: Float32Array = toOpusRate(
      [samples.subarray(windowStart, Math.min(samples.length, end + context))],
      sampleRate
    );
    const offset: number = (start - windowStart) / denominator * numerator;
    const count: number = end === samples.length
      ? resampled.length - offset
      : (end - start) / denominator * numerator;
    pages.push(encoder.encode([resampled.subarray(offset, offset + count)]));
    // 块间让出事件循环，排队的 Worker 消息与已到期的 timer 先执行。
    await Bun.sleep(0);
  }
  return pages;
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
  let pages: Uint8Array[];
  try {
    const encoder: StreamEncoder = await opus({
      sampleRate: OPUS_RATE,
      channels: 1,
      bitrate: VOICE_OPUS_BITRATE_KBPS,
      application: VOICE_OPUS_APPLICATION,
      complexity: VOICE_OPUS_COMPLEXITY,
    });
    try {
      pages = await encodePcmInChunks(encoder, pcm.samples, pcm.sampleRate);
      // flush 写出末页并释放编码器；异常路径由 finally 的 free 兜底（重复 free 为空操作）。
      pages.push(encoder.flush());
    } finally {
      encoder.free();
    }
  } catch (error: unknown) {
    logger.error("Voice message Opus encoding failed:", error);
    return { ok: false, reason: "opus encoder failed" };
  }
  let byteLength: number = 0;
  for (const page of pages) byteLength += page.byteLength;
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(byteLength);
  let offset: number = 0;
  for (const page of pages) {
    bytes.set(page, offset);
    offset += page.byteLength;
  }
  return {
    ok: true,
    voice: {
      bytes,
      durationSeconds: Math.ceil(pcm.samples.length / pcm.sampleRate),
      fileName: VOICE_OGG_FILE_NAME,
    },
  };
}
