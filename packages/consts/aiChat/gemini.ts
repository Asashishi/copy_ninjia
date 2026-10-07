/**
 * Gemini 实现包（packages/aiChat/gemini/）独占的常量：请求超时与 SDK 重试次数、
 * 采样温度与输出 token 上限、生图分辨率、内容过滤与工具配置、语音合成参数、日志调用名，
 * 以及回复共用显式缓存（text scope）的前缀、槽数与日志名。
 *
 * **模型名不在这里**：provider=google 的能力从 config/dynamic/agent.json 各自读取 model
 * 与可选 base_url，代码不持有任何模型默认值（见 config/agent.ts）。
 *
 * 与供应商无关的预算（工具轮数、动作上限）在 consts/aiChat/tools.ts 与各领域 consts
 * 里；采样温度与输出 token 上限属于供应商能力，各家各自定义。
 * 所属模块：packages/aiChat/gemini/。
 */

import { HarmBlockThreshold, HarmCategory } from "@google/genai";
import type { SafetySetting } from "@google/genai";
import type { AgentCapability } from "../../types/config";

/** 生图请求固定的分辨率档位。 */
export const GEMINI_IMAGE_SIZE: string = "1K";

/**
 * 闲聊回复生成温度，仅 Gemini 使用；OpenAI 侧不发送温度参数
 * （见 consts/aiChat/openai.ts 的模块头注）。
 */
export const GEMINI_REPLY_TEMPERATURE: number = 1.0;
/** 本轮已观测到服务端搜索后，后续工具轮改用的温度；搜索与首次成文发生在
 *  同一次请求里，那一轮仍按 GEMINI_REPLY_TEMPERATURE 生成。 */
export const GEMINI_GROUNDED_REPLY_TEMPERATURE: number = 0.7;
/** 冷消息压缩与贴纸整包简介共用的总结温度。 */
export const GEMINI_SUMMARY_TEMPERATURE: number = 0.5;

/**
 * 各流水线的输出 token 上限，均为供应商能力（换模型需重新估算）。产出实际长度
 * 由领域侧字符上限（SUMMARY_MAX_CHARS 等）约束。回复这一档包含思考 token。
 */
export const GEMINI_REPLY_MAX_TOKENS: number = 65_536;
/** 冷消息压缩摘要请求的输出 token 上限。 */
export const GEMINI_CHAT_SUMMARY_MAX_TOKENS: number = 49_152;
/** 贴纸整包简介请求的输出 token 上限。 */
export const GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS: number = 4_096;
/** 单次媒体描述请求的输出 token 上限。 */
export const GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS: number = 8_192;
/**
 * 单次语音转写请求的输出 token 上限，高于媒体描述档。
 */
export const GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS: number = 16_384;
/** text 能力结构化 JSON 生成（aiChat/gemini/text.ts 的 generateGeminiJson）的输出 token 上限（含思考 token）。 */
export const GEMINI_JSON_MAX_TOKENS: number = 16_384;
/** 联网检索执行器（aiChat/gemini/search.ts）单次请求的输出 token 上限（含思考 token）。 */
export const GEMINI_WEB_SEARCH_MAX_TOKENS: number = 16_384;
/** 联网检索执行器在错误日志里的调用名。所属模块：aiChat/gemini/search.ts。 */
export const GEMINI_WEB_SEARCH_ERROR_LABEL: string = "Gemini web search";

/** 回复往返在错误日志里的调用名，用于区分是哪条流水线出的错。 */
export const GEMINI_REPLY_ERROR_LABEL: string = "Gemini API";
/** 生图请求在错误日志里的调用名。 */
export const GEMINI_IMAGE_ERROR_LABEL: string = "Gemini image generation API";
/** 语音合成请求在错误日志里的调用名。 */
export const GEMINI_SPEECH_ERROR_LABEL: string = "Gemini speech synthesis API";

