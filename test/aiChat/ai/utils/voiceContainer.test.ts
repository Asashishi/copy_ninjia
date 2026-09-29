/**
 * Telegram 直发容器校验：OGG/Opus 用本地编码器的真实产物核对页结构与 granule 时长，
 * MP3 用合成帧序列核对帧头、ID3 标签、截断与混杂字节。
 */

import { describe, expect, test } from "bun:test";
import { probeMp3, probeOggOpus } from "../../../../packages/aiChat/ai/utils/voiceContainer";
import { encodeVoiceMessage } from "../../../../packages/aiChat/ai/voiceEncoding";
import type { VoiceContainerProbeResult, VoiceEncodeResult } from "../../../../packages/types/aiChat/voiceMessage";
import { concatBytes, id3v1Tag, id3v2Tag, mp3Frame, mp3Frames, MPEG2_24K_64K_FRAME_BYTES } from "../../../helpers/mp3";
import { sineWav } from "../../../helpers/wav";

/** 用真实 Opus 编码器产出一段 OGG/Opus。 */
async function realOggOpus(seconds: number): Promise<Uint8Array> {
  const result: VoiceEncodeResult = await encodeVoiceMessage({ bytes: sineWav(24_000, seconds), mimeType: "audio/wav" });
  if (!result.ok) throw new Error(result.reason);
  return result.voice.bytes;
}

/** 把第 pageIndex 页的 granule position 改写成 [低 32 位, 高 32 位]。 */
function withGranule(bytes: Uint8Array, pageIndex: number, [low, high]: readonly [number, number]): Uint8Array {
  const copy: Uint8Array = bytes.slice();
  const view: DataView = new DataView(copy.buffer);
  let offset: number = 0;
  for (let page: number = 0; page < pageIndex; page++) {
    const segments: number = copy[offset + 26]!;
    let body: number = 0;
    for (let index: number = 0; index < segments; index++) body += copy[offset + 27 + index]!;
    offset += 27 + segments + body;
  }
  view.setUint32(offset + 6, low, true);
  view.setUint32(offset + 10, high, true);
  return copy;
}

/** 页数。 */
function pageCount(bytes: Uint8Array): number {
  let offset: number = 0;
  let pages: number = 0;
  while (offset < bytes.byteLength) {
    const segments: number = bytes[offset + 26]!;
    let body: number = 0;
    for (let index: number = 0; index < segments; index++) body += bytes[offset + 27 + index]!;
    offset += 27 + segments + body;
    pages++;
  }
  return pages;
}

describe("probeOggOpus", () => {
  test("本地编码器产物：时长取末页 granule 减 pre-skip，向上取整", async () => {
    expect(probeOggOpus(await realOggOpus(1.5))).toEqual({ ok: true, durationSeconds: 2 });
    expect(probeOggOpus(await realOggOpus(0.2))).toEqual({ ok: true, durationSeconds: 1 });
  });

  test("字节视图带偏移时按视图读取", async () => {
    const ogg: Uint8Array = await realOggOpus(1);
    const padded: Uint8Array = new Uint8Array(ogg.byteLength + 5);
    padded.set(ogg, 5);
    expect(probeOggOpus(padded.subarray(5))).toEqual({ ok: true, durationSeconds: 1 });
  });

  test("不是 Ogg、首页不是 OpusHead、截断页与空输入带原因拒绝", async () => {
    const ogg: Uint8Array = await realOggOpus(1);
    const cases: readonly [Uint8Array, VoiceContainerProbeResult][] = [
      [new Uint8Array(), { ok: false, reason: "not an Ogg Opus stream" }],
      [mp3Frames(3), { ok: false, reason: "not an Ogg Opus stream" }],
      [new Uint8Array(10), { ok: false, reason: "truncated Ogg page" }],
      [new Uint8Array(64), { ok: false, reason: "not an Ogg Opus stream" }],
      [ogg.subarray(0, ogg.byteLength - 1), { ok: false, reason: "truncated Ogg page" }],
      [ogg.subarray(0, 20), { ok: false, reason: "truncated Ogg page" }],
      [concatBytes([ogg, new Uint8Array([1, 2, 3])]), { ok: false, reason: "truncated Ogg page" }],
    ];
    for (const [bytes, expected] of cases) expect(probeOggOpus(bytes)).toEqual(expected);
    const notOpus: Uint8Array = ogg.slice();
    notOpus.set(new TextEncoder().encode("OpusTail"), 28);
    expect(probeOggOpus(notOpus)).toEqual({ ok: false, reason: "not an Ogg Opus stream" });
  });

  test("末页未设 granule 时沿用前一个有效页；没有超过 pre-skip 的 granule 或高位非 0 时拒绝", async () => {
    const ogg: Uint8Array = await realOggOpus(2);
    const pages: number = pageCount(ogg);
    expect(pages).toBeGreaterThan(3);
    const lastUnset: Uint8Array = withGranule(ogg, pages - 1, [0xFFFF_FFFF, 0xFFFF_FFFF]);
    const shortened: VoiceContainerProbeResult = probeOggOpus(lastUnset);
    expect(shortened.ok).toBe(true);

    let headerOnly: Uint8Array = ogg;
    for (let page: number = 1; page < pages; page++) headerOnly = withGranule(headerOnly, page, [0, 0]);
    expect(probeOggOpus(headerOnly)).toEqual({ ok: false, reason: "invalid Ogg granule position" });
    expect(probeOggOpus(withGranule(ogg, pages - 1, [0, 1]))).toEqual({ ok: false, reason: "invalid Ogg granule position" });
  });
});

