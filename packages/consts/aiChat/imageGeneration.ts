import type { ImageGenerationAspectRatio } from "../../types/aiChat/imageGeneration";
import { exhaustiveList } from "../exhaustiveList";

/** 普通用户按群共享的生图冷却时长。 */
export const IMAGE_GENERATION_COOLDOWN_MS: number = 180_000;
/** 当前生图请求正文允许传给模型的最大字符数。 */
export const IMAGE_GENERATION_PROMPT_MAX_CHARS: number = 2_048;
/** 生图提示词写入自录记忆记号（imageSentTagTemplate）时保留的最大字符数，超出截断。 */
export const IMAGE_GENERATION_MEMORY_PROMPT_MAX_CHARS: number = 275;
/** 生图结果解码后的最大字节数，各供应商共用。 */
export const IMAGE_GENERATION_MAX_BYTES: number = 10 * 1024 * 1024;
/** 标准 base64 对二进制上限的理论编码长度，用于在解码分配内存前拒绝超大响应。 */
export const IMAGE_GENERATION_MAX_ENCODED_CHARS: number = Math.ceil(IMAGE_GENERATION_MAX_BYTES / 3) * 4;
/** PNG 文件签名；只接受与 API 声明 mime type 一致的载荷。 */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** 生图工具单轮最多接纳一张图片；接纳时同时预占一个共享可见动作。 */
export const MAX_GENERATED_IMAGES_PER_REPLY: number = 1;

/** 生图模型接受的全部官方宽高比，供归一校验（aiChat/ai/utils/aspectRatio.ts）与工具说明共用。 */
export const IMAGE_GENERATION_ASPECT_RATIOS: readonly ImageGenerationAspectRatio[] = exhaustiveList<ImageGenerationAspectRatio>()([
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
]);

/** 没有参考图或显式比例时使用的默认正方形比例。 */
export const DEFAULT_IMAGE_GENERATION_ASPECT_RATIO: ImageGenerationAspectRatio = "1:1";
