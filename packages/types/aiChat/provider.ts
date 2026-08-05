/**
 * AI 闲聊的供应商中立契约。回复往返、纯文本生成、视觉描述与生图这四项能力
 * 由本文件定义形状，具体收发在 aiChat/<vendor>/ 实现包里落地。
 *
 * 领域侧（工具编排、记忆压缩、贴纸目录、生图工具）只认这里的类型，不再
 * import 任何供应商 SDK 的类型——换供应商时编译期就能确认哪些调用点没接上。
 * 跨模块约束见 docs/04-invariants.md。
 */

import type { GeneratedChatImage, ImageGenerationAspectRatio } from "./imageGeneration";
import type { VisionImage } from "../media";

/**
 * 供应商标识。落进 `state.json` 的 `global.model`（生图与闲聊两项）与 AI Worker
 * 协议的口径一律用这两个名字；`/image_model gpt`、`/chat_model gpt` 里的 `gpt`
 * 只是面向用户的别名，在命令层就归一，不让两套词汇渗进状态与协议。
 */
export type AiProviderName = "gemini" | "openai";

/**
 * 一个自定义函数工具的中立声明。参数一律用 JSON Schema 表达：Gemini 的
 * `parametersJsonSchema` 与 OpenAI 的 `parameters` 都直接吃这份对象，工具
 * 定义因此不必按供应商分叉。
 */
export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: Readonly<Record<string, unknown>>;
}

/** 模型抛回的一次函数调用。id 供需要回填调用标识的供应商使用（OpenAI 的
 *  `call_id` 必填，Gemini 的 `id` 可选）。 */
export interface AiFunctionCall {
  readonly id?: string;
  readonly name: string;
  /** 未解析的入参 JSON 字符串；由领域侧的工具执行器自行解析。 */
  readonly argumentsJson: string;
}

/** 一次函数调用的执行结果，回喂给模型。 */
export interface AiToolOutput {
  readonly call: AiFunctionCall;
  /** 工具实现返回的 JSON 字符串（见 packages/aiChat/ai/tools）。 */
  readonly responseJson: string;
}

/**
 * 单次文本生成的业务结果。供应商 SDK 已耗尽 HTTP 重试时 retryable=false，
 * 防止调用方再套一层完整请求重试；HTTP 成功但正文不可用时才允许业务层重采样。
 */
export type AiTextResult =
  | { ok: true; text: string }
  | { ok: false; retryable: boolean };

/** 一轮回复请求里随轮次变化的工具配置与采样语义。 */
export interface AiReplyTurnRequest {
  /** 本轮完整系统提示词（人设 + 运行时段落），每轮重算。 */
  readonly systemPrompt: string;
  /** 本轮允许模型调用的自定义函数；已按预算与禁用名单过滤。 */
  readonly functions: readonly AiToolDefinition[];
  /** 本轮是否挂载供应商的服务端联网检索工具。 */
  readonly webSearchEnabled: boolean;
  /**
   * 本轮之前是否已经观测到服务端检索。
   *
   * 只传语义、不传温度：采样参数因供应商而异（OpenAI 侧的推理模型根本不接受
   * temperature），具体取什么值由各实现包按自己的 consts 决定，见
   * consts/aiChat/{gemini,openai}.ts。
   */
  readonly grounded: boolean;
}

/** 一轮回复请求的结果。ok=false 时正文与函数调用一律为空，不得消费。 */
export interface AiReplyTurn {
  readonly ok: boolean;
  /** 模型正文；无正文时为 null。 */
  readonly text: string | null;
  readonly functionCalls: readonly AiFunctionCall[];
  /** 本次请求中服务端已执行的联网检索次数，用于整轮检索预算核销。 */
  readonly webSearchCalls: number;
  readonly finishReason?: string;
  readonly finishMessage?: string;
  /**
   * 供应商明确报告「服务端工具调用过多」（Gemini 的 TOO_MANY_TOOL_CALLS）。
   * 没有对等信号的供应商恒为 false——上层据此决定要不要关掉检索重试一次，
   * fail-safe 含义是「不触发那次额外重试」，而不是「一定没超限」。
   */
  readonly toolCallLimitHit: boolean;
}

