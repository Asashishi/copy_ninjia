/**
 * Gemini 实现包的对外入口：把本包的能力装配成一个 AiChatProvider。
 * 领域侧只经 aiChat/provider.ts 的各能力路由拿到它，不直接 import
 * 本目录下的任何子模块。
 *
 * 四项必备能力（回复会话、纯文本、视觉、生图）之外，本包还实现语音转写与生歌。
 * OpenAI 侧也实现语音转写，但不实现生歌；调用方一律按「这个成员在不在」判断，
 * 不按供应商名字判断，理由见 types/aiChat/provider.ts 的模块头注。
 */

import { generateGeminiImage } from "./image";
import { createGeminiReplySession } from "./replySession";
import { generateGeminiSong } from "./song";
import { describeGeminiVision, generateGeminiText, transcribeGeminiVoice } from "./text";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** Google GenAI 协议实现；每项能力的认证与端点来自 config/agent.json。 */
export const geminiProvider: AiChatProvider = {
  name: "google",
  createReplySession: createGeminiReplySession,
  generateText: generateGeminiText,
  describeVision: describeGeminiVision,
  generateImage: generateGeminiImage,
  transcribeVoice: transcribeGeminiVoice,
  generateSong: generateGeminiSong,
};
