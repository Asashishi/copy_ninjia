/** 生成固定像素的 BMP 夹具；由原生图片 API 编码成各测试所需格式。 */
export function imageFixture(width: number, height: number): Uint8Array {
  const stride: number = Math.ceil(width * 3 / 4) * 4;
  const bytes: Uint8Array = new Uint8Array(54 + stride * height);
  const header: DataView = new DataView(bytes.buffer);
  header.setUint16(0, 0x4d42, true);
  header.setUint32(2, bytes.length, true);
  header.setUint32(10, 54, true);
  header.setUint32(14, 40, true);
  header.setInt32(18, width, true);
  header.setInt32(22, height, true);
  header.setUint16(26, 1, true);
  header.setUint16(28, 24, true);
  header.setUint32(34, stride * height, true);
  let state: number = 42;
  for (let y: number = 0; y < height; y++) {
    for (let x: number = 0; x < width * 3; x++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[54 + y * stride + x] = state >>> 24;
    }
  }
  return bytes;
}

/** 两帧 2×2 GIF：首帧黄色，第二帧蓝色，逐帧间隔 100 ms。 */
export function animatedGifFixture(): Uint8Array {
  return Uint8Array.fromBase64(
    "R0lGODlhAgACAIAAAExpcf//ACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAgACAAACAoxTACH5BAUKAAAALAAAAAACAAIAgExpcQAA/wICjFMAOw=="
  );
}

/** animatedWebpFixture 首帧的 RGBA 像素：红色不透明、绿色半透明（alpha 128）。 */
export const ANIMATED_WEBP_FIRST_FRAME: Readonly<Uint8Array> = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 128,
]);

/** 两帧 2×1 无损动态 WEBP：首帧见 ANIMATED_WEBP_FIRST_FRAME，第二帧蓝色与黄色，逐帧间隔 100 ms。 */
export function animatedWebpFixture(): Uint8Array {
  return Uint8Array.fromBase64(
    "UklGRowAAABXRUJQVlA4WAoAAAASAAAAAQAAAAAAQU5JTQYAAAD/////AQBBTk1GLAAAAAAAAAAAAAEAAAAAAGQAAAJWUDhMEwAAAC8BAAAQDzD/" +
    "+x8P/A8HFYjofwAAQU5NRiwAAAAAAAAAAAABAAAAAABkAAAAVlA4TBMAAAAvAQAAAA8w//O///MfPKhARP8DAA=="
  );
}

/** 两帧 2×1 有损动态 WEBP，首帧为 VP8 加 ALPH（alpha 依次为 255、128）。 */
export function animatedLossyAlphaWebpFixture(): Uint8Array {
  return Uint8Array.fromBase64(
    "UklGRtwAAABXRUJQVlA4WAoAAAASAAAAAQAAAAAAQU5JTQYAAAD/////AQBBTk1GZgAAAAAAAAAAAAEAAAAAAGQAAAJBTFBIAwAAAAD/gABWUDggQgAAALAC" +
    "AJ0BKgIAAQAAAAAloAJ0ugH4AfoB/AAGZViMwAD9A//KKT/70z/+cyI//9JaK8AjH/6S1//qiWGUcKf/U2gAAEFOTUZCAAAAAAAAAAAAAQAAAAAAZAAAAFZQ" +
    "OCAqAAAAlAEAnQEqAgABAAAAACWkAALnWbYAAP7//m1//8QMH/9KD//pAdCYAAAA"
  );
}

/** 两帧 2×1 有损动态 WEBP，首帧只有 VP8、没有 ALPH（整帧不透明）。 */
export function animatedLossyOpaqueWebpFixture(): Uint8Array {
  return Uint8Array.fromBase64(
    "UklGRsYAAABXRUJQVlA4WAoAAAACAAAAAQAAAAAAQU5JTQYAAAD/////AQBBTk1GVAAAAAAAAAAAAAEAAAAAAGQAAAJWUDggPAAAAPABAJ0BKgIAAQAAAAAl" +
    "oAJ0ugADCQb7gAD+8b//ann/9Of/8Gwx//v9j/7/Y/+/2P/f7H/O1sMQTwAAAEFOTUY+AAAAAAAAAAAAAQAAAAAAZAAAAFZQOCAmAAAAlAEAnQEqAgABAAAA" +
    "ACWkAALnWbYAAP7+bR/+GTD/7Hj/+6CgAAA="
  );
}

