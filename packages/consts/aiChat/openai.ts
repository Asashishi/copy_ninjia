/**
 * OpenAI 实现包（packages/aiChat/openai/）独占的常量：token 上限、请求超时、
 * SDK 重试次数、画幅表、语音合成两种线协议的参数与几处请求参数档位。
 *
 * **模型名不在这里**：provider=openai 的能力从 config/dynamic/agent.json 各自读取 model
 * 与可选 base_url，代码不持有任何模型默认值（见 packages/config/agent.ts）。
 *
 * 与 Gemini 侧的差异（换供应商时行为随之变化，不是等价替换）：
 * 1. 没有内容过滤档位可调（Gemini 侧是 GEMINI_SAFETY_SETTINGS）。
 *    OpenAI 的文本安全策略不对外暴露参数。
 * 2. 生图按 agent.image 的必填 image_protocol 分流：OpenAI 官方 gpt-image-2 协议
 *    按 OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO 发送满足 16 像素倍数约束的 `size`；
 *    GPT Image 通用档按 OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO 取全系共同支持的标准尺寸；
 *    xAI 协议改用 `aspect_ratio`。
 * 3. 采样温度不可调：GPT-5 系推理模型只接受默认值，本包不提供任何温度常量，
 *    请求里也不带该参数；查证过的轮次压低随机性、摘要用低温这两条策略在
 *    OpenAI 侧不生效。官方端点会以 `unsupported_value` 拒绝该参数。
 *
 * 所属模块：packages/aiChat/openai/。
 */

import type OpenAI from "openai";
import type { ImageGenerationAspectRatio } from "../../types/aiChat/imageGeneration";
import type { AgentCapability } from "../../types/config";

/** OpenAI SDK images generate/edit 共用的尺寸参数。 */
type OpenAiImageSize = NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["size"]>;

/**
 * 各流水线的输出 token 上限。与 Gemini 侧同为供应商能力：上限覆盖该模型的推理消耗，
 * 换模型需重新估；产出长度由领域侧的字符上限约束。
 *
 * Responses 的 `max_output_tokens` 同时封顶 reasoning token，这些流水线用的都是推理型
 * 模型（如 GPT-5 系）；推理耗尽额度时响应为
 * `status:"incomplete", incomplete_details.reason:"max_output_tokens"`，被
 * aiChat/openai/response.ts 判成不可用并标 `retryable: true`。回复这一档包含推理 token。
 *
 * 本包不提供采样温度（见模块头注）。
 */
export const OPENAI_REPLY_MAX_TOKENS: number = 65_536;
/** 冷消息压缩摘要请求的输出 token 上限（含推理 token）。 */
export const OPENAI_CHAT_SUMMARY_MAX_TOKENS: number = 49_152;
/**
 * 贴纸整包简介请求的输出 token 上限（含推理 token）。
 */
export const OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS: number = 16_384;
/** 单次媒体描述请求的输出 token 上限（含推理 token）。 */
export const OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS: number = 16_384;
/** text 能力结构化 JSON 生成（aiChat/openai/text.ts 的 generateOpenAiJson）的输出 token 上限（含推理 token）。 */
export const OPENAI_JSON_MAX_TOKENS: number = 16_384;
/** 联网检索执行器（aiChat/openai/search.ts）单次请求的输出 token 上限（含推理 token）。 */
export const OPENAI_WEB_SEARCH_MAX_TOKENS: number = 16_384;
/** 联网检索执行器在错误日志里的调用名。所属模块：aiChat/openai/search.ts。 */
export const OPENAI_WEB_SEARCH_ERROR_LABEL: string = "OpenAI web search";

/**
 * `prompt_cache_key` 的命名空间前缀。
 *
 * Responses 的自动前缀缓存按机器分布，键只影响路由、不保证命中。前缀 + 稳定前缀
 * 指纹的组合把「同一份人设 + 同一套工具 + 同一段参考记忆」的请求聚到同一个键，
 * 不同群、不同工具形态落在不同键上（见 aiChat/openai/replySession.ts）。
 */
export const OPENAI_PROMPT_CACHE_KEY_PREFIX: string = "hunhebi-reply";

/**
 * Responses API 接受的 `prompt_cache_key` 最大长度（字符）。
 *
 * 超长会被整条请求以 400 拒绝。前缀 + `:` + 定长 base64url SHA-256 指纹
 * （见 libs/prefixFingerprint.ts）必须落在这个上限内，由测试核对。
 */
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH: number = 64;

/**
 * 支持显式 prompt cache breakpoint 的 OpenAI 官方模型族前缀。
 *
 * 只认官方明确支持该请求形态的模型族；兼容端点即使复用同一模型名也
 * 不据此启用，见 aiChat/openai/replySession.ts 的协议门。新增官方模型族时必须先
 * 核对 Responses API 与已安装 SDK 的请求声明，再扩展这里。
 */
