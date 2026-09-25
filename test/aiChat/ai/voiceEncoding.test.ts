/**
 * 语音编码：WAV → OGG/Opus。用真实 libopus WASM 编码，核对 OGG 页结构、
 * OpusHead 声明的原始采样率与收尾页的 granule 时长；非 WAV MIME 与 WAV 解析
 * 失败原样带回原因；编码器抛错时记原始错误并归一成失败原因。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { sineWav, wav } from "../../helpers/wav";
import type { VoiceEncodeResult } from "../../../packages/types/aiChat/voiceMessage";
import type opus from "@audio/encode-opus";

const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { encodeVoiceMessage } = await import("../../../packages/aiChat/ai/voiceEncoding");

interface OggPage {
  readonly headerType: number;
  readonly granule: bigint;
  readonly body: Uint8Array;
}

function oggPages(bytes: Uint8Array): OggPage[] {
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages: OggPage[] = [];
  let offset: number = 0;
  while (offset < bytes.byteLength) {
    expect(new TextDecoder().decode(bytes.subarray(offset, offset + 4))).toBe("OggS");
    const segments: number = bytes[offset + 26]!;
    let length: number = 0;
    for (let index: number = 0; index < segments; index++) length += bytes[offset + 27 + index]!;
    const bodyStart: number = offset + 27 + segments;
    pages.push({
      headerType: bytes[offset + 5]!,
      granule: view.getBigInt64(offset + 6, true),
      body: bytes.subarray(bodyStart, bodyStart + length),
    });
    offset = bodyStart + length;
  }
  return pages;
}

beforeEach(() => {
  loggerError.mockClear();
});

describe("encodeVoiceMessage", () => {
  test("WAV 编码成 OGG/Opus：首页 OpusHead、末页 EOS，granule 对应原始时长", async () => {
    const result: VoiceEncodeResult = await encodeVoiceMessage({
      bytes: sineWav(24_000, 1.5),
      mimeType: "audio/wav",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voice.durationSeconds).toBe(2);

    const pages: OggPage[] = oggPages(result.voice.bytes);
    const head: Uint8Array = pages[0]!.body;
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe("OpusHead");
    expect(head[9]).toBe(1);
    const headView: DataView = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(headView.getUint32(12, true)).toBe(24_000);
    expect(new TextDecoder().decode(pages[1]!.body.subarray(0, 8))).toBe("OpusTags");

    const last: OggPage = pages.at(-1)!;
    expect(last.headerType & 0x04).toBe(0x04);
    const preSkip: number = headView.getUint16(10, true);
    expect(Number(last.granule) - preSkip).toBe(1.5 * 48_000);
  });

  test("MIME 带参数与大小写差异时按类型本体判定", async () => {
    const result: VoiceEncodeResult = await encodeVoiceMessage({
      bytes: sineWav(16_000, 0.2),
      mimeType: "Audio/X-WAV; codec=pcm",
    });
    expect(result.ok && result.voice.durationSeconds).toBe(1);
  });

  test("非 WAV 容器与 WAV 解析失败带原因返回，不调用编码器", async () => {
    await expect(encodeVoiceMessage({ bytes: sineWav(24_000, 0.1), mimeType: "audio/mp3" }))
      .resolves.toEqual({ ok: false, reason: "unsupported speech mime type" });
    await expect(encodeVoiceMessage({ bytes: wav([]), mimeType: "audio/wav" }))
      .resolves.toEqual({ ok: false, reason: "missing fmt chunk" });
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe("encodeVoiceMessage 编码器失败", () => {
  test("编码器抛错时记原始错误并返回 opus encoder failed", async () => {
    // 模块命名空间是活绑定，mock 之后会跟着变；先取出真实函数值再替换。
    const realOpus: typeof opus = (await import("@audio/encode-opus")).default;
    const failure: Error = new Error("wasm trap");
    mock.module("@audio/encode-opus", () => ({
      default: async (): Promise<unknown> => {
        throw failure;
      },
    }));
    try {
      await expect(encodeVoiceMessage({ bytes: sineWav(24_000, 0.1), mimeType: "audio/wav" }))
        .resolves.toEqual({ ok: false, reason: "opus encoder failed" });
      expect(loggerError).toHaveBeenCalledWith("Voice message Opus encoding failed:", failure);
    } finally {
      // 恢复真实导出，随机顺序下其余用例仍走真实编码器。
      mock.module("@audio/encode-opus", () => ({ default: realOpus }));
    }
  });
});
