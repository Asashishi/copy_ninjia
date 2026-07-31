import type { Tool } from "@google/genai";
import type { ToolDefinition } from "../tools";
import type { StickerPackCandidate, StickerRoundState, StickerSendLockControl } from "../stickers/tools";
import type { ChatActionControl } from "./chatAction";
import type { AiDirectTriggerReason, ImageGenerationReference } from "./protocol";
import type { BufferedReplyReference } from "./memory";
import type { MediaKind } from "../media";

/** 同群并发位占满时排队补跑的直接触发快照。 */
export interface QueuedReplyTrigger {
  triggerSenderId: number;
  replyToMessageId: number;
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

/** 一轮回复交给 Gemini 的有序初始上下文区块。直接 @/回复触发时，
 * invokerFocus 作为独立 text Part 插在完整转录与回复任务之间；随机触发和
 * 随机媒体评价不携带。区块保持领域语义，直到 geminiReply.ts 的 SDK 边界
 * 才映射成同一个 user Content 下的 text Parts。 */
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
  /** 执行侧的直接触发资格，不代表图片意图已由程序预判。 */
  imageGenerationRequested: boolean;
  imageGenerationReference?: ImageGenerationReference;
  bypassImageGenerationCooldown: boolean;
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
}

/** 一轮 AI 回复的函数工具集与执行状态。 */
export interface ReplyToolset {
  definitions: ToolDefinition[];
  tools: Tool[];
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