export const OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX: string = "gpt-5.6";

type OpenAiPromptCacheTtl = NonNullable<
  NonNullable<
    OpenAI.Responses.ResponseCreateParamsNonStreaming["prompt_cache_options"]
  >["ttl"]
>;

/** prompt cache breakpoint 使用的存活时间。 */
export const OPENAI_PROMPT_CACHE_TTL: OpenAiPromptCacheTtl = "30m";

/** 回复往返在错误日志里的调用名，用于区分是哪条流水线出的错。 */
export const OPENAI_REPLY_ERROR_LABEL: string = "OpenAI API";
/** 生图请求在错误日志里的调用名。 */
export const OPENAI_IMAGE_ERROR_LABEL: string = "OpenAI image generation API";

/**
 * 生图请求在每次请求上覆盖的独立超时，不套用 OPENAI_REQUEST_TIMEOUTS_MS 的预算。
 */
export const OPENAI_IMAGE_REQUEST_TIMEOUT_MS: number = 300_000;
/**
 * 按能力取 SDK 每次尝试的超时上限，requestOpenAiResult 同时以它作整次调用的 deadline；与
 * Gemini 侧同口径。media（视觉描述与语音转写）宽一档：服务端需先把整份图片或整段音频解码进
 * 上下文才开始出字；视觉与语音共用 `agent.media`，因此共用同一档，语音转写也按这一档设
 * deadline。web_search 由交互式检索与 cron 摘要共用。image 与 tts 分别由 aiChat/openai/image.ts
 * 与 aiChat/openai/speech.ts 在每次请求上另行覆盖。所属模块：aiChat/openai/client.ts、aiChat/openai/text.ts。
 */
export const OPENAI_REQUEST_TIMEOUTS_MS: Readonly<Record<AgentCapability, number>> = {
  text: 180_000,
  summary: 180_000,
  media: 240_000,
  image: 180_000,
  tts: 180_000,
  web_search: 180_000,
};
/**
 * SDK 对 408/429/5xx 的重试次数（不含首次请求，语义同 OpenAI SDK 的
 * maxRetries）；所有调用方不得再重试这类请求失败。
 */
export const OPENAI_REQUEST_MAX_RETRIES: number = 5;

/**
 * OpenAI 官方 gpt-image-2 任意尺寸协议的各档画幅。
 *
 * 每边都是 16 的倍数、比例都在官方允许的范围内；非方形画幅的像素量与
 * OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO 的 3:2 档同一量级。该协议
 * 不为不支持任意尺寸的模型兜底：部署者必须显式改用 `openai-standard`，不靠
 * 请求失败后猜测重试。xAI 不读此表，改由 aiChat/openai/image.ts 发送
 * `aspect_ratio`。
 */
export const OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO: Readonly<
  Record<ImageGenerationAspectRatio, OpenAiImageSize>
> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "4:3": "1408x1056",
  "3:4": "1056x1408",
  "5:4": "1360x1088",
  "4:5": "1088x1360",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "21:9": "1568x672",
};

/**
 * GPT Image 模型共同支持的标准尺寸。
 *
 * `openai-standard` 使用这张固定表兼容 gpt-image-1、gpt-image-1-mini、
 * gpt-image-1.5、chatgpt-image-latest 与 gpt-image-2；横向、纵向分别收敛到
 * 3:2、2:3，只有 1:1 保持方形。部署者显式选择能力档，运行时不解析模型名、
 * 不在 400 后换尺寸重试；每次请求直接查表。
 */
export const OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO: Readonly<
  Record<ImageGenerationAspectRatio, OpenAiImageSize>
> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "4:3": "1536x1024",
  "3:4": "1024x1536",
  "5:4": "1536x1024",
  "4:5": "1024x1536",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "21:9": "1536x1024",
};

/**
 * xAI 生图请求显式指定的分辨率。
 *
 * 领域请求只表达画幅，没有清晰度档。xAI generate/edit 共用此协议口径。
 * 所属模块：packages/aiChat/openai/image.ts。
 */
export const XAI_IMAGE_RESOLUTION: string = "1k";

/**
 * 生图请求指定的输出格式，取 png（官方文档给出的默认格式）。
 *
 * 载荷校验（aiChat/ai/utils/imagePayload.ts）只认 PNG 与 JPEG 的字节签名。
 * OpenAI generate 与 edit 两条分支都带；
 * xAI 协议不接受这一扩展，改传 `response_format: "b64_json"`。
 */
export const OPENAI_IMAGE_OUTPUT_FORMAT: NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["output_format"]> = "png";

