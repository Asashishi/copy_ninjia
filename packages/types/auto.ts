import type { Message } from "@grammyjs/types";
import type { TimestampDeque } from "../libs/timestampDeque";
import type {
  AiBotInfo,
  AiDirectTriggerReason,
  AiReplyReference,
} from "./aiChat/protocol";

/** 单群随机 AI 触发概率所需的最近活跃窗口。 */
export interface AiReplyActivityEntry {
  /** 只保留足以把随机搭话概率计算到热群下限的最新消息时间戳。 */
  timestamps: TimestampDeque;
  /** 主线程内严格递增的访问序号；仅在满载插入新群时用于选择 LRU。 */
  lastAccessSequence: number;
  lastObservedAt: number;
}

/** 一条消息对 AI 的显式唤起事实。 */
export interface DirectTrigger {
  reason: AiDirectTriggerReason;
}

/** 文本与媒体处理器共用的一次消息触发快照。 */
export interface MessageTriggerContext {
  message: Message;
  chatId: number;
  bot: AiBotInfo;
  isQuiet: boolean;
  aiReplyProbability: number;
  repliedTo?: Message;
  replyReference?: AiReplyReference;
  /** 当前消息本身是转发时的来源标注；非转发省略。 */
  forwardedFrom?: string;
  isMentioned: boolean;
  hasOtherMention: boolean;
  repliesToSelf: boolean;
  directTrigger?: DirectTrigger;
}

/** 提及相关的两个触发事实，由消息实体的一次遍历得到。 */
export interface MentionFacts {
  /** 消息里 @ 到了机器人自己；只按 Telegram entity 精确识别，不做子串匹配。 */
  isMentioned: boolean;
  /**
   * 消息提及了机器人以外的用户：显式 `@username` 和 Telegram 的隐藏用户名
   * 提及 `text_mention` 都算，会阻止随机 AI 插话；同时提及机器人时仍由
   * 调用方的直接触发分支优先处理。
   */
  hasOtherMention: boolean;
}
