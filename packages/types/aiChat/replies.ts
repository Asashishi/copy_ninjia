import type { AiToolDefinition } from "./provider";
import type { ChatActionControl, ChatActionPhase } from "./chatAction";
import type { AiDirectTriggerReason, ImageGenerationReference } from "./protocol";
import type { BotImageOrigin, BufferedReplyReference } from "./memory";
import type { MediaKind, TelegramVisionSource } from "../media";
import type { LinkedQueue } from "../../libs/linkedQueue";

/** 同群并发位占满时排队补跑的直接触发快照。 */
export interface QueuedReplyTrigger {
  triggerSenderId: number;
  replyToMessageId: number;
  /** 入队时 Telegram 发送面处于高压；该项补跑时同群最多只开一轮。 */
  telegramBackpressured: boolean;
  /** 触发消息自身的单跳快照；排队期间即使它滑出热区，机器人发送后的
   * 自录仍可保留 Telegram 实际建立的回复关系。 */
  triggerReference?: BufferedReplyReference;
  replyTo?: BufferedReplyReference;
  /** 当前触发消息是转发时的来源；排队期间即使原转录滑出也保留归属。 */
  forwardedFrom?: string;
  /** 是否允许模型根据本轮直接触发内容决定调用图片工具。 */
  imageGenerationRequested: boolean;
  imageGenerationReference?: ImageGenerationReference;
  /**
   * 触发时刻的本群问答快照；与 triggerReference 同理在入队时捕获，补跑沿用这份清单。
   * 载荷有界，每群至多 CHAT_QA_MAX_PER_CHAT 条。
   */
  chatQa?: ReadonlyMap<string, string>;
  /** 触发消息所在的论坛话题；补跑时这一轮仍然回到当初那个话题。 */
  messageThreadId: number | undefined;
  senderName: string;
  text: string;
  /** 入站媒体解析结果；占位期间保留顺位，出队后先等解析再构造提示词。 */
  mediaPreparation?: Promise<MediaCommentContext | null>;
}

/** 一轮回复交给模型的有序初始上下文区块。各区块恒定出现——触发类型只改变
 * replyTask 的内容（直接触发时它开头多一句唤起者声明），本接口没有可选字段。
 *
 * 模型实际收到的「本轮运行时状态」（心情、当前时间与本轮工具状态）不在本接口内，
 * 由 workers/aiChat/runtimeState.ts 在 replyModel 里补在转录与回复任务之间。区块保持
 * 领域语义，直到各供应商实现包的 replySession.ts 边界，才按稳定/易变两组映射成同一个
 * user 轮次下的多段文本（见 types/aiChat/provider.ts 的 AiReplySessionParams）。 */
export interface ReplyPromptSections {
  readonly referenceMemory: string;
  readonly currentConversation: string;
  /**
   * currentConversation 内的转录已定切点（UTF-16 下标，升序），即
   * RenderedTranscript.settledOffsets 平移区块开头标签与段首标注之后的位置。
   */
  readonly currentConversationSettledOffsets: readonly number[];
  readonly replyTask: string;
}

