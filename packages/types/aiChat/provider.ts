/**
 * AI 闲聊的供应商中立契约。回复往返、纯文本生成、视觉描述与生图由本文件定义
 * 实现形状，具体收发在 aiChat/<vendor>/ 实现包里落地。部署层只要求 text、summary、
 * media；image/song 缺配置时不挂对应工具。语音转写是否可用由实现与首次请求探测。
 *
 * 领域侧（工具编排、记忆压缩、贴纸目录、生图工具）只认这里的类型，不再
 * import 任何供应商 SDK 的类型——换供应商时编译期就能确认哪些调用点没接上。
 * 跨模块约束见 docs/cn/04-invariants.md。
 *
 * **可选能力一律用「这个成员在不在」表达，不用供应商名字判断。** 领域侧写
 * `provider.generateSong === undefined` 而不是 `provider.name !== "google"`：后者
 * 会让每个调用点都记住一份「谁支持什么」的名单，再有第三家或某家补齐能力时，
 * 漏改的那处只会在运行期表现成一个不该出现的工具。
 */

import type { GeneratedChatImage, ImageGenerationAspectRatio } from "./imageGeneration";
import type { GeneratedChatSong } from "./songGeneration";
import type { VisionImage, VoiceClip } from "../media";
import type { AgentProvider } from "../config";

/** AI 配额闸门的两档任务优先级。 */
export type AiProviderTaskPriority = "interactive" | "background";

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
 * 一次媒体请求失败对**整条模态**的归因。
 *
 * 只有能对「这个 media 端点还能不能处理这种输入」下结论的失败才带上它；单份
 * 媒体自己的问题（下载不到、格式不合、正文被安全策略清空）一律不带，媒体探测
 * 状态机据此把「这一份不行」与「这一类都不行」分开，见
 * cache/workers/aiChat/mediaInputSupport.ts。
 */
export type MediaInputFailure =
  /** 供应商明确说明这种输入模态不受支持；本 Worker 生命周期内不再尝试。 */
  | "unsupported"
  /** 模型不存在、端点路径错误等确定性配置问题；停止重复请求并记一次诊断。 */
  | "misconfigured"
  /** 超时、429、5xx 等瞬时故障；模态保持未知，按退避重新探测。 */
  | "transient";

/**
 * 单次文本生成的业务结果。供应商 SDK 已耗尽 HTTP 重试时 retryable=false，
 * 防止调用方再套一层完整请求重试；HTTP 成功但正文不可用时才允许业务层重采样。
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
 * `unsupported` 与 `misconfigured` 都是终局——都不再下载、不再请求——但必须分开
 * 记：前者是「这个模型就没有这项能力」，后者是「模型名或 base_url 写错了」。
 * 合并成一个值会让一次部署笔误在日志里长得和模型能力缺失一模一样。
 */
export type MediaInputSupport = "unknown" | "supported" | "unsupported" | "misconfigured";

/**
 * 一种模态的完整探测状态；字段在构造时一次写全，运行期只整体替换，不增删。
 */
export interface MediaInputModalityState {
  readonly support: MediaInputSupport;
  /**
   * 连续瞬时失败次数，封顶 MEDIA_PROBE_MAX_TRANSIENT_FAILURES；成功或落定终局
   * 结论时清零。只有 `transient` 计数——单份坏媒体不得把整条模态推进退避。
   */
  readonly transientFailures: number;
  /**
   * 下一次允许发起真实探测的绝对时刻（Date.now() 口径）；0 表示不在退避中。
   * 墙钟回拨会让它落在过远的未来，读取侧按 MEDIA_PROBE_BACKOFF_MAX_MS 识别并
   * 立即放行（同 auto/message/triggerPolicy.ts 的冷却口径）。
   */
  readonly nextProbeAt: number;
}

/** media 模型的模态支持表；两项固定初始化，避免运行期改变对象 shape。 */
export interface MediaInputSupportState {
  readonly vision: MediaInputModalityState;
  readonly voice: MediaInputModalityState;
}

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
 * 生歌请求。
 *
 * 没有画幅/时长这类参数：Lyria 的曲长由 prompt 自己表达，实现包不再另外造一套
 * 可调档位去猜（见 aiChat/gemini/song.ts）。
 */
export interface AiSongRequest {
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

/** 创建一轮回复会话所需的初始上下文。 */
export interface AiReplySessionParams {
  /** 有序的初始上下文区块，映射成同一个 user 轮次下的多段文本。 */
  readonly promptBlocks: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * 五项能力各自的最小契约。
 *
 * 拆开的理由是**编译期边界**：config/agent.json 按能力独立选 provider，一次
 * summary 路由拿到的实现只应该被用来生成摘要。若各处都拿着完整的
 * AiChatProvider，「从 summary 那一家去读图」或「拿 media 那一家开回复会话」在
 * 类型上完全合法，只有运行期才会表现成用错了模型和端点——而那正是本项目刻意
 * 拒绝的静默漂移（见 aiChat/provider.ts 模块头注）。
 *
 * `name` 每项都有：日志诊断要能说清是哪一家，与能力无关。
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
   * **不得为此临时换一家**——那正是 aiChat/provider.ts 模块头注拒绝的静默漂移。
   *
   * 显式声明 `this: void`：可选成员必须先取出来判空再调用，而带隐式 this 的方法
   * 签名一旦被取成变量就丢了接收者。实现包给的本来就是自由函数，这里把这件事
   * 写进类型，顺带让「取出来再调」成为合法写法（generateSong 同理）。
   */
  transcribeVoice?(this: void, request: AiVoiceRequest): Promise<AiTextResult>;
}

/** 生图能力；能力缺配置时由路由返回 null，不挂 generate_image。 */
export interface AiImageProvider {
  readonly name: AgentProvider;
  generateImage(request: AiImageRequest): Promise<GeneratedChatImage | null>;
}

/** 生歌能力。 */
export interface AiSongProvider {
  readonly name: AgentProvider;
  /**
   * 生歌。缺席表示这一家没有这项能力，回复工具集直接不挂 generate_song
   * （见 aiChat/ai/tools/replyToolset/orchestrator.ts）——模型看不到的工具不会
   * 被调用，因此这里不需要再有一条运行期的「不支持」错误路径。
   */
  generateSong?(this: void, request: AiSongRequest): Promise<GeneratedChatSong | null>;
}

/**
 * 一家供应商对 AI 闲聊全部模型能力的实现；实现包导出的就是这一个对象。
 *
 * 选取按 text、summary、media、image、song 五项能力拆分，见 aiChat/provider.ts：
 * 路由持有完整实现，交给调用方的却只有上面对应的那一份最小契约。每项只读取
 * config/agent.json 中自己的 provider；不存在凭据回退或运行时覆盖。因此两家
 * 客户端可以在同一条 Worker 线程上同时存在，并按能力持有各自实例
 * （见 cache/workers/aiChat/{gemini,openai}.ts）。
 */
export interface AiChatProvider extends
  AiTextProvider,
  AiSummaryProvider,
  AiMediaProvider,
  AiImageProvider,
  AiSongProvider {}
