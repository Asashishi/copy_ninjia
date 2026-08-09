/**
 * 生歌载荷的解码门禁与上传扩展名映射。
 *
 * 与图片那侧的门禁刻意不同：音频容器由供应商决定（Lyria 默认 MP3，也可请求 WAV），
 * 逐一维护魔数表只会在换容器时静默把一首正常的歌判死，因此这里只认「是不是
 * audio/*」加体积上限。扩展名必须与真实容器一致——Bot API 靠文件名判定容器，
 * 对不上时客户端拿到的是一条点开就报错的音频。
 */

import { describe, expect, test } from "bun:test";
import {
  SONG_GENERATION_MAX_BYTES,
  SONG_GENERATION_MAX_ENCODED_CHARS,
} from "../../../../packages/consts/aiChat/songGeneration";
import { decodeGeneratedSong, songFileExtension } from "../../../../packages/aiChat/ai/utils/songPayload";

const AUDIO: string = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0]).toString("base64");

describe("生歌载荷解码", () => {
  test("合法载荷只带回字节与容器——歌词整个不采，见 GeneratedChatSong", () => {
    const result = decodeGeneratedSong(AUDIO, "audio/mp3");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.song.mimeType).toBe("audio/mp3");
    expect(Buffer.from(result.song.bytes).equals(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0]))).toBe(true);
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
    // 超限在**解码之前**就被挡住，不为一个必然超限的载荷分配那份 Buffer——整首歌
    // 本来就有几 MB，这一步不是可省的保险。超一个字节的真实载荷同样落在这条
    // 分支上（编码长度随字节数单调增长，因此解码后的那道上限判定是纯防御，
    // 正常输入走不到）。
    expect(decodeGeneratedSong("A".repeat(SONG_GENERATION_MAX_ENCODED_CHARS + 4), "audio/mp3"))
      .toEqual({ ok: false, reason: "encoded payload exceeds the size limit" });
    expect(decodeGeneratedSong(Buffer.alloc(SONG_GENERATION_MAX_BYTES + 1).toString("base64"), "audio/mp3"))
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
