/**
 * MP3 时长/码率解析。
 *
 * 这两项是 Telegram 播放条上「03:14」和 caption 末尾那个 kbps 的唯一来源——
 * Lyria 的响应里没有时长，不自己解就只能交出一个不动的进度条。
 *
 * 用例按真实文件的三种形态构造帧头：CBR、带 Xing 的 VBR、以及前面挂着 ID3v2
 * 标签的。最后一组专门钉住「认不出就返回 null」——宁可少展示两项，也不在群里
 * 挂一个编出来的进度。
 */

import { describe, expect, test } from "bun:test";
import {
  probeAudioMetadata,
  probeMp3Metadata,
} from "../../../../packages/aiChat/ai/utils/audioMetadata";

/** MPEG1 Layer III、44.1 kHz、立体声、128 kbps 的 4 字节帧头。 */
function mpeg1Header(): number[] {
  // 0xFF 同步 | 0xFB = MPEG1(11) Layer III(01) 无 CRC(1) | 0x90 = 128kbps + 44.1kHz | 0x00 = stereo
  return [0xff, 0xfb, 0x90, 0x00];
}

/** 在帧头后按给定偏移写入一个带总帧数的 Xing 头。 */
function withXing(header: number[], offset: number, frames: number): Uint8Array {
  const bytes: number[] = [...header];
  while (bytes.length < offset) bytes.push(0x00);
  bytes.push(0x58, 0x69, 0x6e, 0x67); // "Xing"
  bytes.push(0x00, 0x00, 0x00, 0x01); // flags: 带总帧数
  bytes.push((frames >>> 24) & 0xff, (frames >>> 16) & 0xff, (frames >>> 8) & 0xff, frames & 0xff);
  return new Uint8Array(bytes);
}

/** 把一段字节补齐到指定长度，模拟整首歌的体积。 */
function padTo(bytes: Uint8Array, totalBytes: number): Uint8Array {
  const padded: Uint8Array = new Uint8Array(totalBytes);
  padded.set(bytes);
  return padded;
}

