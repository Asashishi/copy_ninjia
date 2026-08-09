/**
 * AI 生图的领域入口。真正的收发在当前选中的供应商实现包里（见
 * aiChat/provider.ts），本文件只把请求转过去——生图工具的入参校验、每群
 * 冷却、动作预算与失败计数都在 aiChat/ai/tools/replyToolset/imageGeneration.ts。
 *
 * 选取只读 config/agent.json 的 image 能力；text、summary、media 各自独立路由，
 * 生图不会跟随其中任何一项（理由见 provider.ts）。
 *
 * 宽高比归一（normalizeImageAspectRatio）在 aiChat/ai/utils/aspectRatio.ts，
 * 载荷校验在 aiChat/ai/utils/imagePayload.ts：两者与供应商无关，且必须只有
 * 一份实现，换供应商不该绕过任何一道门禁。
 */

import { imageAiProvider } from "../provider";
import type { AiImageProvider, AiImageRequest } from "../../types/aiChat/provider";
import type { GeneratedChatImage } from "../../types/aiChat/imageGeneration";

/**
 * 生成一张聊天图片。
 * @returns 已通过大小与文件签名校验的图片；请求失败或无可用载荷时为 null
 *   （失败已由实现包记日志）。
 */
export function generateChatImage(request: AiImageRequest): Promise<GeneratedChatImage | null> {
  const provider: AiImageProvider | null = imageAiProvider();
  return provider === null ? Promise.resolve(null) : provider.generateImage(request);
}
