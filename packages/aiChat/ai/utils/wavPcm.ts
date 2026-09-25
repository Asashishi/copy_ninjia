/**
 * 合成语音的 WAV 容器解析：只接受单声道、16 bit 整数 PCM，逐块走 RIFF 子块，
 * 取出 `fmt ` 的采样率与 `data` 的样本，并把样本归一到 [-1, 1) 的 Float32。
 *
 * 子块按声明长度推进，奇数长度补一个填充字节；任何子块越界即判截断，不猜测
 * 剩余字节的含义。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  WAV_CHUNK_HEADER_BYTES,
  WAV_FMT_MIN_BYTES,
  WAV_FORMAT_PCM,
  WAV_MONO_CHANNELS,
  WAV_PCM16_BITS,
  WAV_PCM16_SCALE,
  WAV_RIFF_HEADER_BYTES,
} from "../../../consts/audio";
import type { WavPcmDecodeResult } from "../../../types/aiChat/voiceMessage";

/** 读 4 字节 ASCII 标识；调用方已保证不越界。 */
function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

/**
 * 解析单声道 16 bit PCM WAV。
 * @param bytes 完整 WAV 文件字节。
 * @returns 归一化样本与采样率，或带原因的失败。
 */
export function decodeWavPcm(bytes: Uint8Array): WavPcmDecodeResult {
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < WAV_RIFF_HEADER_BYTES ||
    fourCc(view, 0) !== "RIFF" ||
    fourCc(view, 8) !== "WAVE"
  ) {
    return { ok: false, reason: "not a RIFF/WAVE container" };
  }
  let sampleRate: number = 0;
  let offset: number = WAV_RIFF_HEADER_BYTES;
  while (offset + WAV_CHUNK_HEADER_BYTES <= bytes.byteLength) {
    const id: string = fourCc(view, offset);
    const size: number = view.getUint32(offset + 4, true);
    const bodyStart: number = offset + WAV_CHUNK_HEADER_BYTES;
    if (bodyStart + size > bytes.byteLength) return { ok: false, reason: "truncated chunk" };
    if (id === "fmt ") {
      if (size < WAV_FMT_MIN_BYTES) return { ok: false, reason: "unsupported sample format" };
      const format: number = view.getUint16(bodyStart, true);
      const channels: number = view.getUint16(bodyStart + 2, true);
      const bits: number = view.getUint16(bodyStart + 14, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      if (
        format !== WAV_FORMAT_PCM ||
        channels !== WAV_MONO_CHANNELS ||
        bits !== WAV_PCM16_BITS ||
        sampleRate === 0
      ) {
        return { ok: false, reason: "unsupported sample format" };
      }
    } else if (id === "data") {
      if (sampleRate === 0) return { ok: false, reason: "missing fmt chunk" };
      const count: number = size >> 1;
      if (count === 0) return { ok: false, reason: "empty audio" };
      const samples: Float32Array = new Float32Array(count);
      for (let index: number = 0; index < count; index++) {
        samples[index] = view.getInt16(bodyStart + index * 2, true) / WAV_PCM16_SCALE;
      }
      return { ok: true, samples, sampleRate };
    }
    offset = bodyStart + size + (size & 1);
  }
  return { ok: false, reason: sampleRate === 0 ? "missing fmt chunk" : "missing data chunk" };
}