/** 小端 32 位整数的 4 个字节。 */
function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/** 24 位小端整数的 3 个字节，用于 ANMF 帧头与 VP8X 画布尺寸。 */
export function le24(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

/** 一个 RIFF 块的字节：四字符码、载荷长度（可用 declaredLength 伪造）、载荷与奇数补齐。 */
export function riffChunkBytes(fourcc: string, payload: readonly number[], declaredLength: number = payload.length): number[] {
  const bytes: number[] = [...fourcc].map((char: string): number => char.charCodeAt(0));
  bytes.push(...le32(declaredLength), ...payload);
  if ((payload.length & 1) === 1) bytes.push(0);
  return bytes;
}

/** 由若干块字节拼成完整的 `RIFF…WEBP` 文件，RIFF 长度按实际字节写入。 */
export function webpContainerBytes(chunks: readonly (readonly number[])[]): Uint8Array {
  const body: number[] = [..."WEBP"].map((char: string): number => char.charCodeAt(0));
  for (const chunk of chunks) body.push(...chunk);
  return new Uint8Array([..."RIFF"].map((char: string): number => char.charCodeAt(0)).concat(le32(body.length), body));
}

/** 只含文件头的 VP8L 码流：签名、14 位宽减一与高减一、alpha 位，后跟不能解码的填充字节。 */
export function vp8lHeaderBytes(width: number, height: number): number[] {
  return [0x2f, ...le32(((width - 1) | ((height - 1) << 14) | (1 << 28)) >>> 0), ...new Array<number>(32).fill(0xaa)];
}

/**
 * GIF89a：逻辑屏幕声明为 screen×screen，唯一图像块声明为 frame×frame，像素数据只有一个
 * LZW 码，不足以填满声明的尺寸。
 */
export function gifClaimingBytes(screen: number, frame: number): Uint8Array {
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, screen & 0xff, screen >>> 8, screen & 0xff, screen >>> 8, 0x80, 0, 0,
    0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, frame & 0xff, frame >>> 8, frame & 0xff, frame >>> 8, 0,
    2, 2, 0x44, 0x01, 0, 0x3b,
  ]);
}

/** decodePngRgba 的结果：宽高与逐像素 RGBA 字节。 */
export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** PNG 颜色类型到每像素通道数；只收 8 位深度的灰度、RGB、调色板、灰度透明与 RGBA。 */
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Paeth 预测子，与 PNG 规范的过滤类型 4 一致。 */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate: number = left + up - upLeft;
  const toLeft: number = Math.abs(estimate - left);
  const toUp: number = Math.abs(estimate - up);
  const toUpLeft: number = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * 解出 8 位、非隔行 PNG 的 RGBA 像素，供测试逐像素比较转码结果；其余位深或隔行直接抛错，
 * 不做近似。
 */
export function decodePngRgba(png: Uint8Array): DecodedPng {
  const view: DataView = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width: number = 0;
  let height: number = 0;
  let colorType: number = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const compressed: number[] = [];
  for (let offset: number = 8; offset < png.length;) {
    const length: number = view.getUint32(offset);
    const type: string = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const data: Uint8Array = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      colorType = data[9]!;
      if (data[8] !== 8 || data[12] !== 0) throw new Error("decodePngRgba expects 8-bit non-interlaced PNG");
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IDAT") {
      for (const byte of data) compressed.push(byte);
    }
    offset += 12 + length;
  }
  const channels: number | undefined = PNG_CHANNELS[colorType];
  if (channels === undefined) throw new Error(`decodePngRgba does not support color type ${colorType}`);
  const filtered: Uint8Array = Bun.inflateSync(new Uint8Array(compressed), { windowBits: 15 });
  const stride: number = width * channels;
  const samples: Uint8Array = new Uint8Array(stride * height);
  for (let y: number = 0; y < height; y++) {
    const filter: number = filtered[y * (stride + 1)]!;
    const line: Uint8Array = filtered.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x: number = 0; x < stride; x++) {
      const left: number = x >= channels ? samples[y * stride + x - channels]! : 0;
      const up: number = y > 0 ? samples[(y - 1) * stride + x]! : 0;
      const upLeft: number = y > 0 && x >= channels ? samples[(y - 1) * stride + x - channels]! : 0;
      const predictor: number = filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? paeth(left, up, upLeft)
        : 0;
      samples[y * stride + x] = (line[x]! + predictor) & 0xff;
    }
  }
  const rgba: Uint8Array = new Uint8Array(width * height * 4);
  for (let pixel: number = 0; pixel < width * height; pixel++) {
    const source: number = pixel * channels;
    const target: number = pixel * 4;
    if (colorType === 3) {
      const index: number = samples[source]!;
      rgba.set(palette!.subarray(index * 3, index * 3 + 3), target);
      rgba[target + 3] = transparency !== null && index < transparency.length ? transparency[index]! : 255;
    } else if (colorType === 0 || colorType === 4) {
      rgba.fill(samples[source]!, target, target + 3);
      rgba[target + 3] = colorType === 4 ? samples[source + 1]! : 255;
    } else {
      rgba.set(samples.subarray(source, source + 3), target);
      rgba[target + 3] = colorType === 6 ? samples[source + 3]! : 255;
    }
  }
  return { width, height, rgba };
}
