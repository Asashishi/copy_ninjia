/**
 * 生图工具的**本轮参考素材文案**：拼进运行时状态区块，不进工具声明。
 *
 * 参考素材尺寸每轮不同，因此工具声明只留常量指引（IMAGE_REFERENCE_POINTER），真正的
 * 素材说明由本模块渲染到 CURRENT_RUNTIME_STATE 区块（见 workers/aiChat/runtimeState.ts）。
 * 系统提示词与工具声明的前缀缓存约束见 docs/cn/04-invariants.md。
 *
 * 生图与生歌的群冷却不进提示词，只在工具被调用时由执行侧判定并返回剩余秒数（见
 * imageGeneration.ts 与 songGeneration.ts 的冷却闸）；本模块因此不读任何冷却状态。
 *
 * 所属线程：AI 闲聊 Worker；本模块自身不持有缓存。
 */

import {
  IMAGE_REFERENCE_ABSENT,
  IMAGE_REFERENCE_BLOCK_LABEL,
  imageReferencePresent,
} from "../../../../consts/aiChat/prompts/tools";
import { defaultAspectRatioFor } from "./imageGeneration";
import type { ReplyToolContext } from "../../../../types/aiChat/replies";

/** 本模块从本轮回复上下文里真正读到的字段。 */
export type ImageReferenceContext = Pick<ReplyToolContext, "imageGenerationReference">;

/** 上下文子集 + 本轮生图工具的实际挂载结果。 */
export interface ImageReferenceParams {
  readonly ctx: ImageReferenceContext;
  /** createReplyToolset 判定的挂载结果；没挂生图工具就不写参考素材文案。 */
  readonly imageEnabled: boolean;
}

/**
 * 拼出本轮要写进运行时状态区块的生图参考素材段。
 *
 * 没挂生图工具时返回空串，运行时状态区块因此与不含生图的轮次逐字相同——随机插话和
 * 非直接媒体评价轮不挂重媒体工具，也就不该出现任何生图措辞。
 */
export function buildImageReferenceBlock({ ctx, imageEnabled }: ImageReferenceParams): string {
  if (!imageEnabled) return "";
  const reference: ReplyToolContext["imageGenerationReference"] = ctx.imageGenerationReference;
  return "\n" + IMAGE_REFERENCE_BLOCK_LABEL + "\n" + (reference
    ? imageReferencePresent(reference.width, reference.height, defaultAspectRatioFor(reference))
    : IMAGE_REFERENCE_ABSENT);
}
