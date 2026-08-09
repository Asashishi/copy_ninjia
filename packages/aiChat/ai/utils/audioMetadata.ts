/**
 * 从音频字节里读出时长与码率。
 *
 * **为什么要自己算：** Lyria 的响应只带 `sample_rate` 和 `channels`，没有时长；
 * 而 Telegram 的播放条要显示「03:14」就得在 sendAudio 时把 `duration` 传上去。
 * 大小是 Telegram 自己按上传字节算的，不用管；码率则要靠时长反推或直接读帧头。
 *
 * **只解 MP3。** 这条路上唯一会出现的容器就是它——本项目不请求 `response_format`，
 * Lyria 默认就回 MP3（WAV 是 Pro 的可选项，而且 Bot API 明说 sendAudio 只保证
 * .MP3/.M4A 能进音乐播放器）。为一个我们从不请求的容器写第二套解析，等于维护
 * 一段永远跑不到、也永远没人验证的代码。认不出的容器一律返回 null，调用方按
 * 「这两项未知」降级，而不是猜一个值填上去。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  ID3V2_FOOTER_BYTES,
  ID3V2_FOOTER_FLAG,
  ID3V2_FOOTER_MIN_MAJOR_VERSION,
  ID3V2_HEADER_BYTES,
  MP3_BITRATES_V1_L3,
  MP3_BITRATES_V2_L3,
  MP3_FRAME_SCAN_MAX_BYTES,
  MP3_SAMPLE_RATES_V1,
  MP3_SAMPLE_RATES_V2,
  MP3_SAMPLE_RATES_V25,
  MP3_SAMPLES_PER_FRAME_V1,
  MP3_SAMPLES_PER_FRAME_V2,
  XING_OFFSET_V1_MONO,
  XING_OFFSET_V1_STEREO,
  XING_OFFSET_V2_MONO,
  XING_OFFSET_V2_STEREO,
} from "../../../consts/audio";

/** 一段音频的时长与平均码率；两项要么都算得出，要么整个返回 null。 */
export interface AudioTrackMetadata {
  /** 时长（秒，已取整——Bot API 的 duration 就是整秒）。 */
  readonly durationSeconds: number;
  /** 平均码率（kbps，保留小数由展示侧决定）。 */
  readonly bitrateKbps: number;
}

/** 解出来的第一个有效帧头。 */
interface Mp3FrameHeader {
  /** 帧头在文件里的字节偏移。 */
  readonly offset: number;
  /** MPEG1 为 true；MPEG2/2.5 为 false（两者的表与帧采样点数相同）。 */
  readonly isVersion1: boolean;
  readonly isMono: boolean;
  readonly sampleRate: number;
  /** 该帧声明的码率（kbps）；VBR 文件里它只代表第一帧。 */
  readonly bitrateKbps: number;
}

/**
 * ID3v2 的长度是同步安全整数（每字节只用低 7 位）；跳过整段标签。
 *
 * 两处必须显式处理，否则扫描会从**标签内部**起步——而标签里放的是任意用户文本
 * 和封面图，正是最容易凑出一个偶然 11 位同步字的地方，一旦它同时蒙对版本/层/
 * 码率/采样率四项，算出来的就是一个看着像模像样却完全错误的时长：
 *
 * 1. **2.4 的可选尾部**（标志位 0x10）与标签头等长，且不计入头里那个长度，
 *    漏加就把这 10 字节当成音频。该位仅 2.4 定义，更早主版本此位保留为 0，
 *    因此还要看主版本再决定认不认。
 * 2. **声明长度覆盖到文件末尾**（畸形或截断）时没有可解析的音频，直接把起点收到
 *    文件末尾让扫描空手而归、由调用方按「这两项未知」降级；退回 0 从头再扫是在
 *    标签数据里赌一把，与本模块「认不出就返回 null、不猜」的口径正相反。
 */
function audioStartOffset(bytes: Uint8Array): number {
  if (bytes.length < ID3V2_HEADER_BYTES) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size: number =
    ((bytes[6]! & 0x7f) << 21)
    | ((bytes[7]! & 0x7f) << 14)
    | ((bytes[8]! & 0x7f) << 7)
    | (bytes[9]! & 0x7f);
  const hasFooter: boolean =
    bytes[3]! >= ID3V2_FOOTER_MIN_MAJOR_VERSION && (bytes[5]! & ID3V2_FOOTER_FLAG) !== 0;
  const end: number = ID3V2_HEADER_BYTES + size + (hasFooter ? ID3V2_FOOTER_BYTES : 0);
  return Math.min(end, bytes.length);
}

/** 按 MPEG 版本挑采样率表；MPEG2.5 与 MPEG2 的版本位不同，表也不同。 */
function sampleRateTableFor(versionBits: number): readonly number[] {
  if (versionBits === 0b11) return MP3_SAMPLE_RATES_V1;
  if (versionBits === 0b10) return MP3_SAMPLE_RATES_V2;
  return MP3_SAMPLE_RATES_V25;
}

