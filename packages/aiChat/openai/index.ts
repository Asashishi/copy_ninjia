/**
 * OpenAI 实现包的对外入口：把本包的四项能力装配成一个 AiChatProvider。
 * 领域侧只经 aiChat/provider.ts 的各能力路由拿到它，不直接 import
 * 本目录下的任何子模块。
 *
 * 音频转写走 OpenAI 兼容 audio transcriptions；所配 media 模型/端点是否支持由
 * 第一次真实请求确认并缓存。生歌仍是可选能力，本包不实现，因此 OpenAI song
 * 配置不会把工具挂进本轮。
 */

import { generateOpenAiImage } from "./image";
import { createOpenAiReplySession } from "./replySession";
import { describeOpenAiVision, generateOpenAiText, transcribeOpenAiVoice } from "./text";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** OpenAI 协议实现；每项能力的认证与端点来自 config/agent.json。 */
export const openAiProvider: AiChatProvider = {
  name: "openai",
  createReplySession: createOpenAiReplySession,
  generateText: generateOpenAiText,
  describeVision: describeOpenAiVision,
  generateImage: generateOpenAiImage,
  transcribeVoice: transcribeOpenAiVoice,
};
