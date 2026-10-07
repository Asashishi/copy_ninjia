/**
 * Telegram sendVoice 直接接受的两种容器的校验与时长计算：OGG/Opus（OpenAI audio/speech 的
 * `opus`）与 MP3（xAI `/tts` 的 `mp3`）。只走容器结构，不解码音频。
 *
 * OGG/Opus：逐页核对捕获模式与段表长度，首页必须是 OpusHead；时长取最后一个带 granule
 * position 的页减去 pre-skip，按 OPUS_GRANULE_RATE 固定时钟换算。MP3：跳过开头的 ID3v2 标签，逐帧核对
 * MPEG Layer III 帧头并累加样本数，末尾只允许一个 ID3v1 标签；帧间出现其它字节或末帧不完整
 * 即拒绝。时长一律向上取整到整秒。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  ID3V1_MAGIC,
  ID3V1_TAG_BYTES,
  ID3V2_FOOTER_FLAG,
  ID3V2_HEADER_BYTES,
  ID3V2_MAGIC,
  MP3_FRAME_HEADER_BYTES,
  MP3_MPEG1_BITRATES_KBPS,
  MP3_MPEG1_SAMPLE_RATES,
  MP3_MPEG1_SAMPLES_PER_FRAME,
  MP3_MPEG2_BITRATES_KBPS,
  MP3_MPEG2_SAMPLE_RATES,
  MP3_MPEG2_SAMPLES_PER_FRAME,
  MP3_MPEG25_SAMPLE_RATES,
  OGG_CAPTURE_PATTERN,
  OGG_GRANULE_UNSET_WORD,
  OGG_PAGE_HEADER_BYTES,
  OPUS_GRANULE_RATE,
  OPUS_HEAD_MAGIC,
  OPUS_HEAD_MIN_BYTES,
} from "../../../consts/audio";
import type { VoiceContainerProbeResult } from "../../../types/aiChat/voiceMessage";

/** bytes 在 offset 处是否逐字节等于 ASCII 串 text；越界视为不等。 */
function hasAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.byteLength) return false;
  for (let index: number = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * 校验单路 OGG/Opus 并算出时长。
 * @param bytes 完整响应体字节。
 */
export function probeOggOpus(bytes: Uint8Array): VoiceContainerProbeResult {
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset: number = 0;
  let preSkip: number = -1;
  let granule: number = -1;
  while (offset < bytes.byteLength) {
    if (offset + OGG_PAGE_HEADER_BYTES > bytes.byteLength) return { ok: false, reason: "truncated Ogg page" };
    if (!hasAscii(bytes, offset, OGG_CAPTURE_PATTERN)) return { ok: false, reason: "not an Ogg Opus stream" };
    // 页头最后一个字节是段数，其后紧跟段表，段表各项之和即页体长度。
    const segments: number = bytes[offset + OGG_PAGE_HEADER_BYTES - 1]!;
    const bodyStart: number = offset + OGG_PAGE_HEADER_BYTES + segments;
    if (bodyStart > bytes.byteLength) return { ok: false, reason: "truncated Ogg page" };
    let bodyLength: number = 0;
    for (let index: number = 0; index < segments; index++) bodyLength += bytes[offset + OGG_PAGE_HEADER_BYTES + index]!;
    if (bodyStart + bodyLength > bytes.byteLength) return { ok: false, reason: "truncated Ogg page" };
    if (preSkip === -1) {
      if (bodyLength < OPUS_HEAD_MIN_BYTES || !hasAscii(bytes, bodyStart, OPUS_HEAD_MAGIC)) {
        return { ok: false, reason: "not an Ogg Opus stream" };
      }
      // 魔数之后依次是 1 字节版本、1 字节声道数、2 字节小端 pre-skip。
      preSkip = view.getUint16(bodyStart + OPUS_HEAD_MAGIC.length + 2, true);
    }
    // granule position 是页头第 6～13 字节的 64 位小端整数。
    const granuleLow: number = view.getUint32(offset + 6, true);
    const granuleHigh: number = view.getUint32(offset + 10, true);
    if (granuleLow !== OGG_GRANULE_UNSET_WORD || granuleHigh !== OGG_GRANULE_UNSET_WORD) {
      // 高 32 位非 0 的 granule 不属于一段语音。
      if (granuleHigh !== 0) return { ok: false, reason: "invalid Ogg granule position" };
      granule = granuleLow;
    }
    offset = bodyStart + bodyLength;
  }
  if (preSkip === -1) return { ok: false, reason: "not an Ogg Opus stream" };
  if (granule <= preSkip) return { ok: false, reason: "invalid Ogg granule position" };
  return { ok: true, durationSeconds: Math.ceil((granule - preSkip) / OPUS_GRANULE_RATE) };
}

/** 开头 ID3v2 标签之后第一个字节的位置；没有标签时为 0，标签长度字段非法时为 -1。 */
function id3v2End(bytes: Uint8Array): number {
  if (!hasAscii(bytes, 0, ID3V2_MAGIC)) return 0;
  if (bytes.byteLength < ID3V2_HEADER_BYTES) return -1;
  // 标签头第 5 字节是 flags，第 6～9 字节是每字节 7 位的 syncsafe 长度。
  let size: number = 0;
  for (let index: number = 6; index < ID3V2_HEADER_BYTES; index++) {
    const byte: number = bytes[index]!;
    if (byte >= 0x80) return -1;
    size = size * 0x80 + byte;
  }
  const footer: number = (bytes[5]! & ID3V2_FOOTER_FLAG) === 0 ? 0 : ID3V2_HEADER_BYTES;
  return ID3V2_HEADER_BYTES + size + footer;
}

/**
 * 校验 MPEG Layer III 帧序列并算出时长。
 * @param bytes 完整响应体字节。
 */
export function probeMp3(bytes: Uint8Array): VoiceContainerProbeResult {
  let offset: number = id3v2End(bytes);
  if (offset === -1) return { ok: false, reason: "not an MP3 stream" };
  let samples: number = 0;
  let sampleRate: number = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset === ID3V1_TAG_BYTES && hasAscii(bytes, offset, ID3V1_MAGIC)) break;
    if (offset + MP3_FRAME_HEADER_BYTES > bytes.byteLength) return { ok: false, reason: "truncated MP3 frame" };
    const second: number = bytes[offset + 1]!;
    const third: number = bytes[offset + 2]!;
    // 帧同步 11 bit 全 1；版本 01 保留；层 01 为 Layer III；码率索引 0（free format）与 15、采样率索引 3 非法。
    const version: number = (second >> 3) & 0b11;
    const bitrateIndex: number = third >> 4;
    const rateIndex: number = (third >> 2) & 0b11;
    if (
      bytes[offset] !== 0xFF || (second & 0xE0) !== 0xE0 ||
      version === 0b01 || ((second >> 1) & 0b11) !== 0b01 ||
      bitrateIndex === 0 || bitrateIndex === 0b1111 || rateIndex === 0b11
    ) {
      return { ok: false, reason: "not an MP3 stream" };
    }
    const mpeg1: boolean = version === 0b11;
    const kbps: number = (mpeg1 ? MP3_MPEG1_BITRATES_KBPS : MP3_MPEG2_BITRATES_KBPS)[bitrateIndex]!;
    const rate: number = (mpeg1 ? MP3_MPEG1_SAMPLE_RATES : version === 0b10 ? MP3_MPEG2_SAMPLE_RATES : MP3_MPEG25_SAMPLE_RATES)[rateIndex]!;
    if (sampleRate !== 0 && rate !== sampleRate) return { ok: false, reason: "not an MP3 stream" };
    sampleRate = rate;
    const frameSamples: number = mpeg1 ? MP3_MPEG1_SAMPLES_PER_FRAME : MP3_MPEG2_SAMPLES_PER_FRAME;
    // 帧长（字节）= 每帧样本数 / 8 × 码率（bps）/ 采样率，再加 1 字节填充位。
    const frameLength: number = Math.floor(frameSamples / 8 * kbps * 1_000 / rate) + ((third >> 1) & 1);
    if (offset + frameLength > bytes.byteLength) return { ok: false, reason: "truncated MP3 frame" };
    samples += frameSamples;
    offset += frameLength;
  }
  if (samples === 0) return { ok: false, reason: "not an MP3 stream" };
  return { ok: true, durationSeconds: Math.ceil(samples / sampleRate) };
}
