import { logger } from "../infra/logger";
import type { Sharp } from "sharp";
import type { VisionImage } from "../types/media";

/**
 * 把任意支持的图片字节转成两家视觉接口都稳妥能收的格式：只认 jpg/jpeg 或 png
 * （官方文档明示，20MiB 上限另有护栏在调用方做）。本项目喂视觉模型的素材
 * 来源不只是 Telegram photo（本身就是 jpeg）——贴纸本体是 webp，GIF 若非
 * 走缩略图兜底、真 image/gif 本体也要转码，因此需要这一层按魔数嗅探格式、
 * 不支持的格式转 png（webp 直转；gif 取第一帧，sharp 默认行为）。
 */

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

/**
 * 把任意支持格式的图片字节转成可直接喂视觉接口的 jpeg/png。jpeg/png
 * 原样直通（无转码开销）；webp/gif 经 sharp 转 png（gif 只取第一帧——本项目
 * 没有抽帧能力，GIF 只能按封面帧分析）。不支持的格式或转码失败均返回
 * null，调用方按「这条不解析」处理。
 */
export async function prepareVisionImage(bytes: Uint8Array): Promise<VisionImage | null> {
  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (format === "jpeg") return { bytes, mime: "image/jpeg" };
  if (format === "png") return { bytes, mime: "image/png" };
  if (format !== "webp" && format !== "gif") return null;

  try {
    // sharp 动态 import：它会加载原生绑定，而转码分支只有 webp/gif 才走；
    // Telegram photo 的 jpeg 直通路径不加载它。
    // 上面 sniffImageFormat 是纯字节判定、不依赖 sharp，正是它让「没有贴纸/GIF
    // 就永不加载 sharp」成立。
    //
    // 模块注册表会缓存首次加载；不得后台预热，避免从不处理 webp/gif 的进程承担
    // 原生绑定常驻内存。
    // 只声明本文件用到的那一路重载（Uint8Array 入参），理由同 copy/translate.ts：
    // `typeof import(...)` 标注被 lint 禁止，而顶层只能拿到类型侧的 Sharp。
    const { default: sharp }: { default: (input: Uint8Array) => Sharp } = await import("sharp");
    const png: Uint8Array = await sharp(bytes).png().toBuffer();
    return { bytes: png, mime: "image/png" };
  } catch (error: unknown) {
    logger.error(`Failed to transcode ${format} image to png for vision API:`, error);
    return null;
  }
}

/** prepareThumbnailJpeg 的入参；三项上限都由调用方按目标平台的硬性要求给出。 */
export interface PrepareThumbnailParams {
  /** 原图字节。收 Uint8Array 而不是 Buffer：sharp 本来就接受它，收窄成 Buffer
   *  只会逼调用方为一张几 MB 的生图白复制一份。 */
  bytes: Uint8Array;
  /** 长边上限（像素）。 */
  maxEdge: number;
  /** 产物体积上限（字节）。 */
  maxBytes: number;
  /** 从高到低逐档尝试的 JPEG 质量；第一个落进体积上限的就用。 */
  qualities: readonly number[];
}

/**
 * 把一张图压成 Telegram 可接收的缩略图：JPEG、长边不超过 maxEdge、体积在
 * maxBytes 以内。
 *
 * 与 prepareVisionImage 的关键差别是**没有直通路径**：那边只要格式对就原样交出
 * 去，而这里必须无条件过一次 sharp——Bot API 对 thumbnail 的三项要求（格式、
 * 边长、体积）里没有一项能靠嗅探字节确认，原样上传一张 1K 生图必然被拒。
 *
 * 先按质量档压一次，超限就逐档降质量重压：单纯把边长砍小会让缩略图糊得看不出
 * 内容，而质量档在 320×320 这个尺寸上还有很大余量。所有档都压不下去时返回
 * null，调用方按「这次没有缩略图」处理，绝不上传一张会被整条拒绝的图。
 */
export async function prepareThumbnailJpeg({
  bytes,
  maxEdge,
  maxBytes,
  qualities,
}: PrepareThumbnailParams): Promise<Uint8Array | null> {
  try {
    // 只声明本函数用到的那一路重载（字节入参），理由同上方 prepareVisionImage。
    const { default: sharp }: { default: (input: Uint8Array) => Sharp } = await import("sharp");
    for (const quality of qualities) {
      const thumbnail: Uint8Array = await sharp(bytes)
        // fit: "inside" 保持原始构图比例，不裁切也不拉伸；withoutEnlargement
        // 避免把一张本来就小的图放大成一堆插值噪点。
        .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (thumbnail.byteLength <= maxBytes) return thumbnail;
    }
    return null;
  } catch (error: unknown) {
    logger.error("Failed to prepare a JPEG thumbnail:", error);
    return null;
  }
}
