import { logger } from "./logger";
import {
  RIFF_CHUNK_HEADER_BYTES,
  VISION_TRANSCODE_MAX_PIXELS,
  WEBP_ANMF_HEADER_BYTES,
  WEBP_ANMF_SIZE_OFFSET,
  WEBP_CONTAINER_HEADER_BYTES,
  WEBP_FOURCC_ALPH,
  WEBP_FOURCC_ANMF,
  WEBP_FOURCC_RIFF,
  WEBP_FOURCC_VP8,
  WEBP_FOURCC_VP8L,
  WEBP_FOURCC_VP8X,
  WEBP_FOURCC_WEBP,
  WEBP_FRAME_IMAGE_FOURCCS,
  WEBP_MAX_SCANNED_CHUNKS,
  WEBP_VP8X_ALPHA_FLAG,
  WEBP_VP8X_PAYLOAD_BYTES,
  WEBP_VP8X_SIZE_OFFSET,
} from "../consts/image";
import type { VisionImage } from "../types/media";
import type { ImageDimensions } from "../types/hImage";

/** 魔数嗅探得到的图片格式；unknown 表示不属于 jpeg、png、webp、gif 中任何一种。 */
export type SniffedImageFormat = "jpeg" | "png" | "webp" | "gif" | "unknown";

/** 按文件头魔数嗅探格式，不依赖 Telegram 的 file_path 扩展名（贴纸/缩略图的
 *  扩展名不总是可靠）。 */
export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d &&
    bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 &&
    bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  if (
    bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) return "gif";
  return "unknown";
}

/** RIFF 容器里的一个块：四字符码（小端 uint32）、载荷起点与载荷长度（不含奇数长度的补齐字节）。 */
interface RiffChunk {
  readonly fourcc: number;
  readonly start: number;
  readonly length: number;
}

/** 在字节数组里扫描 RIFF 块的半开区间 [start, end)。 */
interface RiffSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * 在 span 内按 RIFF 规则顺序查找第一个四字符码属于 accept 的块。只读块头、不收集块列表，
 * 最多检查 WEBP_MAX_SCANNED_CHUNKS 个块；某个块的载荷越过 span.end、超过块数上限或扫到末尾
 * 仍未找到时返回 null。
 */
function findRiffChunk(bytes: Uint8Array, span: RiffSpan, accept: readonly number[]): RiffChunk | null {
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let scanned: number = 0;
  for (let offset: number = span.start; offset + RIFF_CHUNK_HEADER_BYTES <= span.end;) {
    if (++scanned > WEBP_MAX_SCANNED_CHUNKS) return null;
    const fourcc: number = view.getUint32(offset, true);
    const length: number = view.getUint32(offset + 4, true);
    const payload: number = offset + RIFF_CHUNK_HEADER_BYTES;
    if (payload + length > span.end) return null;
    if (accept.includes(fourcc)) return { fourcc, start: payload, length };
    offset = payload + length + (length & 1);
  }
  return null;
}

/**
 * 把若干 [四字符码, 载荷] 依次写成 RIFF 块（奇数长度补一个 0），外面包上 `RIFF…WEBP` 头。
 * 输出长度只由各段载荷决定，不超过输入字节与少量块头之和。
 */
function writeWebpContainer(chunks: readonly (readonly [number, Uint8Array])[]): Uint8Array {
  let body: number = WEBP_CONTAINER_HEADER_BYTES - RIFF_CHUNK_HEADER_BYTES;
  for (const [, payload] of chunks) body += RIFF_CHUNK_HEADER_BYTES + payload.length + (payload.length & 1);
  const output: Uint8Array = new Uint8Array(RIFF_CHUNK_HEADER_BYTES + body);
  const view: DataView = new DataView(output.buffer);
  view.setUint32(0, WEBP_FOURCC_RIFF, true);
  view.setUint32(4, body, true);
  view.setUint32(8, WEBP_FOURCC_WEBP, true);
  let offset: number = WEBP_CONTAINER_HEADER_BYTES;
  for (const [fourcc, payload] of chunks) {
    view.setUint32(offset, fourcc, true);
    view.setUint32(offset + 4, payload.length, true);
    output.set(payload, offset + RIFF_CHUNK_HEADER_BYTES);
    offset += RIFF_CHUNK_HEADER_BYTES + payload.length + (payload.length & 1);
  }
  return output;
}

/**
 * 把动态 WebP 的第一帧（首个 ANMF 块里的 VP8L，或 VP8 加可选 ALPH）重新封装成一张静态
 * WebP，按该帧自身宽高输出、不合成到画布偏移。不是动态 WebP 或容器结构不合法时返回
 * null，调用方按原字节解码。只做容器层的切片与拼接，不解码像素；帧尺寸与码流内容由
 * `Bun.Image` 解码时校验。
 */
