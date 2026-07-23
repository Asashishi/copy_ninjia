/** AI 生图模型与每群独立冷却。模型只支持 1K，分辨率不做成可变参数。 */
export const GEMINI_IMAGE_GENERATION_MODEL: string = "gemini-3.1-flash-lite-image";
/** 普通用户按群共享的生图冷却时长。 */
export const IMAGE_GENERATION_COOLDOWN_MS: number = 180_000;
/** 当前生图请求正文允许传给模型的最大字符数。 */
export const IMAGE_GENERATION_PROMPT_MAX_CHARS: number = 2_000;
/** 从滚动记忆拼入生图提示的最大字符数。 */
export const IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS: number = 275;
/** Gemini 生图结果解码后的最大字节数。 */
export const IMAGE_GENERATION_MAX_BYTES: number = 10 * 1024 * 1024;
/** 标准 base64 对二进制上限的理论编码长度，用于在解码分配内存前拒绝超大响应。 */
export const IMAGE_GENERATION_MAX_ENCODED_CHARS: number = Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4;
/** PNG 文件签名；只接受与 API 声明 mime type 一致的载荷。 */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** 防止不受群冷却限制的 superAdmin 在同一回复轮里反复重试参考图/模型/发送失败。 */
export const IMAGE_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY: number = 2;

/** Gemini 生图模型支持的宽高比。 */
export type ImageGenerationAspectRatio =
  | "1:1" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";

/** 生图模型接受的全部官方宽高比，供校验和工具说明共用。 */
export const IMAGE_GENERATION_ASPECT_RATIOS: readonly ImageGenerationAspectRatio[] = [
  "1:1",
  "3:2",
  "2:3",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

/** 没有参考图或显式比例时使用的默认正方形比例。 */
export const DEFAULT_IMAGE_GENERATION_ASPECT_RATIO: ImageGenerationAspectRatio = "1:1";
