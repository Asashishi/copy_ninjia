/** AI 群聊逐字缓存与持久化记忆 schema。 */

import type { AiSpeakerSnapshot } from "./speaker";

/**
 * 一条 Telegram 回复所指向的原消息快照。
 *
 * 可选字段一律写成 `T | undefined` 而非 `?:`，理由与 AiSpeakerSnapshot 相同：
 * 形状恒定才能让转录渲染的属性读取保持单态。
 */
export interface BufferedReplyReference extends AiSpeakerSnapshot {
  messageId: number;
  /** 原消息正文；媒体消息使用可读的类型占位和 caption。 */
  text: string;
  /** 用户在 Telegram 中只选中一段原文引用时的精确片段；没有时为 undefined。 */
  quote: string | undefined;
  /** 原消息是转发时的来源标注（预格式化身份文本）；非转发为 undefined。 */
  forwardedFrom: string | undefined;
}

/**
 * 逐字缓存里的一条消息。字段顺序即构造顺序，可选字段同样是 `T | undefined`
 * ——这一族对象在缓存里长期存活，每次拼提示词都要被 formatBufferedMessageLine
 * 读满一整轮（上限 150 条），形状发散的代价按每次回复计。
 */
export interface BufferedMessage extends AiSpeakerSnapshot {
  /** Telegram message_id；当前格式中的每条热区消息都必须可索引。 */
  messageId: number;
  text: string;
  /** 当前消息显式回复的原消息；非回复消息为 undefined。 */
  replyTo: BufferedReplyReference | undefined;
  /** 当前消息本身是转发时的来源标注（预格式化身份文本）；非转发为 undefined。 */
  forwardedFrom: string | undefined;
  /** 已格式化的东京时间。 */
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