/**
 * 单次语音合成请求的总超时。语音合成走 Interactions API，SDK 只继承构造期的
 * `httpOptions.timeout`，因此这一档在每次调用时显式传入（见 aiChat/gemini/speech.ts）。
 */
export const GEMINI_SPEECH_REQUEST_TIMEOUT_MS: number = 60_000;

/** 语音合成请求的总尝试次数（含首次）；SDK 只对 408/429/5xx 与网络错误重试。 */
export const GEMINI_SPEECH_REQUEST_ATTEMPTS: number = 3;

/** 语音合成的采样温度，经 `generation_config.temperature` 传入。 */
export const GEMINI_SPEECH_TEMPERATURE: number = 1;

/**
 * 按能力取 SDK 每次尝试的超时上限，requestGeminiResult 同时以它作整次调用的 deadline。
 * media（视觉描述与语音转写）宽一档：服务端需先把整份图片或整段音频解码进上下文才开始出字；
 * 视觉与语音共用 config/dynamic/agent.json 的 `agent.media`，
 * 共用同一档。web_search 由交互式检索与 cron 摘要共用。语音合成由 aiChat/gemini/speech.ts
 * 在每次调用上另行覆盖（GEMINI_SPEECH_REQUEST_TIMEOUT_MS）。所属模块：aiChat/gemini/client.ts。
 */
export const GEMINI_REQUEST_TIMEOUTS_MS: Readonly<Record<AgentCapability, number>> = {
  text: 180_000,
  summary: 180_000,
  media: 240_000,
  image: 180_000,
  tts: 180_000,
  web_search: 180_000,
};
/**
 * Gemini SDK 对 408/429/5xx 的总尝试次数（含首次）；显式传入才能
 * 启用 SDK 的 retryOptions，所有调用方不得再重试这类请求失败。
 */
export const GEMINI_REQUEST_RETRY_ATTEMPTS: number = 6;

/**
 * 所有 Gemini 请求统一携带的内容过滤设置；应用不按可调概率等级主动拒绝，
 * 仍受 API 不可关闭的核心安全策略约束。数组与元素字段都由只读类型表达不可变
 * （见 AGENTS.md 的「常量」一节）。
 *
 * 这一档没有跨供应商对等物：OpenAI 侧的文本安全策略不可调（见
 * consts/aiChat/openai.ts 的模块头注）。
 */
export const GEMINI_SAFETY_SETTINGS: readonly Readonly<SafetySetting>[] = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

/**
 * 服务端检索工具与函数调用混用时必须携带的 toolConfig
 * （`tool_config.include_server_side_tool_invocations`）；它与 googleSearch
 * 同进同出，由每次完整请求直接填进 config。
 */
export const GEMINI_SERVER_TOOL_CONFIG: Readonly<{ includeServerSideToolInvocations: true }> = {
  includeServerSideToolInvocations: true,
};

/**
 * 回复共用显式缓存（text scope）的 displayName 前缀，后接「分槽指纹:内容指纹」两段
 * 指纹（形态见 consts/geminiContextCache.ts 的 GEMINI_CONTEXT_CACHE_KEY_PATTERN）。
 * 启动扫描只接管或清理带这个前缀的条目。所属模块：aiChat/gemini/contextCache.ts。
 */
export const GEMINI_TEXT_CACHE_DISPLAY_NAME_PREFIX: string = "copy-ninjia:text:";

/**
 * 回复共用显式缓存同时登记的分槽上限。一个槽对应一份系统提示词；人设由启动总闸接管、
 * 进程内恒定，全群只用一槽，启动扫描接管的其它槽超出时按最久未用删除。所属模块：
 * aiChat/gemini/contextCache.ts。
 */
export const GEMINI_TEXT_CACHE_MAX_SLOTS: number = 1;

/** 回复共用显式缓存的创建、续期、删除与扫描在日志里的调用名。所属模块：aiChat/gemini/contextCache.ts。 */
export const GEMINI_TEXT_CACHE_ERROR_LABEL: string = "Gemini context cache API";
