/** 构造 ftyp box 夹具的参数。 */
export interface FtypBoxOptions {
  readonly major: string;
  readonly compatible?: readonly string[];
  /** 写进长度字段的值；缺省为实际字节数。 */
  readonly declaredBytes?: number;
}

/** 把四字符码按 ASCII 写进 output 的 offset 处。 */
function writeFourcc(output: Uint8Array, offset: number, fourcc: string): void {
  for (let i: number = 0; i < 4; i++) output[offset + i] = fourcc.charCodeAt(i);
}

/** 构造紧凑头部的 box：长度字段缺省为实际字节数，可用 declaredBytes 写入任意值。 */
export function mp4Box(type: string, payload: Uint8Array = new Uint8Array(0), declaredBytes?: number): Uint8Array {
  const output: Uint8Array = new Uint8Array(8 + payload.length);
  new DataView(output.buffer).setUint32(0, declaredBytes ?? output.length);
  writeFourcc(output, 4, type);
  output.set(payload, 8);
  return output;
}

/** 构造长度字段为 1、带 64 位长度的 box；largeBytes 缺省为实际字节数。 */
export function mp4LargeBox(type: string, payload: Uint8Array = new Uint8Array(0), largeBytes?: bigint): Uint8Array {
  const output: Uint8Array = new Uint8Array(16 + payload.length);
  const view: DataView = new DataView(output.buffer);
  view.setUint32(0, 1);
  writeFourcc(output, 4, type);
  view.setBigUint64(8, largeBytes ?? BigInt(output.length));
  output.set(payload, 16);
  return output;
}

/** 构造 ftyp box：主品牌、次版本号 0（零初始化）、兼容品牌。 */
export function ftypBox({ major, compatible = [], declaredBytes }: FtypBoxOptions): Uint8Array {
  const payload: Uint8Array = new Uint8Array(8 + compatible.length * 4);
  writeFourcc(payload, 0, major);
  compatible.forEach((brand: string, index: number): void => writeFourcc(payload, 8 + index * 4, brand));
  return mp4Box("ftyp", payload, declaredBytes);
}

/** 构造 trak 夹具的参数。 */
export interface TrakBoxOptions {
  /** 写进 tkhd 的展示宽高（像素，按 16.16 定点数写入）。 */
  readonly width: number;
  readonly height: number;
  /** hdlr 的 handler_type；缺省为视频轨 vide。 */
  readonly handler?: string;
  /** tkhd 版本；缺省为 0。 */
  readonly tkhdVersion?: number;
}

/** 构造 tkhd：版本 1 的宽度字段在载荷偏移 88，其余版本按版本 0 的偏移 76 写入；其余字段为零。 */
export function tkhdBox(width: number, height: number, version: number = 0): Uint8Array {
  const sizeOffset: number = version === 1 ? 88 : 76;
  const payload: Uint8Array = new Uint8Array(sizeOffset + 8);
  const view: DataView = new DataView(payload.buffer);
  payload[0] = version;
  view.setUint32(sizeOffset, width * 0x1_00_00);
  view.setUint32(sizeOffset + 4, height * 0x1_00_00);
  return mp4Box("tkhd", payload);
}

/** 构造 hdlr：版本与标志、pre_defined、handler_type、12 字节保留字段与空名字。 */
export function hdlrBox(handler: string): Uint8Array {
  const payload: Uint8Array = new Uint8Array(25);
  writeFourcc(payload, 8, handler);
  return mp4Box("hdlr", payload);
}

/** 构造 trak：tkhd 加只含 hdlr 的 mdia。 */
export function trakBox({ width, height, handler = "vide", tkhdVersion = 0 }: TrakBoxOptions): Uint8Array {
  const children: readonly Uint8Array[] = [tkhdBox(width, height, tkhdVersion), mp4Box("mdia", hdlrBox(handler))];
  return mp4Box("trak", Bun.concatArrayBuffers([...children], Infinity, true));
}

/** 构造 moov：依次装入各条 trak。 */
export function moovBox(...traks: readonly Uint8Array[]): Uint8Array {
  return mp4Box("moov", Bun.concatArrayBuffers([...traks], Infinity, true));
}

/** 只含一条 800×800 视频轨的 moov。 */
export const MOOV_BOX: Uint8Array = moovBox(trakBox({ width: 800, height: 800 }));

/** ffmpeg 默认 mp4 封装的结构：ftyp（主品牌 isom，兼容 isom/iso2/avc1/mp41）、mdat、MOOV_BOX。 */
export const MP4_BYTES: Uint8Array = Bun.concatArrayBuffers([
  ftypBox({ major: "isom", compatible: ["isom", "iso2", "avc1", "mp41"] }),
  mp4Box("mdat", new Uint8Array([1, 2, 3, 4])),
  MOOV_BOX,
], Infinity, true);

/**
 * 构造恰好 totalBytes 字节的合法 MP4：ftyp、MOOV_BOX、铺满其余字节的 mdat。只写入各 box 头，mdat 载荷
 * 保持零初始化，大尺寸夹具不逐页写入。
 */
export function mp4OfSize(totalBytes: number): Uint8Array {
  const ftyp: Uint8Array = ftypBox({ major: "isom" });
  const mdatOffset: number = ftyp.length + MOOV_BOX.length;
  const output: Uint8Array = new Uint8Array(totalBytes);
  output.set(ftyp, 0);
  output.set(MOOV_BOX, ftyp.length);
  output.set(mp4Box("mdat", new Uint8Array(0), totalBytes - mdatOffset), mdatOffset);
  return output;
}
