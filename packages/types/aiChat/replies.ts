import type { AiToolDefinition } from "./provider";
import type { StickerPackCandidate, StickerRoundState, StickerSendLockControl } from "../stickers/tools";
import type { ChatActionControl } from "./chatAction";
import type { AiDirectTriggerReason, ImageGenerationReference } from "./protocol";
import type { BufferedReplyReference } from "./memory";
import type { MediaKind } from "../media";

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
  senderName: string;
  text: string;
}

/** 一轮回复交给模型的有序初始上下文区块。直接 @/回复触发时，invokerFocus
 * 作为独立区块插在完整转录与回复任务之间；随机触发和随机媒体评价不携带。
 * 区块保持领域语义，直到各供应商实现包的 replySession.ts 边界，才映射成同一个
 * user 轮次下的多段文本。 */
export interface ReplyPromptSections {
  readonly referenceMemory: string;
  readonly currentConversation: string;
  readonly invokerFocus?: string;
  readonly replyTask: string;
}

/** 一轮 AI 回复行动工具所需的外部上下文。 */
export interface ReplyToolContext {
  chatId: number;
  replyToMessageId: number;
  /**
   * 重媒体工具（generate_image / generate_song）的执行侧直接触发资格，**不**代表
   * 生图或生歌的意图已由程序预判——意图由模型按当前消息自行判断。
   *
   * 两个工具共用同一个布尔而不是各带一个：它们的资格判据逐字相同（本轮触发是
   * 用户直接回复或 @ 了机器人，见 workers/aiChat/replyRound.ts 的
   * mediaToolsAllowed），拆成两份只会多出一处能各自漂移的状态。协议层那个
   * `imageGenerationRequested` 是另一回事，它记的是「这条消息带没带图片工具
   * 资格」这一原始事实，见 types/aiChat/protocol.ts。
   */
  mediaToolsRequested: boolean;
  imageGenerationReference?: ImageGenerationReference;
  /** superAdmin 触发：跳过重媒体工具的群共享冷却（生图与生歌各有各的冷却表）。 */
  bypassMediaToolCooldown: boolean;
  chatAction: ChatActionControl;
  stickerLock: StickerSendLockControl;
  roundHasTypo: boolean;
  isActive: () => boolean;
  /** 本轮 generation 的取消信号；模型、等待和 Telegram 调用必须沿用。 */
  signal?: AbortSignal;
  /** repliedToMessageId 是这次发送实际挂上的回复目标（send_message 由模型的
   *  reply_to_trigger 决定、图片请求固定指向触发消息）；Telegram 因目标已删除
   *  而退化为普通发送时省略。供 Worker 自录记忆时带上「回复了谁」，让机器
   *  人自己的发言也能被回复链回溯。 */
  onMessageSent: (text: string, messageId: number, repliedToMessageId?: number) => void;
  onStickerSent: (stickerDescription: string, messageId: number) => void;
  onImageSent: (imageDescription: string, messageId: number, repliedToMessageId?: number) => void;
  /** 与 onImageSent 同构：生歌落地后自录，同样只采信服务端实际返回的回复关系。 */
  onSongSent: (songDescription: string, messageId: number, repliedToMessageId?: number) => void;
}

/** 一轮 AI 回复的函数工具集与执行状态。 */
export interface ReplyToolset {
  /** 本轮全部自定义函数声明（静态查询工具 + 现组装的行动工具）。中立
   *  JSON Schema 表达，两家供应商实现包各自转成自家形状。 */
  functions: readonly AiToolDefinition[];
  /** 本轮是否挂载供应商的服务端联网检索工具（Gemini 的 googleSearch /
   *  OpenAI 的 hosted web_search）。 */
  webSearch: boolean;
  has(name: string): boolean;
  execute(name: string, argumentsJson: string): Promise<string>;
  actionsUsed(): number;
  isActive(): boolean;
  /** 与 ReplyToolContext 相同的 generation 取消信号。 */
  signal?: AbortSignal;
}

/** 一轮行动工具内的已发送消息与错字占用状态。 */
export interface RoundMessageState {
  messageCount: number;
  typoUsedThisRound: boolean;
  sentCanonicalTexts: Map<number, string>;
  /** 执行侧已接管的错字纠正单字；防止模型从工具结果自行补发。 */
  reservedCorrectionText: string | null;
}

/**
 * 评价触发的附加上下文：发送人显示名、解析出的描述与媒体类型。
 * kind 决定拼进提示词的措辞（“一张图片”/“一枚贴纸”/“一个 GIF”）。
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
  /** 排队时随触发快照保存，避免原转录条目滑出后丢失回复对象。 */
  replyTo?: BufferedReplyReference;
}

/** 让 replies.ts 对贴纸候选类型形成明确的领域依赖并可直接重导出。 */
export type { StickerPackCandidate, StickerRoundState };