/** 一轮 AI 回复行动工具所需的外部上下文。 */
export interface ReplyToolContext {
  chatId: number;
  replyToMessageId: number;
  /**
   * 本轮全部发送要落进的论坛话题；General、非论坛群与讨论组评论为 undefined。
   * 文字、贴纸、生图、语音与「正在输入…」共用这一个话题（见 libs/forumTopic.ts）。
   */
  messageThreadId: number | undefined;
  /** 本群已登记问答；为空或缺省时问答执行器返回空清单，本轮工具状态写明没有登记。 */
  chatQa?: ReadonlyMap<string, string>;
  /**
   * 重媒体工具（generate_image）的直接触发资格。工具只按部署能力恒挂；为 false 时
   * 本轮工具状态写明不可用，执行器在调用时直接拒绝。具体意图由模型按当前消息自行判断。
   *
   * 资格由 workers/aiChat/replyRound.ts 的 mediaToolsAllowed 计算。协议层
   * `imageGenerationRequested` 记录入口是否允许图片工具，轮次开始时再与随机触发
   * 和媒体直接触发状态合并。
   */
  mediaToolsRequested: boolean;
  imageGenerationReference?: ImageGenerationReference;
  /** superAdmin 触发：跳过生图的群共享冷却。 */
  bypassMediaToolCooldown: boolean;
  /**
   * 本轮聊天状态心跳句柄（见 aiChat/ai/chatActionHeartbeat.ts）。动作的挡位只由串行动作链按工具
   * 调用顺序切换（见 aiChat/ai/tools/replyToolset/actionChains.ts）；直接轮另由工具集在链空闲时
   * 亮请求期间的挡位：还没接纳过动作的请求亮「正在输入」、挑贴纸的请求亮「正在选择贴纸」（见
   * replyToolset/pacing.ts 与 replyToolset/orchestrator.ts）。
   */
  chatAction: ChatActionControl;
  /**
   * 本轮是直接轮（群里没有在途轮次时启动，见 workers/aiChat/replyDelivery.ts）：串行链不设闸，动作
   * 按直接轮节奏停顿（见 replyToolset/pacing.ts）；为 false 时是有序并行轮。两种轮次的动作都在
   * 接纳时回接纳回执，由串行链执行。
   */
  direct: boolean;
  roundHasTypo: boolean;
  isActive: () => boolean;
  /** 本轮 generation 的取消信号；模型、等待和 Telegram 调用必须沿用。 */
  signal?: AbortSignal;
  /** repliedToMessageId 是这次发送实际挂上的回复目标（send_message 由模型的
   *  reply_to_trigger 决定、图片请求固定指向触发消息）；Telegram 因目标已删除
   *  而退化为普通发送时省略。供 Worker 自录记忆时带上「回复了谁」，让机器
   *  人自己的发言同样保留上下文中的回复关系。 */
  onMessageSent: (text: string, messageId: number, repliedToMessageId?: number) => void;
  onStickerSent: (stickerDescription: string, messageId: number) => void;
  /** 生图落地后自录并开始识图，见 workers/aiChat/botImages.ts 的 trackGeneratedImage。 */
  onImageSent: (image: SentGeneratedImage) => void;
  /** 语音落地后自录；与 onMessageSent 同构，只采信服务端实际返回的回复关系。 */
  onVoiceSent: (voiceDescription: string, messageId: number, repliedToMessageId?: number) => void;
}

/** 生图落地后交给 Worker 自录的事实。 */
export interface SentGeneratedImage {
  /** 占位态正文：生图记号（带提示词）接图注。 */
  text: string;
  messageId: number;
  /** Telegram 实际建立的回复目标；没有挂上回复时为 undefined。 */
  repliedToMessageId: number | undefined;
  origin: Exclude<BotImageOrigin, "command">;
  /** 随图发出的图注；没有图注为空串。 */
  caption: string;
  /** Telegram 为这张图返回的视觉源，供识图下载。 */
  photo: TelegramVisionSource;
}

/** 一次 web_search 函数工具调用的结果（aiChat/ai/tools/webSearch.ts）。 */
export interface WebSearchToolOutcome {
  /** 交回模型的工具结果 JSON。 */
  readonly result: string;
  /** 这次调用里供应商实际执行的检索次数；失败时同样如实给出。 */
  readonly searchCalls: number;
}

/** 一轮回复的 web_search 执行器；入参是模型给出的原始参数 JSON。 */
export type WebSearchToolExecutor = (argumentsJson: string) => Promise<WebSearchToolOutcome>;

