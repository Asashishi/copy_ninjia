/** Gemini 生图模型支持的宽高比。 */
export type ImageGenerationAspectRatio =
  | "1:1" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";

/** 已校验签名、大小与 MIME 的聊天图片结果。 */
export interface GeneratedChatImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
}

/** 某群当前生图资格及不可用时的剩余冷却。 */
export type ImageGenerationAvailability =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

/** 生图原子占位结果；token 只供原占位者释放。 */
export type ImageGenerationClaim =
  | { allowed: true; token: symbol | null }
  | { allowed: false; retryAfterMs: number };
