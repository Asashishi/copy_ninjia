/** 生图的官方宽高比集合。OpenAI 侧只有三种画幅，由实现包按最近邻收敛，
 *  见 packages/aiChat/openai/image.ts 的 pickImageSize。 */
export type ImageGenerationAspectRatio =
  | "1:1" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";

/** 已校验签名、大小与 MIME 的聊天图片结果。 */
export interface GeneratedChatImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

/**
 * 生图载荷不可用的具体原因，只用于错误日志定位（英文，见 AGENTS.md 的日志约定）。
 *
 * 分得这么细是因为这几种失败对上层完全等价——都是「没图」——而处置方式差得
 * 很远：格式不匹配要去钉 output_format，超限要去调 IMAGE_GENERATION_MAX_BYTES
 * 或画幅，脏 base64 才是网关问题。不点名就只能从「生图失败」四个字里猜。
 */
export type GeneratedImageDecodeFailure =
  | "empty payload"
  | "encoded payload exceeds the size limit"
  | "payload is not canonical base64"
  | "decoded payload is empty or exceeds the size limit"
  | "byte signature matches neither PNG nor JPEG";

/** 按字节签名解码生图载荷的结果；失败一律带上可记日志的原因。 */
export type GeneratedImageDecodeResult =
  | { readonly ok: true; readonly image: GeneratedChatImage }
  | { readonly ok: false; readonly reason: GeneratedImageDecodeFailure };

/** 某群当前生图资格及不可用时的剩余冷却。 */
export type ImageGenerationAvailability =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** 生图原子占位结果；token 只供原占位者释放。 */
export type ImageGenerationClaim =
  | { allowed: true; token: symbol | null }
  | { allowed: false; retryAfterMs: number };