/** 一轮 AI 回复的函数工具集与执行状态。 */
export interface ReplyToolset {
  /** 本轮全部自定义函数声明（静态查询工具 + 行动工具）。中立 JSON Schema 表达，
   *  各供应商实现包各自转成自家形状；同一部署同一人设下每轮逐字相同。 */
  readonly functions: readonly AiToolDefinition[];
  /** 本轮工具状态段（含段首标签），拼进运行时状态区块（见
   *  aiChat/ai/tools/replyToolset/toolStatus.ts）。按轮变化的可用性（直接触发资格、
   *  群冷却、参考素材、语音余量、问答条数）只写在这里，不进工具声明。 */
  readonly toolStatus: string;
  /** 本轮是否挂载 text 模型的服务端联网检索工具（Gemini 的 googleSearch /
   *  OpenAI 的 hosted web_search）；配置了 web_search 能力时恒为 false。 */
  readonly webSearch: boolean;
  /**
   * 配置了 web_search 能力时的本地 `web_search` 函数工具执行器（声明已在 functions 里）；
   * 没配时为 null。它是唯一异步执行的工具，由 workers/aiChat/replyModel.ts 单独分发，
   * 不经 has / execute。
   */
  readonly searchWeb: WebSearchToolExecutor | null;
  /**
   * 系统提示词「行动与停止」段：组装工具时按 `agent.tts.bot_language` 从 VOICE_LANGUAGE_PROMPTS 取的
   * 同一份文案，与 functions 里 send_message、send_voice 的声明语言一致（见 replyToolset/orchestrator.ts）。
   */
  readonly replyActionInstruction: string;
  readonly has: (name: string) => boolean;
  /**
   * 每次请求模型前调用：直接轮在还没接纳过动作时亮「正在输入」，刚看过贴纸包时亮「正在选择贴纸」，
   * 其余请求不亮，串行链忙时等排空再亮；有序并行轮不切挡（见 replyToolset/orchestrator.ts）。
   */
  readonly beforeModelRequest: () => void;
  /**
   * 模型阶段结束时调用：直接轮收回请求期间亮着、还没被动作接走的状态；有序并行轮不切挡
   * （见 replyToolset/orchestrator.ts）。
   */
  readonly afterModel: () => void;
  /**
   * 按模型的调用顺序同步完成校验与接纳，当场返回回执；接纳的动作交串行链执行，查看与查询
   * 返回真实数据（见 replyToolset/orchestrator.ts）。
   */
  readonly execute: (name: string, argumentsJson: string) => string;
  /** 已接纳动作的预占额度；失败或取消不退回给模型重复提交。 */
  readonly actionsUsed: () => number;
  /** 等串行链上与转入后台的动作及其发送回调全部结算；调用前须结束模型工具派发。 */
  readonly settle: () => Promise<void>;
  /** 实际成功落地的动作数，不含乐观接纳或失败的调用。 */
  readonly actionsCompleted: () => number;
  readonly isActive: () => boolean;
  /** 与 ReplyToolContext 相同的 generation 取消信号。 */
  readonly signal?: AbortSignal;
}

/**
 * 动作执行中的拟人停顿：亮 phase 挡并等 delayMs（心跳还在静默期时顺延剩余静默）；本轮作废时返回
 * 交给调用方结算的工具错误，走完返回 null。有序并行轮每个动作都停顿，直接轮只有「正在输入」请求
 * 交回的第一条文字不停顿（见 replyToolset/pacing.ts）。
 */
export type ReplyActionPause = (phase: ChatActionPhase, delayMs: number) => Promise<string | null>;

/**
 * 直接轮的动作节奏：串行链空闲时按调用方给的挡位亮请求期间的状态，链忙时让链上的步骤掌管；
 * 「正在输入」请求交回的第一个动作是文字时沿用请求期间亮着的挡位、不停顿，其余动作照常停顿。
 */
export interface DirectReplyPacing {
  /** 请求模型前调用：链空闲时亮 phase 挡，idle 表示这次请求不亮状态（并收回上一次请求亮着的挡位）。 */
  readonly beforeModelRequest: (phase: ChatActionPhase) => void;
  /**
   * 动作被接纳、排进串行链时按工具调用顺序调用：接走请求亮着的挡位，返回这个动作用的拟人停顿。
   * text 表示动作是文字（send_message）；「正在输入」请求交回的第一个动作是文字时，它的第一次停顿
   * 只切挡。
   */
  readonly startAction: (text: boolean) => ReplyActionPause;
  /** 串行链由空闲转为有步骤时调用：此后状态由链上的步骤掌管。 */
  readonly chainStarted: () => void;
  /** 串行链排空时调用：仍在进行的请求要亮挡位时亮起。 */
  readonly chainDrained: () => void;
  /** 模型阶段结束后调用：请求亮着、还没被动作接走的挡位收回。 */
  readonly endModel: () => void;
}

/** 一步动作的执行函数：参数是本轮心跳句柄与本轮节奏的拟人停顿，返回实际执行结果。 */
export type ReplyActionRun = (chatAction: ChatActionControl, pause: ReplyActionPause) => Promise<string>;

/** 行动工具校验后交给串行动作链的动作；result 是接纳回执，run 返回实际执行结果。 */
export interface PreparedReplyAction {
  readonly result: string;
  readonly run: ReplyActionRun;
}

/**
 * 本轮唯一的串行动作链：已接纳动作按工具调用顺序排队执行，动作的聊天状态只由链上正在执行的
 * 那一步切换；转入后台的动作结算后排到链尾（见 aiChat/ai/tools/replyToolset/actionChains.ts）。
 */
