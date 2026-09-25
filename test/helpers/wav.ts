/** 构造 RIFF/WAVE 字节的测试夹具，供 WAV 解析、语音编码与语音工具测试共用。 */

export interface WavChunk {
  readonly id: string;
  readonly body: Uint8Array;
  /** 覆盖子块头里声明的长度，用于构造截断。 */
  readonly declaredSize?: number;
}

/** fmt 子块的可调字段；缺省为单声道 16 bit 整数 PCM。 */
export interface FmtChunkOptions {
  readonly sampleRate: number;
  readonly channels?: number;
  readonly bits?: number;
  readonly format?: number;
}

export function fmtChunk({ sampleRate, channels = 1, bits = 16, format = 1 }: FmtChunkOptions): WavChunk {
  const body: Uint8Array = new Uint8Array(16);
  const view: DataView = new DataView(body.buffer);
  view.setUint16(0, format, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * channels * bits / 8, true);
  view.setUint16(12, channels * bits / 8, true);
  view.setUint16(14, bits, true);
  return { id: "fmt ", body };
}

export function dataChunk(samples: readonly number[]): WavChunk {
  const body: Uint8Array = new Uint8Array(samples.length * 2);
  const view: DataView = new DataView(body.buffer);
  samples.forEach((sample: number, index: number): void => view.setInt16(index * 2, sample, true));
  return { id: "data", body };
}

export function wav(chunks: readonly WavChunk[], form: string = "WAVE"): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    const header: Uint8Array = new Uint8Array(8);
    header.set(new TextEncoder().encode(chunk.id));
    new DataView(header.buffer).setUint32(4, chunk.declaredSize ?? chunk.body.byteLength, true);
    parts.push(header, chunk.body);
    if (chunk.body.byteLength % 2 === 1) parts.push(new Uint8Array(1));
  }
  const bodyLength: number = parts.reduce((total: number, part: Uint8Array): number => total + part.byteLength, 0);
  const bytes: Uint8Array = new Uint8Array(12 + bodyLength);
  bytes.set(new TextEncoder().encode("RIFF"));
  new DataView(bytes.buffer).setUint32(4, 4 + bodyLength, true);
  bytes.set(new TextEncoder().encode(form), 8);
  let offset: number = 12;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** 指定时长的单声道 16 bit 正弦波 WAV。 */
export function sineWav(sampleRate: number, seconds: number): Uint8Array {
  const samples: number[] = [];
  const count: number = Math.round(sampleRate * seconds);
  for (let index: number = 0; index < count; index++) {
    samples.push(Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 12_000));
  }
  return wav([fmtChunk({ sampleRate }), dataChunk(samples)]);
}
