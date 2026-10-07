/**
 * AI 闲聊的供应商中立契约。回复往返、纯文本生成、视觉描述与生图由本文件定义
 * 实现形状，具体收发在 aiChat/<vendor>/ 实现包里落地。部署层只要求 text、summary、
 * media；image/tts 缺配置时不挂对应工具。语音转写是否可用由实现与首次请求探测。
 *
 * 领域侧（工具编排、记忆压缩、贴纸目录、生图工具）只认这里的类型，不 import
 * 供应商 SDK 的类型。跨模块约束见 docs/cn/04-invariants.md。
 *
 * 可选能力一律用「这个成员在不在」表达，不用供应商名字判断：领域侧写
 * `provider.synthesizeSpeech === undefined`，不写 `provider.name !== "google"`。
 */

import type { GeneratedChatImage, ImageGenerationAspectRatio } from "./imageGeneration";
import type { SpeechSynthesisAttempt, SynthesizedSpeech, TtsQuotaScope } from "./voiceMessage";
import type { VisionImage, VoiceClip } from "../media";
import type { AgentProvider } from "../config";

/** AI 配额闸门的两档任务优先级。 */
export type AiProviderTaskPriority = "interactive" | "background";

/**
 * 一个自定义函数工具的中立声明。参数用 JSON Schema 表达，Gemini 的
 * `parametersJsonSchema` 与 OpenAI 的 `parameters` 都直接使用这份对象。
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
 * 一次媒体请求失败对整条模态的归因。
 *
 * 只有能对「这个 media 端点还能不能处理这种输入」下结论的失败才带上它；单份
 * 媒体自己的问题（下载不到、格式不合、正文被安全策略清空）一律不带，媒体探测
 * 状态机据此区分「这一份不行」与「这一类都不行」，见
 * cache/workers/aiChat/mediaInputSupport.ts。
 */
export type MediaInputFailure =
  /** 供应商明确拒绝这种输入模态；阻止新请求，同配置代次的在途成功可恢复支持结论。 */
  | "unsupported"
  /** 模型不存在、端点路径错误等确定性配置问题；停止重复请求并记一次诊断。 */
  | "misconfigured"
  /** 超时、429、5xx 等瞬时故障；模态保持未知，按退避重新探测。 */
  | "transient";

/**
 * 单次文本生成的业务结果。供应商 SDK 已耗尽 HTTP 重试时 retryable=false；
 * HTTP 成功但正文不可用时才允许业务层重采样。
 */
export type AiTextResult =
  | { readonly ok: true; readonly text: string }
  | {
    readonly ok: false;
    readonly retryable: boolean;
    /**
     * 这次失败对整条媒体模态的结论；缺席表示「只是这一次/这一份不行」，不改变
     * 模态状态。非媒体流水线（摘要、贴纸整包简介）恒为缺席。
     */
    readonly mediaFailure?: MediaInputFailure;
  };

/** media 模型两种独立探测的输入模态。 */
export type MediaInputCapability = "vision" | "voice";

/**
 * 一种媒体输入在本 Worker 生命周期内的探测结论。
 *
 * `unsupported` 与 `misconfigured` 都阻止新下载与请求；同配置代次的在途成功可恢复。
 * 前者表示模型没有这项能力，后者表示模型名或 base_url 配置有误。
 */
export type MediaInputSupport = "unknown" | "supported" | "unsupported" | "misconfigured";