export interface ReplyActionChains {
  /**
   * 按调用顺序排入一个已接纳动作（直接轮在此时向节奏领这一步的停顿）；这一步结束后状态切回 idle。
   */
  readonly start: (name: string, run: ReplyActionRun) => void;
  /**
   * 登记转入后台、不占链的动作：pending 结算出执行函数时排到链尾，结算为 null 时不投递。
   * settle 连同它排入的步骤一起等待。
   */
  readonly defer: (name: string, pending: Promise<ReplyActionRun | null>) => void;
  /** 等链上与后台全部结算；调用前须结束模型工具派发。 */
  readonly settle: () => Promise<void>;
  /** 链上步骤的真实落地数；步骤结果带 error 时记英文日志、不计数。 */
  readonly completed: () => number;
}

/** 字符串表示立即可用的查询结果或拒绝；PreparedReplyAction 表示已接纳、交串行链执行的动作。 */
export type ReplyToolExecution = string | PreparedReplyAction;

/**
 * 同群入站顺位句柄，动作等待 ready，收尾必须 await finish（等更早的轮全部回收后结算）。
 * - 直接轮（群里没有在途轮次时启动）：发送链队首，ready 当即放行；动作接纳后立即由串行链执行，边生成边发送。
 * - 有序并行轮：按入站顺位占位，commit 后且前面的轮（含直接轮）全部发完才放行 ready。
 */
export interface ReplyDeliveryTurn {
  /** 本轮是直接轮。 */
  readonly direct: boolean;
  readonly ready: Promise<void>;
  /**
   * 模型阶段结束（含提前返回与取消），可重复调用：有序并行轮标记完整动作链就绪；直接轮交还
   * 它独立占用的模型并发位。
   */
  readonly commit: () => void;
  readonly finish: () => Promise<void>;
}

/** 发送 FIFO 中的入站占位；完成项按顺位回收，不占模型并发位。 */
export interface ReplyDeliverySlot {
  readonly ready: PromiseWithResolvers<void>;
  readonly released: PromiseWithResolvers<void>;
  state: "pending" | "ready" | "done";
}

/**
 * 单群发送 FIFO；队首可能是本窗口的直接轮。存活轮次由跨代际容量计数约束。
 */
export interface ReplyDeliveryWindow {
  readonly queue: LinkedQueue<ReplyDeliverySlot>;
  /** 本窗口的直接轮仍在模型阶段；为 true 时有序并行轮之外另放行这一轮。 */
  directModelActive: boolean;
}

/** 一轮行动工具内的已接纳文本与错字占用状态。 */
export interface RoundMessageState {
  typoUsedThisRound: boolean;
  /**
   * 接纳时登记的正文及媒体附言的归一化形态（见 replyToolset/messageState.ts 的
   * acceptRoundText），容量受本轮动作硬顶约束，随轮次释放。
   */
  acceptedCanonicalTexts: Set<string>;
  /** 执行侧已接管的错字纠正单字的归一化形态。 */
  reservedCorrectionText: string | null;
}

/**
 * 评价触发的附加上下文：发送人显示名、解析出的描述与媒体类型。
 * kind 决定拼进提示词的措辞（见 consts/aiChat/prompts/replyTask.ts 的 mediaNounFor）。
 */
export interface MediaCommentContext {
  kind: MediaKind;
  senderId: number;
  senderName: string;
  description: string;
  /**
   * 当前媒体消息自身的快照；视觉解析或排队期间滑出热区后，发送自录仍可
   * 保留实际回复边。
   */
  triggerReference?: BufferedReplyReference;
  /** 当前媒体是转发时的来源；用于在特殊回复任务中明确来源到转发者的路径。 */
  forwardedFrom?: string;
  /** 已清洗的媒体转录整行（视觉描述 + caption），供排队快照保留原请求。 */
  triggerText?: string;
  /**
   * 用户是拿这份媒体明确在跟机器人说话（回复机器人，或 caption 里 @ 机器人）：
   * 回复指令改为必回语气，并发闸打满时按直接触发排队补跑而非丢弃。
   */
  directTriggerReason?: AiDirectTriggerReason;
  /** 排队时随触发快照保存；原转录条目滑出后仍保留回复对象。 */
  replyTo?: BufferedReplyReference;
}
