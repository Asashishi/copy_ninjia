/** 构造 MPEG Layer III 帧序列的测试夹具：只写合法帧头，帧体填 0，供容器校验与语音编码测试共用。 */

/** 一帧的可调字段；缺省为 MPEG-2 Layer III、24 kHz、64 kbps、无填充。 */
export interface Mp3FrameOptions {
  /** 帧头 2 bit 版本：0b11 为 MPEG-1，0b10 为 MPEG-2，0b00 为 MPEG-2.5。 */
  readonly version?: number;
  readonly bitrateIndex?: number;
  readonly sampleRateIndex?: number;
  readonly padding?: boolean;
  /** 帧总长（含 4 字节帧头），由调用方按码率与采样率算好。 */
  readonly length: number;
}

/** MPEG-2 Layer III 24 kHz 64 kbps 的一帧：72 × 64000 / 24000 = 192 字节，576 个样本。 */
export const MPEG2_24K_64K_FRAME_BYTES: number = 192;

export function mp3Frame({ version = 0b10, bitrateIndex = 8, sampleRateIndex = 1, padding = false, length }: Mp3FrameOptions): Uint8Array {
  const frame: Uint8Array = new Uint8Array(length);
  frame[0] = 0xFF;
  frame[1] = 0xE0 | (version << 3) | (0b01 << 1) | 1;
  frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2) | (padding ? 0b10 : 0);
  frame[3] = 0xC4;
  return frame;
}

/** 首尾拼接多段字节。 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total: number = parts.reduce((sum: number, part: Uint8Array): number => sum + part.byteLength, 0);
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  let offset: number = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** count 帧 MPEG-2 24 kHz 64 kbps 的 MP3，每帧 576 个样本。 */
export function mp3Frames(count: number): Uint8Array<ArrayBuffer> {
  const frames: Uint8Array[] = [];
  for (let index: number = 0; index < count; index++) frames.push(mp3Frame({ length: MPEG2_24K_64K_FRAME_BYTES }));
  return concatBytes(frames);
}

/** 开头的 ID3v2 标签：10 字节头加 bodyLength 字节体，长度按 syncsafe 编码。 */
export function id3v2Tag(bodyLength: number): Uint8Array {
  const tag: Uint8Array = new Uint8Array(10 + bodyLength);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0]);
  tag[6] = (bodyLength >> 21) & 0x7F;
  tag[7] = (bodyLength >> 14) & 0x7F;
  tag[8] = (bodyLength >> 7) & 0x7F;
  tag[9] = bodyLength & 0x7F;
  return tag;
}

/** 末尾 128 字节的 ID3v1 标签。 */
export function id3v1Tag(): Uint8Array {
  const tag: Uint8Array = new Uint8Array(128);
  tag.set([0x54, 0x41, 0x47]);
  return tag;
}
