import type { LinkedQueue } from "../linkedQueue";
import type { CopyableReaction } from "../reactionQueue";

/**
 * 反应同步队列（src/reactionQueue.ts）的内存状态。
 *
 * pendingTasks 里始终是某条消息「最新」想要的反应状态（键为 chatId:messageId），
 * chatQueues 里各 chat 的队列只记录本群内各消息首次入队的先后顺序，
 * consumingChats 标记哪些 chat 的消费循环正在运行。
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

export const pendingTasks: Map<string, ReactionTask> = new Map();
export const chatQueues: Map<number, LinkedQueue<string>> = new Map();
export const consumingChats: Set<number> = new Set();