export function firstAnimatedWebpFrame(bytes: Uint8Array): Uint8Array | null {
  const frame: RiffChunk | null = findRiffChunk(
    bytes, { start: WEBP_CONTAINER_HEADER_BYTES, end: bytes.length }, [WEBP_FOURCC_ANMF]
  );
  if (frame === null || frame.length < WEBP_ANMF_HEADER_BYTES) return null;
  const frameImages: RiffSpan = { start: frame.start + WEBP_ANMF_HEADER_BYTES, end: frame.start + frame.length };
  const image: RiffChunk | null = findRiffChunk(bytes, frameImages, WEBP_FRAME_IMAGE_FOURCCS);
  if (image === null) return null;
  const imageBytes: Uint8Array = bytes.subarray(image.start, image.start + image.length);
  if (image.fourcc === WEBP_FOURCC_VP8L) return writeWebpContainer([[WEBP_FOURCC_VP8L, imageBytes]]);
  // 有损帧用扩展格式封装：VP8X 声明画布与 alpha 标志，ALPH 在前、VP8 在后。
  const alpha: RiffChunk | null = findRiffChunk(bytes, frameImages, [WEBP_FOURCC_ALPH]);
  const header: Uint8Array = new Uint8Array(WEBP_VP8X_PAYLOAD_BYTES);
  header[0] = alpha === null ? 0 : WEBP_VP8X_ALPHA_FLAG;
  const size: number = frame.start + WEBP_ANMF_SIZE_OFFSET;
  header.set(bytes.subarray(size, size + WEBP_VP8X_PAYLOAD_BYTES - WEBP_VP8X_SIZE_OFFSET), WEBP_VP8X_SIZE_OFFSET);
  return writeWebpContainer(alpha === null
    ? [[WEBP_FOURCC_VP8X, header], [WEBP_FOURCC_VP8, imageBytes]]
    : [
      [WEBP_FOURCC_VP8X, header],
      [WEBP_FOURCC_ALPH, bytes.subarray(alpha.start, alpha.start + alpha.length)],
      [WEBP_FOURCC_VP8, imageBytes],
    ]);
}

/**
 * 把任意支持格式的图片字节转成可直接喂视觉接口的 jpeg/png。jpeg/png
 * 原样直通（无转码开销）；webp/gif 经 `Bun.Image` 转 png，动态 webp 与 gif 都只取第一帧
 * （本项目没有抽帧能力，只能按封面帧分析；`Bun.Image` 只解静态 webp，动态 webp 先经
 * firstAnimatedWebpFrame 抽出首帧）。解码、编码在 Bun 的图像线程上执行，不阻塞调用线程；
 * 像素数超过 VISION_TRANSCODE_MAX_PIXELS 的图在分配像素缓冲前即被拒绝。不支持的格式、
 * 超限或转码失败均返回 null，调用方按「这条不解析」处理。编解码器随 Bun 运行时静态
 * 链接，源码与二进制发行包都不依赖 node_modules 里的原生模块。
 */
export async function prepareVisionImage(bytes: Uint8Array): Promise<VisionImage | null> {
  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (format === "jpeg") return { bytes, mime: "image/jpeg" };
  if (format === "png") return { bytes, mime: "image/png" };
  if (format !== "webp" && format !== "gif") return null;

  try {
    const source: Uint8Array = format === "webp" ? firstAnimatedWebpFrame(bytes) ?? bytes : bytes;
    const png: Uint8Array = await new Bun.Image(source, { maxPixels: VISION_TRANSCODE_MAX_PIXELS }).png().bytes();
    return { bytes: png, mime: "image/png" };
  } catch (error: unknown) {
    logger.error(`Failed to transcode ${format} image to png for vision API:`, error);
    return null;
  }
}

/**
 * 只读一张图的像素尺寸，不解码像素、不转码。`Bun.Image` 的 `metadata()` 只解码到
 * 能读出宽高与格式为止。
 *
 * 任何解码失败（不认识的格式、截断的头、超出 maxPixels）都返回 null——调用方
 * 对「读不出尺寸」和「读出来不合规」要分开处置，但都不该让一次收图抛出去。
 *
 * **刻意不记日志**：入参是用户随手转发进来的字节，「这不是一张能解码的图」是
 * 正常输入而不是故障；一个刷屏相册就能把它变成日志噪声源。调用方把 null 归到
 * 与「格式不对」同一档，用户从命令回执里看得到张数。
 * @param bytes 完整的图片字节。
 * @returns 像素宽高；读不出时为 null。
 */
export async function readImageDimensions(bytes: Uint8Array): Promise<ImageDimensions | null> {
  try {
    const metadata: Bun.Image.Metadata = await new Bun.Image(bytes).metadata();
    return { width: metadata.width, height: metadata.height };
  } catch {
    return null;
  }
}
