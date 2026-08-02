import { logger } from "../infra/logger";
import type { Sharp } from "sharp";
import type { VisionImage } from "../types/media";

/**
 * 把任意支持的图片字节转成 Gemini 视觉接口稳妥能收的格式：只认 jpg/jpeg 或 png
 * （官方文档明示，20MiB 上限另有护栏在调用方做）。本项目喂视觉模型的素材
 * 来源不只是 Telegram photo（本身就是 jpeg）——贴纸本体是 webp，GIF 若非
 * 走缩略图兜底、真 image/gif 本体也要转码，因此需要这一层按魔数嗅探格式、
 * 不支持的格式转 png（webp 直转；gif 取第一帧，sharp 默认行为）。
 */

export type SniffedImageFormat = "jpeg" | "png" | "webp" | "gif" | "unknown";

/** 按文件头魔数嗅探格式，不依赖 Telegram 的 file_path 扩展名（贴纸/缩略图的
 *  扩展名不总是可靠）。 */
export function sniffImageFormat(bytes: Buffer): SniffedImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "gif";
  return "unknown";
}

/**
 * 把任意支持格式的图片字节转成可直接喂 Gemini 视觉接口的 jpeg/png。jpeg/png
 * 原样直通（无转码开销）；webp/gif 经 sharp 转 png（gif 只取第一帧——本项目
 * 没有抽帧能力，GIF 只能按封面帧分析）。不支持的格式或转码失败均返回
 * null，调用方按「这条不解析」处理。
 */
export async function prepareVisionImage(bytes: Buffer): Promise<VisionImage | null> {
  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (format === "jpeg") return { bytes, mime: "image/jpeg" };
  if (format === "png") return { bytes, mime: "image/png" };
  if (format !== "webp" && format !== "gif") return null;

  try {
    // sharp 动态 import：它要加载原生绑定，实测本模块静态导入就是 134.8 ms、
    // 常驻 +2.23 MB，约占 AI Worker 启动图的 45%。而这条转码分支只有 webp/gif
    // 才走——Telegram 的 photo 本身是 jpeg，直通那条路一次也用不上它。
    // 上面 sniffImageFormat 是纯字节判定、不依赖 sharp，正是它让「没有贴纸/GIF
    // 就永不加载 sharp」成立。
    //
    // **转码很多时会不会反而变慢？不会，但收益会归零。** 模块注册表缓存住之后，
    // 真加载每个 Worker 进程只发生一次：实测首次 320.4 ms，此后每次 14.2 µs，
    // 而它紧接着的转码本身是 12.00 ms（gif）/ 24.01 ms（webp）——稳态开销占
    // 0.059%，量不出来。收支平衡点约 13 次 webp / 27 次 gif 转码。所以这是个
    // 免费期权：转码多则不赚不赔（sharp 迟早要加载），少或没有则白赚启动与常驻。
    // 也正因如此不要「启动后台预热」：那等于把内存和加载原样加回来，对从不发
    // 贴纸/GIF 的部署方就是纯浪费，恰好抵消掉这里的全部意义。
    // 只声明本文件用到的那一路重载（Buffer 入参），理由同 copy/translate.ts：
    // `typeof import(...)` 标注被 lint 禁止，而顶层只能拿到类型侧的 Sharp。
    const { default: sharp }: { default: (input: Buffer) => Sharp } = await import("sharp");
    const png: Buffer = await sharp(bytes).png().toBuffer();
    return { bytes: png, mime: "image/png" };
  } catch (error: unknown) {
    logger.error(`Failed to transcode ${format} image to png for vision API:`, error);
    return null;
  }
}
