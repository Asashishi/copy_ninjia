import type { ReactionTypeCustomEmoji, ReactionTypeEmoji } from "@grammyjs/types";

/**
 * 机器人能跟着复制的反应类型。付费（paid）反应 Bot API 不允许机器人设置，
 * 在入队前就应被过滤掉。自定义 emoji 反应可以复制：Bot API 允许机器人使用
 * 「已存在于该消息上」的自定义表情，而我们复制的正是目标刚点在同一条消息
 * 上的反应，天然满足这个条件。
 */
export type CopyableReaction = ReactionTypeEmoji | ReactionTypeCustomEmoji;

/**
 * 反应同步队列（src/cache/reactionQueue.ts）里的一条任务：某条消息「最新」
 * 想要的反应状态。
 */
export interface ReactionTask {
  chatId: number;
  messageId: number;
  reactions: CopyableReaction[];
  /** 产生本任务的更新的 update_id，用于覆盖旧任务前判断新旧。 */
  updateId: number;
  /** 目标点下反应的时刻（message_reaction 更新的 date 字段，Unix 秒）。 */
  reactedAtUnix: number;
  /** 本任务入队的时刻（毫秒时间戳），用于统计队列内耗时。 */
  enqueuedAtMs: number;
}