/**
 * 生图的内容审核档位，取 SDK 允许的最低档 `low`（另一档是默认的 `auto`）。
 *
 * **只作用于 OpenAI 原生 generate 分支**：已安装 SDK 的类型里 `moderation` 只声明在
 * `ImageGenerateParamsBase`（node_modules/openai/resources/images.d.ts），
 * `ImageEditParamsBase` 上没有这个参数，有参考图的那条 edit 分支不带它，
 * 两条分支档位不对称。
 *
 * `agent.image.base_url` 指向兼容网关时仍按本能力档发送；不支持该字段的网关须
 * 在部署配置层选择兼容能力，不做运行时探测或 400 后降级。
 */
export const OPENAI_IMAGE_MODERATION: NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["moderation"]> = "low";

/** openai 语音协议（audio/speech）在错误日志里的调用名。 */
export const OPENAI_SPEECH_ERROR_LABEL: string = "OpenAI speech synthesis API";
/** xai 语音协议（`POST /tts`）在错误日志里的调用名。 */
export const XAI_SPEECH_ERROR_LABEL: string = "xAI speech synthesis API";

/**
 * 两种语音协议单次合成的总期限（含全部尝试与退避），同时是每次尝试的超时；口径同
 * consts/aiChat/gemini.ts 的 GEMINI_SPEECH_REQUEST_TIMEOUT_MS。所属模块：aiChat/openai/speech.ts
 * 与 aiChat/openai/xaiSpeech.ts。
 */
export const OPENAI_SPEECH_REQUEST_TIMEOUT_MS: number = 60_000;

/**
 * 两种语音协议的总尝试次数（含首次）。openai 协议交给 SDK 的 maxRetries（本值减一），
 * xai 协议由 aiChat/openai/xaiSpeech.ts 对网络错误与 408/429/5xx 按同一上限重试。
 */
export const OPENAI_SPEECH_REQUEST_ATTEMPTS: number = 3;

/**
 * openai 语音协议请求的响应格式：`opus` 即 OGG 封装的 Opus，是 Telegram sendVoice 的原生语音
 * 格式，校验容器后原样发送、不再转码（见 aiChat/ai/voiceEncoding.ts）。兼容端点须支持该格式。
 */
export const OPENAI_SPEECH_RESPONSE_FORMAT: NonNullable<OpenAI.Audio.SpeechCreateParams["response_format"]> = "opus";

/** xai 语音协议未配置 base_url 时使用的 xAI 官方 API 根地址。 */
export const XAI_API_BASE_URL: string = "https://api.x.ai/v1";

/** xai 语音协议相对 base_url 的端点路径。 */
export const XAI_SPEECH_ENDPOINT_PATH: string = "tts";

/** `agent.tts.language` 缺省时交给 xAI 的语言：`auto` 表示由服务端识别台词语言。 */
export const XAI_SPEECH_DEFAULT_LANGUAGE: string = "auto";

/**
 * xai 语音协议请求的 `output_format.codec`：`mp3`。xAI 不提供 Opus，Telegram sendVoice 直接接受
 * MP3，校验帧结构后原样发送、不再转码（见 aiChat/ai/voiceEncoding.ts）。
 */
export const XAI_SPEECH_CODEC: string = "mp3";

/** xai 语音协议请求的 `output_format.sample_rate`（Hz），即 xAI 的默认采样率。 */
export const XAI_SPEECH_SAMPLE_RATE: number = 24_000;

/** xai 语音协议请求的 `output_format.bit_rate`（bps）。 */
export const XAI_SPEECH_BIT_RATE: number = 64_000;

/** xai 语音协议重试前的首次退避（ms），之后每次翻倍；退避受总期限约束。 */
export const XAI_SPEECH_RETRY_BASE_DELAY_MS: number = 500;

/** xai 语音协议非 2xx 响应体读入错误日志的字节上限。 */
export const XAI_SPEECH_ERROR_BODY_MAX_BYTES: number = 1_024;

/**
 * Responses API 请求固定不落服务端会话（store=false）；多轮工具往返
 * 靠本地累积的 input item 列表续接，见 aiChat/openai/replySession.ts。
 */
export const OPENAI_STORE_RESPONSES: boolean = false;

/**
 * 服务端错误诊断串里每个字段的截断长度（见 aiChat/openai/response.ts 的
 * describeResponseError）。
 *
 * `error` 的形状不受本进程控制：SDK 把它标成 `{ code, message }` 两项必填字符串，
 * 而兼容网关可以在这两个位置放任意 JSON；诊断串按本值截断。
 */
export const OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS: number = 500;

/** OpenAI 响应缺省 output 时复用的只读空列表。 */
export const EMPTY_OUTPUT_ITEMS: readonly [] = [];
