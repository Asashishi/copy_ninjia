/**
 * 生歌消息 caption 的排版：模型自己那句话 + 一段固定格式的曲目信息。
 *
 * 元信息只写算得出来的：容器与体积恒有，码率要靠解析音频才有，解析不出就整段
 * 省掉那一项——宁可少展示，也不在群里挂一个编出来的数。时长不进 caption，它由
 * sendAudio 的 duration 参数显示在播放条上。
 */

import { describe, expect, test } from "bun:test";
import { buildSongCaption } from "../../../../packages/aiChat/ai/utils/songCaption";
import { SONG_METADATA_HASHTAG } from "../../../../packages/consts/aiChat/songGeneration";

const METADATA = { durationSeconds: 194, bitrateKbps: 920.7043 } as const;

describe("生歌 caption", () => {
  test("模型那句话在前，曲目信息两行跟在后面", () => {
    const caption: string = buildSongCaption({
      modelCaption: "给你写了一首",
      title: "まほう",
      performer: "花譜",
      byteLength: 21.5 * 1024 * 1024,
      mimeType: "audio/mp3",
      metadata: METADATA,
    });

    expect(caption).toBe(
      "给你写了一首\n\n" +
      "「まほう」- 花譜\n" +
      `${SONG_METADATA_HASHTAG} #mp3 21.50MB 920.70kbps`
    );
  });

  test("模型没写话时 caption 只有曲目信息，不留空行", () => {
    const caption: string = buildSongCaption({
      modelCaption: null,
      title: "无题",
      performer: "小忍",
      byteLength: 1024 * 1024,
      mimeType: "audio/mp3",
      metadata: METADATA,
    });

    expect(caption).toBe(`「无题」- 小忍\n${SONG_METADATA_HASHTAG} #mp3 1.00MB 920.70kbps`);
  });

  test("解析不出码率时整项省掉，其余照常——不填一个编出来的数", () => {
    const caption: string = buildSongCaption({
      modelCaption: null,
      title: "无题",
      performer: "小忍",
      byteLength: 3 * 1024 * 1024,
      mimeType: "audio/wav",
      metadata: null,
    });

    expect(caption).toBe(`「无题」- 小忍\n${SONG_METADATA_HASHTAG} #wav 3.00MB`);
    expect(caption).not.toContain("kbps");
  });

  test("体积按 MiB 保留两位，与 Telegram 播放条上那个大小同源", () => {
    const caption: string = buildSongCaption({
      modelCaption: null,
      title: "t",
      performer: "p",
      byteLength: 22_544_384,
      mimeType: "audio/mp3",
      metadata: null,
    });

    expect(caption).toContain("21.50MB");
  });

  test("标出这是 AI 生成：水印听不出来，不标就等于默认冒充", () => {
    const caption: string = buildSongCaption({
      modelCaption: null,
      title: "t",
      performer: "p",
      byteLength: 1,
      mimeType: "audio/mp3",
      metadata: null,
    });

    expect(caption).toContain(SONG_METADATA_HASHTAG);
  });
});
