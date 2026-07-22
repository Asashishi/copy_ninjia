/** AI 群聊逐字缓存与持久化记忆 schema。 */

import type { AiSpeakerSnapshot } from "./speaker";

/** 一条 Telegram 回复所指向的原消息快照。可选字段保证旧记忆快照兼容。 */
export interface BufferedReplyReference extends AiSpeakerSnapshot {
  messageId: number;
  /** 原消息正文；媒体消息使用可读的类型占位和 caption。 */
  text: string;
  /** 用户在 Telegram 中只选中一段原文引用时的精确片段。 */
  quote?: string;
  /** 原消息是转发时的来源标注（预格式化身份文本）；非转发和旧快照省略。 */
  forwardedFrom?: string;
}

export interface BufferedMessage extends AiSpeakerSnapshot {
  /** Telegram message_id；旧快照没有时省略。 */
  messageId?: number;
  text: string;
  /** 当前消息显式回复的原消息；旧快照和非回复消息省略。 */
  replyTo?: BufferedReplyReference;
  /** 当前消息本身是转发时的来源标注（预格式化身份文本）；非转发和旧快照省略。 */
  forwardedFrom?: string;
  /** 已格式化的东京时间；旧快照未知时为空串。 */
  at: string;
}

/** memory/ai/<chatId>.json 的版本化落盘结构。 */
export interface AiMemorySnapshot {
  version: 1;
  buffer: BufferedMessage[];
  summaries: string[];
  pendingSummary: string | null;
  savedAt: number;
}