describe("MP3 元信息解析", () => {
  test("带 Xing 总帧数时按帧数算时长，码率按整段字节反推", () => {
    // 7500 帧 × 1152 采样 / 44100 Hz ≈ 195.9 秒。
    const withHeader: Uint8Array = withXing(mpeg1Header(), 36, 7_500);
    const bytes: Uint8Array = padTo(withHeader, 3_000_000);

    const metadata = probeMp3Metadata(bytes);
    expect(metadata).not.toBeNull();
    expect(metadata?.durationSeconds).toBe(196);
    // 3 000 000 字节 × 8 / 195.9 秒 / 1000 ≈ 122.5 kbps
    expect(metadata?.bitrateKbps).toBeCloseTo(122.5, 0);
  });

  test("没有 Xing 头时按第一帧码率做 CBR 估算", () => {
    const bytes: Uint8Array = padTo(new Uint8Array(mpeg1Header()), 1_600_000);

    const metadata = probeMp3Metadata(bytes);
    // 1 600 000 × 8 / 128 000 = 100 秒；码率反推回 128 kbps。
    expect(metadata?.durationSeconds).toBe(100);
    expect(metadata?.bitrateKbps).toBeCloseTo(128, 1);
  });

  test("跳过 ID3v2 标签再找帧头——标签里同样可能出现同步字", () => {
    const tagSize: number = 200;
    const prefix: number[] = [
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00,
      // 同步安全长度：每字节只用低 7 位
      (tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f,
    ];
    const bytes: Uint8Array = new Uint8Array(1_600_000 + 10 + tagSize);
    bytes.set(prefix, 0);
    bytes.set(mpeg1Header(), 10 + tagSize);

    const metadata = probeMp3Metadata(bytes);
    expect(metadata).not.toBeNull();
    expect(metadata?.durationSeconds).toBeGreaterThan(0);
  });

  test("ID3v2.4 的可选尾部也要跳过：它与标签头等长且不计入头里那个长度", () => {
    const tagSize: number = 200;
    // 标志位 0x10 = 带尾部；主版本 4 才定义这一位。
    const prefix: number[] = [
      0x49, 0x44, 0x33, 0x04, 0x00, 0x10,
      (tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f,
    ];
    const audioStart: number = 10 + tagSize + 10;
    const bytes: Uint8Array = new Uint8Array(3_000_000);
    bytes.set(prefix, 0);
    // 尾部这 10 字节里塞一个会被误判成 128kbps/44.1kHz 帧头的字节序列：漏加尾部
    // 长度的话扫描就从这里起步，认下这个假帧头，Xing 偏移随之整体错位 10 字节，
    // 读不到总帧数而退回 CBR 估算——时长直接差出七八秒。
    bytes.set([0xff, 0xfb, 0x90, 0x00], 10 + tagSize);
    bytes.set(withXing(mpeg1Header(), 36, 7_500), audioStart);

    const metadata = probeMp3Metadata(bytes);
    // 7500 帧 × 1152 / 44100 ≈ 195.9 秒，只有跳对尾部才读得到这个帧数。
    expect(metadata?.durationSeconds).toBe(196);
  });

  test("2.3 及更早的主版本不认尾部标志位：那一位在旧版规范里保留为 0", () => {
    const tagSize: number = 200;
    const prefix: number[] = [
      0x49, 0x44, 0x33, 0x03, 0x00, 0x10,
      (tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f,
    ];
    const bytes: Uint8Array = new Uint8Array(1_600_000 + 10 + tagSize);
    bytes.set(prefix, 0);
    bytes.set(mpeg1Header(), 10 + tagSize);

    expect(probeMp3Metadata(bytes)?.durationSeconds).toBe(100);
  });

  test("声明长度覆盖到文件末尾时返回 null，不退回从标签内部重扫", () => {
    // 畸形或被截断的标签：声明的长度比整个文件还长。退回 0 从头再扫等于在标签
    // 数据（任意用户文本 + 封面图）里赌一个偶然同步字，赌中就报出一个完全错误的
    // 时长——而那首歌已经计过费了。
    const tagSize: number = 4_000;
    const prefix: number[] = [
      0x49, 0x44, 0x33, 0x04, 0x00, 0x00,
      (tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f,
    ];
    const bytes: Uint8Array = new Uint8Array(2_000);
    bytes.set(prefix, 0);
    // 标签内部埋一个合法形状的帧头，模拟封面图里凑巧出现的同步字。
    bytes.set([0xff, 0xfb, 0x90, 0x00], 500);

    expect(probeMp3Metadata(bytes)).toBeNull();
  });

  test("只有同步字不算帧头：reserved 版本、非 Layer III、free/bad 档一律拒绝", () => {
    // 版本位 01（reserved）：0xEB = 111 01 01 1
    expect(probeMp3Metadata(padTo(new Uint8Array([0xff, 0xeb, 0x90, 0x00]), 100_000))).toBeNull();
    // 层位 11（Layer I）
    expect(probeMp3Metadata(padTo(new Uint8Array([0xff, 0xff, 0x90, 0x00]), 100_000))).toBeNull();
    // 码率索引 0（free）
    expect(probeMp3Metadata(padTo(new Uint8Array([0xff, 0xfb, 0x00, 0x00]), 100_000))).toBeNull();
    // 码率索引 15（bad）
    expect(probeMp3Metadata(padTo(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]), 100_000))).toBeNull();
    // 采样率索引 3（reserved）
    expect(probeMp3Metadata(padTo(new Uint8Array([0xff, 0xfb, 0x9c, 0x00]), 100_000))).toBeNull();
  });

  test("整段不含有效帧头时返回 null，不猜一个时长出来", () => {
    expect(probeMp3Metadata(new Uint8Array(100_000))).toBeNull();
    expect(probeMp3Metadata(new Uint8Array())).toBeNull();
  });

  test("单声道的 Xing 偏移与立体声不同，两边都要认得出", () => {
    const monoHeader: number[] = [0xff, 0xfb, 0x90, 0xc0];
    const bytes: Uint8Array = padTo(withXing(monoHeader, 21, 1_000), 500_000);

    const metadata = probeMp3Metadata(bytes);
    // 1000 帧 × 1152 / 44100 ≈ 26.1 秒；走对偏移才读得到这个帧数。
    expect(metadata?.durationSeconds).toBe(26);
  });
});

describe("按容器分派", () => {
  test("只有 MP3 走解析，其余容器一律交回 null", () => {
    const bytes: Uint8Array = padTo(new Uint8Array(mpeg1Header()), 1_600_000);

    expect(probeAudioMetadata(bytes, "audio/mp3")).not.toBeNull();
    expect(probeAudioMetadata(bytes, "audio/mpeg")).not.toBeNull();
    expect(probeAudioMetadata(bytes, "audio/wav")).toBeNull();
    expect(probeAudioMetadata(bytes, "audio/flac")).toBeNull();
  });
});
