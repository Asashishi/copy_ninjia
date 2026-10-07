/**
 * Anthropic 实现包的对外入口：把本包的能力装配成一个 AiChatProvider。领域侧只经
 * aiChat/provider.ts 的各能力路由拿到它，不直接 import 本目录下的任何子模块。
 *
 * 实现回复会话、纯文本、结构化 JSON、视觉描述与联网检索。生图、语音转写与语音合成缺席；
 * image 与 tts 能力在配置解析时就拒绝 anthropic（见 config/agentCapability.ts）。
 */

import { createAnthropicReplySession } from "./replySession";
import { searchAnthropicWeb } from "./search";
import { describeAnthropicVision, generateAnthropicJson, generateAnthropicText } from "./text";
import type { AiChatProvider } from "../../types/aiChat/provider";

/** Anthropic 协议实现；每项能力的认证与端点来自 config/dynamic/agent.json。 */
export const anthropicProvider: AiChatProvider = {
  name: "anthropic",
  createReplySession: createAnthropicReplySession,
  generateText: generateAnthropicText,
  describeVision: describeAnthropicVision,
  searchWeb: searchAnthropicWeb,
  generateJson: generateAnthropicJson,
};
