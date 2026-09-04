/**
 * OpenAI 实现包（packages/aiChat/openai/）独占的常量：token 上限、请求超时、
 * SDK 重试次数、画幅表与几处请求参数档位。
 *
 * **模型名不在这里**：provider=openai 的能力从 config/agent.json 各自读取 model
 * 与可选 base_url，代码不持有任何模型默认值（见 packages/config/agent.ts）。
 *
 * 与 Gemini 侧的几处不对等，换供应商时行为会随之变化，不要当成等价替换：
 * 1. 没有内容过滤档位可调（Gemini 侧是全 BLOCK_NONE 的 GEMINI_SAFETY_SETTINGS）。
 *    OpenAI 的文本安全策略不对外暴露参数，回复口径只会更紧。
 * 2. OpenAI 官方 gpt-image-2 协议按十档发送满足 16 像素倍数约束的 `size`；
 *    GPT Image 通用档收敛到全系共同支持的三种标准尺寸；xAI 协议改用
 *    `aspect_ratio`。三套能力由 agent.image 的必填 image_protocol 明确分流。
 * 3. 采样温度不可调：GPT-5 系推理模型只接受默认值，本包因此不提供任何温度
 *    常量，请求里也不带该参数。查证过的轮次压低随机性、摘要用低温这两条策略
 *    在 OpenAI 侧不生效。日后真换到接受 `temperature` 的型号，再连同常量一起
 *    加回来——**别拿「网关没报错」当能传的依据**：当前部署的代理网关接受该参数
 *    但静默丢弃（传 0.7，响应里 temperature 仍回显 1），真正会以
 *    `unsupported_value` 直接 400 的是官方端点。
 *
 * 所属模块：packages/aiChat/openai/。
 */

import type OpenAI from "openai";
import type { ImageGenerationAspectRatio } from "../../types/aiChat/imageGeneration";

/** OpenAI SDK images generate/edit 共用的尺寸参数。 */
type OpenAiImageSize = NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["size"]>;

/**
 * 各流水线的输出 token 上限。与 Gemini 侧同为供应商能力：上限要覆盖的是该模型
 * 的推理消耗，换模型就得重新估。产出该多长由领域侧的字符上限约束。
 *
 * **这四个数不能照抄 Gemini 表**。Responses 的 `max_output_tokens` 同时封顶
 * reasoning token，而这里四个模型全是 GPT-5 系推理模型：上限吃紧时模型会在
 * 思考阶段就把额度烧光、正文一个字都没产出，响应回
 * `status:"incomplete", incomplete_details.reason:"max_output_tokens"`，被
 * aiChat/openai/response.ts 判成不可用并标 `retryable: true`——于是领域侧的
 * 重试策略把整套退避全耗在一个确定性失败上。上限只是天花板，模型写多少才付
 * 多少 token，因此宁可宽。
 *
 * 贴纸整包简介要一次读完整包逐贴纸描述，媒体描述要看图，两档都保留 16K；
 * 回复与冷消息压缩分别保留 64K/48K 量级，覆盖提示词与推理消耗。
 *
 * 本包不提供采样温度：上面四个模型全是 GPT-5 系推理模型，官方端点只接受默认
 * 温度，传 0.7/0.5 会以 `unsupported_value` 直接 400，因此请求里压根不带这个
 * 参数。注意代理网关可能默默吞掉它而不报错，「网关上没报错」不能当成可以传。
 *
 * 回复这一档包含推理 token。
 */
export const OPENAI_REPLY_MAX_TOKENS: number = 65_536;
/** 冷消息压缩摘要请求的输出 token 上限（含推理 token）。 */
export const OPENAI_CHAT_SUMMARY_MAX_TOKENS: number = 49_152;
/**
 * 贴纸整包简介请求的输出 token 上限（含推理 token）。
 *
 * 比 Gemini 侧的同名常量高一个档次是有意的：这条流水线一旦持续失败，
 * `packSummaries` 会永久为空，第一层选包器（aiChat/ai/tools/stickers.ts）只能
 * 把每个包都描述成「整包简介还在生成中」——bot 从此随机挑包，而且每次启动
 * reconcile 都要为每个包白烧一轮重试。
 */
export const OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS: number = 16_384;
/** 单次媒体描述请求的输出 token 上限（含推理 token）。 */
export const OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS: number = 16_384;

/**
 * `prompt_cache_key` 的命名空间前缀。
 *
 * Responses 的自动前缀缓存按机器分布：同一段前缀的请求落到同一台机器上才可能读到
 * 缓存，键只影响路由、不保证命中，也不会把请求钉死在某台机器上。前缀 + 稳定前缀
 * 指纹的组合让「同一份人设 + 同一套工具 + 同一段参考记忆」的请求聚到一起，同时把
 * 不同群、不同工具形态分散到不同键上，避免单键过热（见 openai/replySession.ts）。
 */
export const OPENAI_PROMPT_CACHE_KEY_PREFIX: string = "hunhebi-reply";

/**
 * 支持显式 prompt cache breakpoint 的 OpenAI 官方模型族前缀。
 *
 * 只认当前官方明确支持该请求形态的 GPT-5.6 家族；兼容端点即使复用同一模型名也
 * 不据此启用，见 aiChat/openai/replySession.ts 的协议门。新增官方模型族时必须先
 * 核对 Responses API 与已安装 SDK 的请求声明，再扩展这里。
 */
export const OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX: string = "gpt-5.6";

type OpenAiPromptCacheTtl = NonNullable<
  NonNullable<
    OpenAI.Responses.ResponseCreateParamsNonStreaming["prompt_cache_options"]
  >["ttl"]
>;

