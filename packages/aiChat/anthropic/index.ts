/**
 * Anthropic 实现包的对外入口：把本包的能力装配成一个 AiChatProvider。领域侧只经
 * aiChat/provider.ts 的各能力路由拿到它，不直接 import 本目录下的任何子模块。
 *
 * 实现回复会话、纯文本、结构化 JSON、视觉描述与联网检索。语音转写与语音合成缺席（Messages
 * API 没有音频输入输出）；生图同样没有，image 与 tts 能力在配置解析时就拒绝 anthropic
 * （见 config/agentCapability.ts），generateImage 只为满足契约，恒交回 null。
 */

import { createAnthropicReplySession } from "./replySession";
import { searchAnthropicWeb } from "./search";
import { describeAnthropicVision, generateAnthropicJson, generateAnthropicText } from "./text";
import type { GeneratedChatImage } from "../../types/aiChat/imageGeneration";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** Anthropic 没有生图能力；配置层不会把 image 路由到这里，恒交回「这次没做出来」。 */
function generateAnthropicImage(): Promise<GeneratedChatImage | null> {
  return Promise.resolve(null);
}

/** Anthropic 协议实现；每项能力的认证与端点来自 config/dynamic/agent.json。 */
export const anthropicProvider: AiChatProvider = {
  name: "anthropic",
  createReplySession: createAnthropicReplySession,
  generateText: generateAnthropicText,
  describeVision: describeAnthropicVision,
  generateImage: generateAnthropicImage,
  searchWeb: searchAnthropicWeb,
  generateJson: generateAnthropicJson,
};
