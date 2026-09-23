/**
 * 生歌载荷的解码门禁与上传扩展名映射。
 *
 * 解码门禁只认 mime 是否以 audio/ 开头加体积上限，不校验具体容器的魔数；
 * 扩展名映射按容器逐一列出，认不出的容器统一映射为 mp3。
 */

import { describe, expect, test } from "bun:test";
import {
  SONG_GENERATION_MAX_BYTES,
  SONG_GENERATION_MAX_ENCODED_CHARS,
} from "../../../../packages/consts/aiChat/songGeneration";
import { decodeGeneratedSong, songFileExtension } from "../../../../packages/aiChat/ai/utils/songPayload";

const AUDIO: string = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]).toBase64();

describe("生歌载荷解码", () => {
  test("合法载荷只带回字节与容器——歌词整个不采，见 GeneratedChatSong", () => {
    const result = decodeGeneratedSong(AUDIO, "audio/mp3");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.song.mimeType).toBe("audio/mp3");
    expect(result.song.bytes).toEqual(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]));
    expect(Object.keys(result.song).sort()).toEqual(["bytes", "mimeType"]);
  });

  test("非 audio/* 的 mime 一律拒绝，包括缺失与图片容器", () => {
    expect(decodeGeneratedSong(AUDIO, undefined)).toEqual({ ok: false, reason: "missing audio mime type" });
    expect(decodeGeneratedSong(AUDIO, "image/png")).toEqual({ ok: false, reason: "missing audio mime type" });
  });

  test("空载荷、脏 base64 与超限各自带回可定位的原因", () => {
    expect(decodeGeneratedSong("", "audio/mp3")).toEqual({ ok: false, reason: "empty payload" });
    expect(decodeGeneratedSong("not base64!!", "audio/mp3"))
      .toEqual({ ok: false, reason: "payload is not canonical base64" });
    // 编码长度超限在解码前就被挡住，不为超限载荷分配字节数组；
    // 解码后按字节数的上限判定是另一条独立分支，用超限字节数组触发。
    expect(decodeGeneratedSong("A".repeat(SONG_GENERATION_MAX_ENCODED_CHARS + 4), "audio/mp3"))
      .toEqual({ ok: false, reason: "encoded payload exceeds the size limit" });
    expect(decodeGeneratedSong(new Uint8Array(SONG_GENERATION_MAX_BYTES + 1).toBase64(), "audio/mp3"))
      .toEqual({ ok: false, reason: "encoded payload exceeds the size limit" });
  });
});

describe("上传扩展名", () => {
  test("已知容器逐一映射", () => {
    expect(songFileExtension("audio/wav")).toBe("wav");
    expect(songFileExtension("audio/x-wav")).toBe("wav");
    expect(songFileExtension("audio/ogg")).toBe("ogg");
    expect(songFileExtension("audio/flac")).toBe("flac");
    expect(songFileExtension("audio/aac")).toBe("aac");
    expect(songFileExtension("audio/m4a")).toBe("m4a");
    expect(songFileExtension("audio/mp4")).toBe("m4a");
  });

  test("认不出的容器退回 mp3——Lyria 的默认输出，也是这条路上唯一会大量出现的容器", () => {
    expect(songFileExtension("audio/mp3")).toBe("mp3");
    expect(songFileExtension("audio/mpeg")).toBe("mp3");
    expect(songFileExtension("audio/something-new")).toBe("mp3");
  });
});
