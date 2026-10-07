import type Anthropic from "@anthropic-ai/sdk";
import type { AgentCapability } from "../../types/config";

/** Anthropic 实现包（packages/aiChat/anthropic/）的调参常量。 */

/**
 * 按能力取 SDK 每次尝试的超时上限，requestAnthropicMessage 同时以它作整次调用的 deadline；与
 * OpenAI、Gemini 侧同口径。显式给出超时使 SDK 不按 max_tokens 拦截非流式请求。media（视觉
 * 描述）宽于纯文本往返；web_search 由交互式检索与 cron 摘要共用；image 与 tts 不会选 anthropic。
 * 所属模块：aiChat/anthropic/client.ts。
 */
export const ANTHROPIC_REQUEST_TIMEOUTS_MS: Readonly<Record<AgentCapability, number>> = {
  text: 180_000,
  summary: 180_000,
  media: 240_000,
  image: 180_000,
  tts: 180_000,
  web_search: 180_000,
};
/** SDK 对 408/409/429/5xx 的重试次数（不含首次请求），与 OPENAI_REQUEST_MAX_RETRIES 同口径。 */
export const ANTHROPIC_REQUEST_MAX_RETRIES: number = 5;

/** 回复往返的输出 token 上限。 */
export const ANTHROPIC_REPLY_MAX_TOKENS: number = 16_384;
/** 冷消息压缩摘要的输出 token 上限。 */
export const ANTHROPIC_CHAT_SUMMARY_MAX_TOKENS: number = 16_384;
/** 贴纸整包简介的输出 token 上限。 */
export const ANTHROPIC_STICKER_PACK_SUMMARY_MAX_TOKENS: number = 4_096;
/** 单次媒体描述的输出 token 上限。 */
export const ANTHROPIC_MEDIA_DESCRIPTION_MAX_TOKENS: number = 4_096;
/** text 能力结构化 JSON 生成的输出 token 上限。 */
export const ANTHROPIC_JSON_MAX_TOKENS: number = 16_384;
/** 联网检索执行器的输出 token 上限。 */
export const ANTHROPIC_WEB_SEARCH_MAX_TOKENS: number = 8_192;

/**
 * 服务端工具循环到达迭代上限时返回 `stop_reason: "pause_turn"`；实现包把这一轮的 assistant
 * 内容原样接回再续发，最多续发这么多次，用完仍暂停就按产出不可用处理。
 */
export const ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS: number = 3;

/**
 * Messages API 内建联网检索工具的类型名。`allowed_callers: ["direct"]` 让它只由模型直接调用，
 * 不依赖程序化工具调用。
 */
export const ANTHROPIC_WEB_SEARCH_TOOL_TYPE: Anthropic.WebSearchTool20260209["type"] = "web_search_20260209";
/** 内建联网检索工具在请求里的固定名字。 */
export const ANTHROPIC_WEB_SEARCH_TOOL_NAME: Anthropic.WebSearchTool20260209["name"] = "web_search";

/** 回复往返在错误日志里的调用名。 */
export const ANTHROPIC_REPLY_ERROR_LABEL: string = "Anthropic Messages API";
/** 联网检索执行器在错误日志里的调用名。 */
export const ANTHROPIC_WEB_SEARCH_ERROR_LABEL: string = "Anthropic web search";