/** GPT-5.6 prompt cache breakpoint 当前唯一支持的最短存活时间。 */
export const OPENAI_PROMPT_CACHE_TTL: OpenAiPromptCacheTtl = "30m";

/** 回复往返在错误日志里的调用名，用于区分是哪条流水线出的错。 */
export const OPENAI_REPLY_ERROR_LABEL: string = "OpenAI API";
/** 生图请求在错误日志里的调用名。 */
export const OPENAI_IMAGE_ERROR_LABEL: string = "OpenAI image generation API";

/** 单次 OpenAI 请求的 per-attempt 超时上限；与 Gemini 侧同口径。 */
export const OPENAI_REQUEST_TIMEOUT_MS: number = 150_000;
/**
 * 生图请求的独立超时：gpt-image 的一次 1024px 生成常年跑到分钟级，套用聊天
 * 那份预算会在模型还在画的时候把连接掐掉。
 */
export const OPENAI_IMAGE_REQUEST_TIMEOUT_MS: number = 300_000;
/**
 * SDK 对 408/429/5xx 的重试次数（不含首次请求，语义同 OpenAI SDK 的
 * maxRetries）。取 5 与 Gemini 侧「首次加最多五次重试」对齐；所有调用方不得再重试
 * 这类请求失败。
 */
export const OPENAI_REQUEST_MAX_RETRIES: number = 5;

/**
 * OpenAI 官方 gpt-image-2 任意尺寸协议的十档画幅。
 *
 * 每边都是 16 的倍数、比例都在官方允许的 1:3..3:1 内；非方形画幅尽量维持在
 * 原三档约 1.5MP 的载荷量级，避免为了比例精确无意放大成本和解码峰值。该协议
 * 不为不支持任意尺寸的模型兜底：部署者必须显式改用 `openai-standard`，不得
 * 靠请求失败后猜测重试。xAI 不读此表，改由 aiChat/openai/image.ts 发送
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
 * GPT Image 模型共同支持的三种标准尺寸。
 *
 * `openai-standard` 使用这张固定表兼容 gpt-image-1、gpt-image-1-mini、
 * gpt-image-1.5、chatgpt-image-latest 与 gpt-image-2；横向、纵向分别收敛到
 * 3:2、2:3，只有 1:1 保持方形。部署者显式选择能力档，运行时不解析模型名、
 * 不在 400 后换尺寸重试。固定 Record 让每次请求直接查表，不计算比例和最近邻。
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
 * xAI 生图分辨率固定为 1K。
 *
 * 领域请求只表达画幅，没有清晰度档；显式钉住 1K 可防止服务端默认值漂到 2K 后
 * 让单图成本、响应字节和解码峰值一起增长。xAI generate/edit 共用此协议口径。
 * 所属模块：packages/aiChat/openai/image.ts。
 */
export const XAI_IMAGE_RESOLUTION: string = "1k";

/**
 * 生图请求钉死的输出格式。
 *
 * OpenAI 原生 images 接口支持 png/jpeg/webp，不钉就由模型/网关的默认值决定；
 * 而载荷校验（aiChat/ai/utils/imagePayload.ts）只认 PNG 与 JPEG 的字节签名，默认值一变
 * 成 WebP，每次生图都会在签名判定处落空——图照样计费，群里只收到一句失败。
 * 取 png 是因为它是官方文档给出的默认值，钉上去不改变当前行为，只是把它从
 * 「服务端说了算」变成「本仓说了算」。OpenAI generate 与 edit 两条分支都带；
 * xAI 协议不接受这一扩展，改传 `response_format: "b64_json"`。
 */
export const OPENAI_IMAGE_OUTPUT_FORMAT: NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["output_format"]> = "png";

/**
 * 生图的内容审核档位，取 SDK 允许的最低档 `low`（另一档是默认的 `auto`）。
 *
 * **只作用于 OpenAI 原生 generate 分支**：openai@6.49 的类型里 `moderation` 只声明在
 * `ImageGenerateParamsBase`（node_modules/openai/resources/images.d.ts），
 * `ImageEditParamsBase` 上根本没有这个参数。因此有参考图的那条 edit 分支不带
 * 它——SDK 没声明的字段硬塞会被 TS 拒绝，绕过类型强塞则是对未声明字段的猜测。
 * 两条分支档位不对称是**已知且有意**的，不是漏改。
 *
 * `agent.image.base_url` 指向兼容网关时仍按本能力档发送；不支持该字段的网关必须
 * 在部署配置层选择兼容能力，不做运行时探测或 400 后降级。
 */
export const OPENAI_IMAGE_MODERATION: NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["moderation"]> = "low";

/**
 * Responses API 请求固定不落服务端会话（store=false）：AI Worker 崩溃重建后
 * 没有任何一方持有 response id，留着服务端状态只会白白攒垃圾。多轮工具往返
 * 因此靠本地累积的 input item 列表续接，见 aiChat/openai/replySession.ts。
 */
export const OPENAI_STORE_RESPONSES: boolean = false;

/**
 * 服务端错误诊断串里每个字段的截断长度（见 aiChat/openai/response.ts 的
 * describeResponseError）。
 *
 * 需要上界是因为 `error` 的形状不受本进程控制：SDK 把它标成 `{ code, message }`
 * 两项必填字符串，而兼容网关可以在这两个位置放任意 JSON——包括一个把整段上游
 * 响应塞进去的大对象。诊断只用于定位「这次为什么没产出」，头几百字符足够，
 * 不设界的话一条坏响应就能把 `logs/` 刷掉一大块。
 *
 * 取 500：够放下一整句服务端错误描述（含 request id 之类的尾巴），又远小于
 * 单条日志的可读上限。
 */
export const OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS: number = 500;
