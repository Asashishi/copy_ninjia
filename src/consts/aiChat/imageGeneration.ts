/** AI 生图模型与每群独立冷却。模型只支持 1K，分辨率不做成可变参数。 */
export const GEMINI_IMAGE_GENERATION_MODEL: string = "gemini-3.1-flash-lite-image";
export const IMAGE_GENERATION_COOLDOWN_MS: number = 180_000;
export const IMAGE_GENERATION_PROMPT_MAX_CHARS: number = 2_000;
export const IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS: number = 275;
export const IMAGE_GENERATION_MAX_BYTES: number = 10 * 1024 * 1024;
/** 防止不受群冷却限制的 superAdmin 在同一回复轮里反复重试参考图/模型/发送失败。 */
export const IMAGE_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY: number = 2;

export const IMAGE_GENERATION_ASPECT_RATIOS = [
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

export type ImageGenerationAspectRatio = typeof IMAGE_GENERATION_ASPECT_RATIOS[number];
export const DEFAULT_IMAGE_GENERATION_ASPECT_RATIO: ImageGenerationAspectRatio = "1:1";
