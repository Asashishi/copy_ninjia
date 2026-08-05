/**
 * Gemini 实现包的对外入口：把本包的四项能力装配成一个 AiChatProvider。
 * 领域侧只经 aiChat/provider.ts 的 activeAiProvider 拿到它，不直接 import
 * 本目录下的任何子模块。
 */

import { generateGeminiImage } from "./image";
import { createGeminiReplySession } from "./replySession";
import { describeGeminiVision, generateGeminiText } from "./text";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** Gemini 供应商实现。缺 AI_CHAT_GEMINI_API_KEY 时不会被选中，见 aiChat/provider.ts。 */
export const geminiProvider: AiChatProvider = {
  name: "gemini",
  createReplySession: createGeminiReplySession,
  generateText: generateGeminiText,
  describeVision: describeGeminiVision,
  generateImage: generateGeminiImage,
};