/** 一轮回复请求里随轮次变化的工具配置与采样语义。 */
export interface AiReplyTurnRequest {
  /**
   * 系统提示词。只含逐字恒定的段落（人设 + 固定指令）；当前时间、心情这类运行时
   * 状态走 AiReplySessionParams.volatileBlocks 进 user 内容。
   */
  readonly systemPrompt: string;
  /** 本轮挂载的自定义函数声明；同一回复内逐字恒定，预算与可用性只在执行侧兑现（见 workers/aiChat/replyModel.ts 头注）。 */
  readonly functions: readonly AiToolDefinition[];
  /** 本轮是否挂载供应商的服务端联网检索工具。 */
  readonly webSearchEnabled: boolean;
  /**
   * 本轮之前是否已经观测到服务端检索。采样参数不由调用方传入，由各实现包按自己的
   * consts 决定，见 consts/aiChat/{gemini,openai}.ts。
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
   * 没有对等信号的供应商恒为 false；上层据此决定是否关掉检索重试一次，
   * false 表示不触发那次额外重试。
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

/** 纯文本生成的两条流水线；输出 token 上限由各实现包按自己的 consts 分别给值。 */
export type AiTextPurpose = "chatSummary" | "stickerPackSummary";

/**
 * 纯文本生成请求（记忆压缩、贴纸整包简介）。模型、采样温度与 token 上限不由
 * 调用方指定，由实现包按各包 consts 决定。调用方只声明所属流水线与产出清洗方式。
 */
export interface AiTextRequest {
  readonly purpose: AiTextPurpose;
  readonly systemPrompt: string;
  readonly userContent: string;
  /** 终止排队、供应商请求与业务重采样。 */
  readonly signal?: AbortSignal;
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
  /** 终止下载后的供应商请求与等待中的媒体任务。 */
  readonly signal?: AbortSignal;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
}

/**
 * 语音转写请求（群里的 Telegram voice note）。模型与 token 上限同样由实现包自行
 * 决定；调用方只给音频字节、指令与清洗方式，与 AiVisionRequest 同一口径。
 */
export interface AiVoiceRequest {
  /** 转写指令，同时充当系统提示词。 */
  readonly prompt: string;
  readonly clip: VoiceClip;
  /** 终止下载后的供应商请求与等待中的媒体任务。 */
  readonly signal?: AbortSignal;
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

/**
 * 语音合成请求：一句要念出来的台词，以及可选的朗读语言要求与本句说话语气。音色与基础朗读风格
 * 来自部署配置 `agent.tts`，languageStyle 与 tone 依次追加在基础风格之后只作用于这一句（见
 * aiChat/ai/utils/speechStyle.ts）；没有风格指令字段的线协议（xai）两者都不发送。
 */
export interface AiSpeechRequest {
  readonly text: string;
  /** 按 `agent.tts.bot_language` 取的朗读语言要求；只有 AI 回复的 send_voice 带，`/send` 与 cron 不带。 */
  readonly languageStyle?: string;
  readonly tone?: string;
  readonly signal?: AbortSignal;
}

/** 一次联网检索请求（web_search 能力的执行器）。 */
export interface AiWebSearchRequest {
  /** 系统提示词：要求模型先检索、再按调用方的口径写结论。 */
  readonly instruction: string;
  /** 检索问题；工具与 cron 会在问题后附上本次配置时区基准时间。 */
  readonly query: string;
  readonly signal?: AbortSignal;
}

/** 检索结果引用的一条来源。 */
export interface AiWebSearchSource {
  readonly title: string;
  /** 供应商交回的来源地址，原样保留。 */
  readonly url: string;
}

/**
 * 一次联网检索的结果。`searchCalls` 是供应商在这次请求里实际执行的检索次数，两种结果都带：
 * 请求成功但一次都没检索（端点忽略了检索工具）时 ok 仍为 true、searchCalls 为 0，由调用方
 * 按调用场景决定是否放行。ok=false 表示请求失败、超时、被取消或正文不可用（已记日志）。
 */
export type AiWebSearchResult =
  | {
    readonly ok: true;
    /** 模型据检索结果写出的结论正文，未裁剪。 */
    readonly text: string;
    /** 供应商交回的来源，按出现顺序，未去重、未裁剪。 */
    readonly sources: readonly AiWebSearchSource[];
    readonly searchCalls: number;
  }
  | { readonly ok: false; readonly searchCalls: number };

/**
 * 经 tts 门面发起的语音合成请求：在供应商请求之外带上本调用方的额度口径。
 * AI 语音工具传 `ai`：每日计数由调用方在工具调用时预留（超限当场回给模型）、TTS 调用成功时
 * 登记（见 aiChat/ai/ttsUsage.ts），门面不再登记。主线程转交的 `/send` 与 cron 传 `operator`：
 * 由门面在发起供应商请求前登记。
 */
export interface AiMeteredSpeechRequest extends AiSpeechRequest {
  readonly quota: TtsQuotaScope;
}

/**
 * 创建一轮回复会话所需的初始上下文。
 *
 * 区块按「跨轮回复是否逐字不变」分成稳定组与易变组。两组都进请求的 user 内容，按
 * stable→volatile 的顺序；稳定组连同系统提示词与工具声明构成同一个群反复重发的前缀，
 * 供各家前缀缓存使用：Gemini 的隐式缓存、OpenAI 的 Responses 前缀缓存与 Anthropic
 * 在最后一个稳定区块打的缓存断点。Anthropic 只在区块边界命中，另按
 * conversationSettledOffsets 把当前会话切开。
 */
export interface AiReplySessionParams {
  /**
   * 跨轮回复逐字不变的区块（当前是只读参考记忆），内容只在冷记忆压缩轮换或机器人
   * 账号身份变化时改变；排在易变组之前。
   */
  readonly stableBlocks: readonly string[];
  /**
   * 每轮回复都会变的区块（当前是群聊转录、本轮运行时状态与回复任务），不得混进稳定组。
   */
  readonly volatileBlocks: readonly string[];
  /**
   * volatileBlocks[0]（当前会话）内的转录已定切点（UTF-16 下标，升序，均落在区块内部），
   * 见 ReplyPromptSections.currentConversationSettledOffsets。只有在区块边界命中缓存的实现
   * （Anthropic）据此把该区块切成多个文本块，其余实现不读，请求内容不变。缺省按没有切点处理。
   */
  readonly conversationSettledOffsets?: readonly number[];
  readonly signal?: AbortSignal;
}

/**
 * 各项能力的最小契约，按编译期边界拆开：config/dynamic/agent.json 按能力独立选
 * provider，调用方只拿到自己能力对应的那一份契约（见 aiChat/provider.ts 模块头注）。
 *
 * `name` 每项都有，用于日志诊断。
 */

/** 带工具往返的群聊正文能力。 */
export interface AiTextProvider {
  /** 供应商协议标识，用于配置路由与日志诊断。 */
  readonly name: AgentProvider;
  createReplySession(params: AiReplySessionParams): AiReplySession;
}

/** 记忆压缩与贴纸整包简介共用的无状态摘要能力。 */
export interface AiSummaryProvider {
  readonly name: AgentProvider;
  generateText(request: AiTextRequest): Promise<AiTextResult>;
}

/** 视觉描述与语音转写能力。 */
export interface AiMediaProvider {
  readonly name: AgentProvider;
  describeVision(request: AiVisionRequest): Promise<AiTextResult>;
  /**
   * 语音转写。缺席表示这一家没有这项能力，调用方按「这条语音解析不出来」降级
   * （转录里留兜底占位，见 workers/aiChat/mediaText.ts 的 fallbackTextFor），
   * 不换用其他供应商。
   *
   * 声明 `this: void`：实现包给出的是自由函数，可选成员取出并判空后可直接调用
   * （synthesizeSpeech 同理）。
   */
  transcribeVoice?(this: void, request: AiVoiceRequest): Promise<AiTextResult>;
}

/**
 * 执行一次带内建检索的单轮请求的能力：`web_search` 用部署字段 `web_search` 的模型（回复的
 * `web_search` 工具与 cron 摘要），`text` 用对话模型（没配 web_search 时 cron 摘要的检索）。
 */
export type AiWebSearchCapability = "web_search" | "text";

/** 联网检索执行器：实现包交出的供应商契约，按调用方指定的能力取模型、凭据与端点。 */
export interface AiWebSearchProvider {
  readonly name: AgentProvider;
  searchWeb(capability: AiWebSearchCapability, request: AiWebSearchRequest): Promise<AiWebSearchResult>;
}

/**
 * 联网检索门面（aiChat/provider.ts 的 webSearchAiProvider / textWebSearchAiProvider）：能力已经
 * 绑定，请求经配额闸门排队。web_search 缺配置时 webSearchAiProvider 返回 null。
 */
export interface AiWebSearchFacade {
  readonly name: AgentProvider;
  searchWeb(request: AiWebSearchRequest): Promise<AiWebSearchResult>;
}

/**
 * 结构化 JSON 生成请求（text 能力，不挂工具，cron 摘要组稿用）。实现包按自己的协议要求端点
 * 只输出 JSON：OpenAI 兼容端点用 `json_object`（提示词里须出现 JSON 一词，Schema 由调用方
 * 写进提示词），Gemini 把 jsonSchema 交给 `responseJsonSchema`，Anthropic 交给
 * `output_config.format`。不使用 Gemini 显式缓存。
 */
export interface AiJsonRequest {
  readonly systemPrompt: string;
  readonly userContent: string;
  /** 期望输出的 JSON Schema；OpenAI 兼容端点不读取；解码与校验由调用方负责。 */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /** 出现在错误日志里的调用名（英文）。 */
  readonly errorLabel: string;
}

/** text 能力的结构化 JSON 生成；返回的是未解析的正文。 */
export interface AiStructuredTextProvider {
  readonly name: AgentProvider;
  generateJson(request: AiJsonRequest): Promise<AiTextResult>;
}

/**
 * 生图门面（aiChat/provider.ts 的 imageAiProvider）；能力缺配置或所选实现缺席生图时由路由返回 null，
 * 不挂 generate_image。
 */
export interface AiImageProvider {
  readonly name: AgentProvider;
  generateImage(request: AiImageRequest): Promise<GeneratedChatImage | null>;
}

/** 生图能力：实现包交出的供应商契约。 */
export interface AiImageGenerationProvider {
  readonly name: AgentProvider;
  /**
   * 生图。缺席表示这一家没有这项能力；配置解析已拒绝把 image 路由给缺席的一家
   * （见 config/agentCapability.ts），路由按缺席返回 null。
   */
  generateImage?(this: void, request: AiImageRequest): Promise<GeneratedChatImage | null>;
}

/** 语音合成能力：实现包交出的供应商契约。 */
export interface AiSpeechProvider {
  readonly name: AgentProvider;
  /**
   * 语音合成。缺席表示这一家没有这项能力，回复工具集直接不挂 send_voice
   * （见 aiChat/ai/tools/replyToolset/orchestrator.ts）。
   */
  synthesizeSpeech?(this: void, request: AiSpeechRequest): Promise<SynthesizedSpeech | null>;
}

/**
 * tts 门面（aiChat/provider.ts 的 ttsAiProvider）：请求经交互优先的配额闸门排队，
 * 轮到执行时先按 `quota` 口径登记每日计数，超出上限时不发起供应商请求。
 */
export interface AiSpeechFacade {
  readonly name: AgentProvider;
  /** 缺席语义同 AiSpeechProvider.synthesizeSpeech。 */
  synthesizeSpeech?(this: void, request: AiMeteredSpeechRequest): Promise<SpeechSynthesisAttempt>;
}

/**
 * 一家供应商对 AI 闲聊全部模型能力的实现；实现包导出的就是这一个对象。
 *
 * 选取按 text、summary、media、image、tts、web_search 能力拆分，见 aiChat/provider.ts：
 * 路由持有完整实现，交给调用方的只有上面对应的那一份最小契约。每项只读取
 * config/dynamic/agent.json 中自己的 provider，各家客户端可以在同一条 Worker 线程上
 * 同时存在，并按能力持有各自实例（见 cache/workers/aiChat/{gemini,openai,anthropic}.ts）。
 */
export interface AiChatProvider extends
  AiTextProvider,
  AiSummaryProvider,
  AiMediaProvider,
  AiImageGenerationProvider,
  AiSpeechProvider,
  AiWebSearchProvider,
  AiStructuredTextProvider {}
