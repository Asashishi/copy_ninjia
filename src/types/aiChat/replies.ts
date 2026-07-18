import type { Tool } from "@google/genai";
import type { ToolDefinition } from "../tools";
import type { StickerPackCandidate, StickerRoundState, StickerSendLockControl } from "../stickers/tools";
import type { ChatActionControl } from "./chatAction";

/** 同群并发位占满时排队补跑的直接触发快照。 */
export interface QueuedReplyTrigger {
  replyToMessageId: number;
  repliedBotText?: string;
  senderName: string;
  text: string;
}

/** 一轮 AI 回复行动工具所需的外部上下文。 */
export interface ReplyToolContext {
  chatId: number;
  replyToMessageId: number;
  chatAction: ChatActionControl;
  stickerLock: StickerSendLockControl;
  roundHasTypo: boolean;
  isActive: () => boolean;
  onMessageSent: (text: string, messageId: number) => void;
  onStickerSent: (stickerDescription: string, messageId: number) => void;
}

/** 一轮 AI 回复的函数工具集与执行状态。 */
export interface ReplyToolset {
  definitions: ToolDefinition[];
  tools: Tool[];
  has(name: string): boolean;
  execute(name: string, argumentsJson: string): Promise<string>;
  messagesSent(): number;
  actionsUsed(): number;
  isActive(): boolean;
}

/** 让 replies.ts 对贴纸候选类型形成明确的领域依赖并可直接重导出。 */
export type { StickerPackCandidate, StickerRoundState };