/**
 * 一轮回复的多次工具往返会话。会话自己保管对话记录（Gemini 是带 thought
 * signature 的 Content 列表，OpenAI 是 Responses 的 input item 列表），
 * 调用方只按领域语义推进，不接触任何供应商结构。
 *
 * 生命周期：createReplySession 起、单轮回复结束即弃，不跨轮复用，也不进
 * 任何长期缓存。
 */
export interface AiReplySession {
  /** 发一次请求；内部同时把模型这一轮的输出记进会话记录。 */
  request(request: AiReplyTurnRequest): Promise<AiReplyTurn>;
  /**
   * 把上一轮的函数执行结果追加进会话记录。
   * @returns 记录成功为 true；供应商没能交回可续接的模型轮次（例如 Gemini
   *   响应缺 content）时为 false，调用方据此收尾本轮。
   */
  appendToolOutputs(outputs: readonly AiToolOutput[]): boolean;
}

/** 纯文本生成的两条流水线。两者的输出 token 上限差一个数量级，由各实现包
 *  按自己的 consts 分别给值。 */
export type AiTextPurpose = "chatSummary" | "stickerPackSummary";

/**
 * 纯文本生成请求（记忆压缩、贴纸整包简介）。模型、采样温度与 token 上限都不
 * 由调用方指定：那三样因供应商而异，选什么值是实现包自己的事（见各包 consts）。
 * 调用方只声明「这是哪条流水线」，以及产出该怎么清洗。
 */
export interface AiTextRequest {
  readonly purpose: AiTextPurpose;
  readonly systemPrompt: string;
  readonly userContent: string;
  /** 出现在错误日志里的调用名（英文）。 */
  readonly errorLabel: string;
  /** 清洗模型正文；返回空串表示这次产出不可用，允许业务层重采样。 */
  readonly normalize: (text: string) => string;
}

/** 视觉描述请求（群聊图片/贴纸/GIF 共用一条流水线）。模型与 token 上限同样
 *  由实现包自行决定。 */
export interface AiVisionRequest {
  /** 描述指令，同时充当系统提示词。 */
  readonly prompt: string;
  readonly image: VisionImage;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
}

/** 生图请求。 */
export interface AiImageRequest {
  readonly prompt: string;
  readonly aspectRatio: ImageGenerationAspectRatio;
  readonly referenceImage?: VisionImage;
  readonly signal?: AbortSignal;
}

/** 创建一轮回复会话所需的初始上下文。 */
export interface AiReplySessionParams {
  /** 有序的初始上下文区块，映射成同一个 user 轮次下的多段文本。 */
  readonly promptBlocks: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * 一家供应商对 AI 闲聊全部模型能力的实现。
 *
 * 选取**按能力分成两路**，见 aiChat/provider.ts：生图走 imageAiProvider()、
 * 回复会话与纯文本/视觉走 chatAiProvider()，各自读各自的覆盖值
 * （`/image_model`、`/chat_model`）。都没设过时才落回 activeAiProvider() 的默认
 * 口径——默认 Gemini，缺 Gemini 凭据时降级到 OpenAI。
 *
 * 因此「当前用哪家」不是一个单值：两路可以分属两家，两家的客户端也会在同一条
 * Worker 线程上同时存在（见 cache/workers/aiChat/{gemini,openai}.ts）。
 */
export interface AiChatProvider {
  /** 供应商标识；用于日志诊断，也是生图覆盖值与实现包的对照键。 */
  readonly name: AiProviderName;
  createReplySession(params: AiReplySessionParams): AiReplySession;
  generateText(request: AiTextRequest): Promise<AiTextResult>;
  describeVision(request: AiVisionRequest): Promise<AiTextResult>;
  generateImage(request: AiImageRequest): Promise<GeneratedChatImage | null>;
}
