/**
 * OpenAI 实现包的对外入口：把本包的四项能力装配成一个 AiChatProvider。
 * 领域侧只经 aiChat/provider.ts 的 activeAiProvider 拿到它，不直接 import
 * 本目录下的任何子模块。
 */

import { generateOpenAiImage } from "./image";
import { createOpenAiReplySession } from "./replySession";
import { describeOpenAiVision, generateOpenAiText } from "./text";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** OpenAI 供应商实现。缺 AI_CHAT_OPENAI_API_KEY 时不会被选中，见 aiChat/provider.ts。 */
export const openAiProvider: AiChatProvider = {
  name: "openai",
  createReplySession: createOpenAiReplySession,
  generateText: generateOpenAiText,
  describeVision: describeOpenAiVision,
  generateImage: generateOpenAiImage,
};
