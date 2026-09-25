/**
 * 合成语音 WAV 解析：只收单声道 16 bit PCM，逐块推进（含奇数长度补齐），
 * 越界、缺块与不支持的样本格式一律带原因拒绝。
 */

import { describe, expect, test } from "bun:test";
import { decodeWavPcm } from "../../../../packages/aiChat/ai/utils/wavPcm";
import type { WavPcmDecodeFailure, WavPcmDecodeResult } from "../../../../packages/types/aiChat/voiceMessage";
import { dataChunk, fmtChunk, wav } from "../../../helpers/wav";
import type { WavChunk } from "../../../helpers/wav";

describe("decodeWavPcm", () => {
  test("单声道 16 bit PCM 归一到 [-1, 1)，并带回采样率", () => {
    const result: WavPcmDecodeResult = decodeWavPcm(wav([fmtChunk({ sampleRate: 24_000 }), dataChunk([0, 16_384, -32_768, 32_767])]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sampleRate).toBe(24_000);
    expect(Array.from(result.samples)).toEqual([0, 0.5, -1, 32_767 / 32_768]);
  });

  test("跳过奇数长度的其它子块及其补齐字节", () => {
    const list: WavChunk = { id: "LIST", body: new Uint8Array([1, 2, 3]) };
    const result: WavPcmDecodeResult = decodeWavPcm(wav([fmtChunk({ sampleRate: 16_000 }), list, dataChunk([100])]));
    expect(result.ok && result.samples.length).toBe(1);
  });

  test("字节视图带偏移时按视图读取", () => {
    const inner: Uint8Array = wav([fmtChunk({ sampleRate: 8_000 }), dataChunk([1, 2])]);
    const padded: Uint8Array = new Uint8Array(inner.byteLength + 3);
    padded.set(inner, 3);
    const result: WavPcmDecodeResult = decodeWavPcm(padded.subarray(3));
    expect(result.ok && result.sampleRate).toBe(8_000);
  });

  test.each([
    ["not a RIFF/WAVE container", new Uint8Array([1, 2, 3])],
    ["not a RIFF/WAVE container", wav([fmtChunk({ sampleRate: 24_000 }), dataChunk([1])], "AVI ")],
    ["unsupported sample format", wav([fmtChunk({ sampleRate: 24_000, channels: 2 }), dataChunk([1])])],
    ["unsupported sample format", wav([fmtChunk({ sampleRate: 24_000, bits: 8 }), dataChunk([1])])],
    ["unsupported sample format", wav([fmtChunk({ sampleRate: 24_000, format: 3 }), dataChunk([1])])],
    ["unsupported sample format", wav([fmtChunk({ sampleRate: 0 }), dataChunk([1])])],
    ["unsupported sample format", wav([{ id: "fmt ", body: new Uint8Array(8) }, dataChunk([1])])],
    ["missing fmt chunk", wav([dataChunk([1])])],
    ["missing fmt chunk", wav([])],
    ["missing data chunk", wav([fmtChunk({ sampleRate: 24_000 })])],
    ["truncated chunk", wav([fmtChunk({ sampleRate: 24_000 }), { ...dataChunk([1]), declaredSize: 400 }])],
    ["empty audio", wav([fmtChunk({ sampleRate: 24_000 }), { id: "data", body: new Uint8Array(1) }])],
  ] as const)("拒绝：%s", (reason: WavPcmDecodeFailure, bytes: Uint8Array) => {
    expect(decodeWavPcm(bytes)).toEqual({ ok: false, reason });
  });
});