/**
 * 从 start 起扫出第一个有效的 Layer III 帧头。
 *
 * 「有效」要求同步字 + 版本/层/码率/采样率四项都不落在 reserved / free / bad
 * 档上：11 位同步字在任意二进制里都可能偶然出现，只认同步字会把一段随机字节
 * 当成音频，算出一个看着像模像样却完全错误的时长。
 */
function findFrameHeader(bytes: Uint8Array, start: number): Mp3FrameHeader | null {
  const limit: number = Math.min(bytes.length - 4, start + MP3_FRAME_SCAN_MAX_BYTES);
  for (let i: number = start; i <= limit; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) continue;
    const versionBits: number = (bytes[i + 1]! >> 3) & 0b11;
    const layerBits: number = (bytes[i + 1]! >> 1) & 0b11;
    // 版本 01 是 reserved；层位 01 才是 Layer III，其余层本项目不产出也不解析。
    if (versionBits === 0b01 || layerBits !== 0b01) continue;
    const isVersion1: boolean = versionBits === 0b11;
    const bitrateKbps: number | undefined =
      (isVersion1 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[(bytes[i + 2]! >> 4) & 0x0f];
    const sampleRate: number | undefined = sampleRateTableFor(versionBits)[(bytes[i + 2]! >> 2) & 0b11];
    if (!bitrateKbps || !sampleRate) continue;
    return {
      offset: i,
      isVersion1,
      isMono: ((bytes[i + 3]! >> 6) & 0b11) === 0b11,
      sampleRate,
      bitrateKbps,
    };
  }
  return null;
}

/** Xing/Info 头相对帧头起点的偏移，由 MPEG 版本与声道模式共同决定。 */
function xingOffsetFor(header: Mp3FrameHeader): number {
  if (header.isVersion1) return header.isMono ? XING_OFFSET_V1_MONO : XING_OFFSET_V1_STEREO;
  return header.isMono ? XING_OFFSET_V2_MONO : XING_OFFSET_V2_STEREO;
}

/**
 * 读 VBR 头里的总帧数；不是 VBR 文件或没有帧数标志时返回 null。
 *
 * VBR 才是这里的常态：算法编码器几乎不出 CBR。拿第一帧的码率去除文件大小会把
 * 一首 VBR 曲子的时长算歪几十秒，播放条上的进度就是错的。
 */
function readXingFrameCount(bytes: Uint8Array, header: Mp3FrameHeader): number | null {
  const at: number = header.offset + xingOffsetFor(header);
  if (at + 12 > bytes.length) return null;
  const magic: string = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (magic !== "Xing" && magic !== "Info") return null;
  const flags: number = (bytes[at + 4]! << 24) | (bytes[at + 5]! << 16) | (bytes[at + 6]! << 8) | bytes[at + 7]!;
  // bit0 = 带总帧数字段；没有它就没法得到准确时长，退回 CBR 估算。
  if ((flags & 0x01) === 0) return null;
  const frames: number =
    ((bytes[at + 8]! << 24) | (bytes[at + 9]! << 16) | (bytes[at + 10]! << 8) | bytes[at + 11]!) >>> 0;
  return frames > 0 ? frames : null;
}

/**
 * 读一段 MP3 的时长与平均码率；解析不出可信结果时返回 null。
 *
 * 优先走 Xing/Info 的总帧数（精确），没有才按第一帧码率做 CBR 估算。两条路算出
 * 时长之后，码率一律按「音频字节 × 8 ÷ 时长」反推——那才是 Telegram 客户端和各类
 * 播放器展示的那个平均码率，直接报第一帧的瞬时码率会让 VBR 曲子显示成一个
 * 与文件明显对不上的数。
 */
export function probeMp3Metadata(bytes: Uint8Array): AudioTrackMetadata | null {
  const start: number = audioStartOffset(bytes);
  const header: Mp3FrameHeader | null = findFrameHeader(bytes, start);
  if (!header) return null;
  const audioBytes: number = bytes.length - header.offset;
  if (audioBytes <= 0) return null;

  const frames: number | null = readXingFrameCount(bytes, header);
  const samplesPerFrame: number = header.isVersion1 ? MP3_SAMPLES_PER_FRAME_V1 : MP3_SAMPLES_PER_FRAME_V2;
  const durationSeconds: number = frames === null
    ? (audioBytes * 8) / (header.bitrateKbps * 1_000)
    : (frames * samplesPerFrame) / header.sampleRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;

  return {
    durationSeconds: Math.round(durationSeconds),
    bitrateKbps: (audioBytes * 8) / durationSeconds / 1_000,
  };
}

/**
 * 按声明的容器分派解析；本项目只认 MP3，其余一律返回 null。
 *
 * 认不出就交回 null 而不是猜：调用方据此**省略**时长与码率，宁可少展示两项，
 * 也不在群里挂一个编出来的进度条。
 */
export function probeAudioMetadata(bytes: Uint8Array, mimeType: string): AudioTrackMetadata | null {
  return mimeType === "audio/mp3" || mimeType === "audio/mpeg" ? probeMp3Metadata(bytes) : null;
}