describe("probeMp3", () => {
  test("MPEG-2 Layer III 帧序列：样本数累加后按采样率向上取整", () => {
    // 42 帧 × 576 / 24000 = 1.008 秒。
    expect(probeMp3(mp3Frames(42))).toEqual({ ok: true, durationSeconds: 2 });
    expect(probeMp3(mp3Frames(41))).toEqual({ ok: true, durationSeconds: 1 });
  });

  test("MPEG-1 44.1 kHz 按 1152 样本/帧与填充位计算帧长", () => {
    // 128 kbps、44.1 kHz：144 × 128000 / 44100 = 417 字节，带填充 418 字节。
    const frames: Uint8Array = concatBytes([
      mp3Frame({ version: 0b11, bitrateIndex: 9, sampleRateIndex: 0, length: 417 }),
      mp3Frame({ version: 0b11, bitrateIndex: 9, sampleRateIndex: 0, padding: true, length: 418 }),
    ]);
    expect(probeMp3(frames)).toEqual({ ok: true, durationSeconds: 1 });
  });

  test("跳过开头的 ID3v2 标签，接受末尾恰好一个 ID3v1 标签", () => {
    expect(probeMp3(concatBytes([id3v2Tag(300), mp3Frames(3), id3v1Tag()]))).toEqual({ ok: true, durationSeconds: 1 });
  });

  test("截断的末帧、帧间杂字节、非法帧头、采样率变化与空帧序列带原因拒绝", () => {
    const frames: Uint8Array = mp3Frames(3);
    const cases: readonly [Uint8Array, VoiceContainerProbeResult][] = [
      [frames.subarray(0, frames.byteLength - 1), { ok: false, reason: "truncated MP3 frame" }],
      [concatBytes([frames, new Uint8Array([0xFF, 0xF3])]), { ok: false, reason: "truncated MP3 frame" }],
      [concatBytes([frames, new Uint8Array(8)]), { ok: false, reason: "not an MP3 stream" }],
      [mp3Frame({ bitrateIndex: 0, length: MPEG2_24K_64K_FRAME_BYTES }), { ok: false, reason: "not an MP3 stream" }],
      [mp3Frame({ bitrateIndex: 15, length: MPEG2_24K_64K_FRAME_BYTES }), { ok: false, reason: "not an MP3 stream" }],
      [mp3Frame({ sampleRateIndex: 3, length: MPEG2_24K_64K_FRAME_BYTES }), { ok: false, reason: "not an MP3 stream" }],
      [mp3Frame({ version: 0b01, length: MPEG2_24K_64K_FRAME_BYTES }), { ok: false, reason: "not an MP3 stream" }],
      [concatBytes([frames, mp3Frame({ sampleRateIndex: 0, length: 209 })]), { ok: false, reason: "not an MP3 stream" }],
      [new TextEncoder().encode("OggS"), { ok: false, reason: "not an MP3 stream" }],
      [id3v2Tag(0), { ok: false, reason: "not an MP3 stream" }],
      [new Uint8Array(), { ok: false, reason: "not an MP3 stream" }],
    ];
    for (const [bytes, expected] of cases) expect(probeMp3(bytes)).toEqual(expected);
    const layerTwo: Uint8Array = mp3Frame({ length: MPEG2_24K_64K_FRAME_BYTES });
    layerTwo[1] = (layerTwo[1]! & ~0b110) | (0b10 << 1);
    expect(probeMp3(layerTwo)).toEqual({ ok: false, reason: "not an MP3 stream" });
    const badSyncsafe: Uint8Array = id3v2Tag(4);
    badSyncsafe[7] = 0x80;
    expect(probeMp3(concatBytes([badSyncsafe, frames]))).toEqual({ ok: false, reason: "not an MP3 stream" });
  });
});
