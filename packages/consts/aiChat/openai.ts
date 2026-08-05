/**
 * OpenAI 实现包（packages/aiChat/openai/）独占的常量：token 上限、请求超时、
 * SDK 重试次数、画幅表与几处请求参数档位。
 *
 * **四条流水线的模型名不在这里**：它们全部来自 config/openai.json 的 ai_agent
 * 段且**必填**，代码不再持有任何模型默认值（见 packages/config/openai.ts 的模块
 * 头注）。端点同样在那份文件里，留空表示走 SDK 自带的官方端点。
 *
 * 与 Gemini 侧的两处不对等，换供应商时行为会随之变化，不要当成等价替换：
 * 1. 没有内容过滤档位可调（Gemini 侧是全 BLOCK_NONE 的 GEMINI_SAFETY_SETTINGS）。
 *    OpenAI 的文本安全策略不对外暴露参数，回复口径只会更紧。
 * 2. 生图只有三种画幅（1:1 / 3:2 / 2:3），Gemini 侧的十档宽高比会被
 *    aiChat/openai/image.ts 按最近邻收敛，见该文件的 pickImageSize。三档之间
 *    跨度很大：只有 1:1 本身落在方形上，4:3、5:4 这类近方形会收敛到 3:2，
 *    出图构图与 Gemini 侧并不一致。
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
 * 抬高哪两档看提示词长度与思考深度：贴纸整包简介要一次读完整包逐贴纸描述，
 * 媒体描述要看图，两者原来的 4K/8K 都在「光推理就吃满」的量级上，各抬到
 * 16K；回复与冷消息压缩那两档本来就是 64K/48K 量级，留有余量，不动。
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
 * maxRetries）。取 4 与 Gemini 侧「总尝试 5 次」对齐；所有调用方不得再重试
 * 这类请求失败。
 */
export const OPENAI_REQUEST_MAX_RETRIES: number = 4;

/**
 * gpt-image 支持的三种画幅。Gemini 侧十档宽高比按纵横比最近邻映射到这里，
 * 映射发生在 aiChat/openai/image.ts，领域侧仍按十档表达意图。
 */
export const OPENAI_IMAGE_SIZES: readonly Readonly<{ size: string; ratio: number }>[] = [
  { size: "1024x1024", ratio: 1 },
  { size: "1536x1024", ratio: 1536 / 1024 },
  { size: "1024x1536", ratio: 1024 / 1536 },
];

/**
 * 生图请求钉死的输出格式。
 *
 * gpt-image 支持 png/jpeg/webp，不钉就由模型/网关的默认值决定；而载荷校验
 * （aiChat/ai/utils/imagePayload.ts）只认 PNG 与 JPEG 的字节签名，默认值一变
 * 成 WebP，每次生图都会在签名判定处落空——图照样计费，群里只收到一句失败。
 * 取 png 是因为它是官方文档给出的默认值，钉上去不改变当前行为，只是把它从
 * 「服务端说了算」变成「本仓说了算」。generate 与 edit 两条分支都要带。
 */
export const OPENAI_IMAGE_OUTPUT_FORMAT: NonNullable<OpenAI.Images.ImageGenerateParamsNonStreaming["output_format"]> = "png";

/**
 * 生图的内容审核档位，取 SDK 允许的最低档 `low`（另一档是默认的 `auto`）。
 *
 * **只作用于 generate 那条分支**：openai@6.49 的类型里 `moderation` 只声明在
 * `ImageGenerateParamsBase`（node_modules/openai/resources/images.d.ts），
 * `ImageEditParamsBase` 上根本没有这个参数。因此有参考图的那条 edit 分支不带
 * 它——SDK 没声明的字段硬塞会被 TS 拒绝，绕过类型强塞则是对未声明字段的猜测。
 * 两条分支档位不对称是**已知且有意**的，不是漏改。
 *
 * 另注：`ai_agent.base_url` 指向兼容网关时，未知字段可能被严格网关以 400 拒绝；
 * 那与画幅、output_format 同属「网关差异」范畴，实测遇到再按网关能力取舍。
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
