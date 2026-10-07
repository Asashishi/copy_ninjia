/** 生图的官方宽高比集合。OAI 兼容侧按显式线协议映射：OpenAI 任意尺寸档逐档
 *  发送 size、标准档收敛到全系通用的标准尺寸，xAI 改传最近 aspect_ratio，见
 *  aiChat/openai/image.ts。 */
import type { Base64PayloadDecodeFailure } from "./payload";

export type ImageGenerationAspectRatio =
  | "1:1" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";

/** 已校验签名、大小与 MIME 的聊天图片结果。 */
export interface GeneratedChatImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

/**
 * 生图载荷不可用的具体原因，只用于错误日志定位（英文，见 AGENTS.md 的日志约定）；
 * 上层都按「没图」处理。
 */
export type GeneratedImageDecodeFailure =
  | Base64PayloadDecodeFailure
  | "byte signature matches neither PNG nor JPEG";

/** 按字节签名解码生图载荷的结果；失败一律带上可记日志的原因。 */
export type GeneratedImageDecodeResult =
  | { readonly ok: true; readonly image: GeneratedChatImage }
  | { readonly ok: false; readonly reason: GeneratedImageDecodeFailure };
